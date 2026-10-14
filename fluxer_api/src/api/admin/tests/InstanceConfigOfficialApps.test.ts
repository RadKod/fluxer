// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {getAdminRepository, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {
	createOAuth2Application,
	createUniqueApplicationName,
	deleteOAuth2Application,
} from '@app/api/oauth/tests/OAuth2TestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {InstanceConfigResponse} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import type {ApplicationPublicResponse} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('official app instance config admin API', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	const createAdmin = async () =>
		setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
	const patch = (admin: TestAccount, policy: Record<string, unknown>) =>
		createBuilder<InstanceConfigResponse>(harness, admin.token).patch('/admin/instance/config').body({policy});
	const app = {application_id: '123456789012345678', invite_permissions: Permissions.VIEW_CHANNEL.toString()};
	it.each([false, true])('requires admin ACL during setup before any mixed patch writes: %s', async (mixed) => {
		const user = await createTestAccount(harness);
		const repository = getInstanceConfigRepository();
		await repository.setAppPublicConfig({setup: {configured: false}});
		const before = await repository.getAllConfigs();
		await createBuilder(harness, user.token)
			.patch('/admin/instance/config')
			.body({policy: {official_apps: [app]}, ...(mixed ? {app_public: {setup: {configured: true}}} : {})})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		expect(await repository.getAllConfigs()).toEqual(before);
		expect(
			(await getAdminRepository().listAllAuditLogsPaginated(100)).filter(
				(log) => log.action === 'update_instance_config',
			),
		).toEqual([]);
	});
	it('allows an authorized admin to change official apps before setup completes', async () => {
		const admin = await createAdmin();
		await getInstanceConfigRepository().setAppPublicConfig({setup: {configured: false}});
		expect((await patch(admin, {official_apps: [app]}).execute()).policy).toMatchObject({official_apps: [app]});
	});

	it('reads default empty policy, persists and reads updates, preserves omissions and clears with an audit reason', async () => {
		const admin = await createAdmin();
		const read = () =>
			createBuilder<InstanceConfigResponse>(harness, admin.token).get('/admin/instance/config').execute();
		expect((await read()).policy).toMatchObject({official_apps: []});
		expect(
			(
				await patch(admin, {official_apps: [app]})
					.header('X-Audit-Log-Reason', 'official app review')
					.execute()
			).policy,
		).toMatchObject({official_apps: [app]});
		expect((await read()).policy).toMatchObject({official_apps: [app]});
		expect(await getInstanceConfigRepository().readStoredInstancePolicyConfig()).toMatchObject({official_apps: [app]});
		expect((await patch(admin, {premium_trial_days: 7}).execute()).policy).toMatchObject({official_apps: [app]});
		const logs = await getAdminRepository().listAllAuditLogsPaginated(100);
		const audit = logs.find(
			(log) => log.action === 'update_instance_config' && log.auditLogReason === 'official app review',
		);
		expect(audit).toMatchObject({targetType: 'instance_config', targetId: 0n});
		expect(audit?.metadata.get('sections')).toBe('policy');
		expect((await patch(admin, {official_apps: []}).execute()).policy).toMatchObject({official_apps: []});
	});

	it('requires instance-config update ACL and leaves policy unchanged on forbidden writes', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
		]);
		await patch(admin, {official_apps: [app]})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		expect(await getInstanceConfigRepository().readStoredInstancePolicyConfig()).toMatchObject({official_apps: []});
		expect(
			(await getAdminRepository().listAllAuditLogsPaginated(100)).filter(
				(log) => log.action === 'update_instance_config',
			),
		).toEqual([]);
	});

	it.each([
		{...app, invite_permissions: Permissions.ADMINISTRATOR.toString()},
		{...app, invite_permissions: 'bad'},
		{...app, invite_permissions: '18446744073709551616'},
		{...app, application_id: '9223372036854775808'},
	])('rejects invalid app %j as a validation error without changing policy or writing audits', async (entry) => {
		const admin = await createAdmin();
		await patch(admin, {official_apps: [entry]})
			.expect(HTTP_STATUS.BAD_REQUEST)
			.execute();
		expect(await getInstanceConfigRepository().readStoredInstancePolicyConfig()).toMatchObject({official_apps: []});
		expect(
			(await getAdminRepository().listAllAuditLogsPaginated(100)).filter(
				(log) => log.action === 'update_instance_config',
			),
		).toEqual([]);
	});

	it('discovers an admin-listed ordinary token bot and preserves the public endpoint private and deleted behavior', async () => {
		const admin = await createAdmin();
		const owner = await createTestAccount(harness);
		const bot = await createOAuth2Application(harness, owner.token, {
			name: createUniqueApplicationName(),
			bot_public: true,
		});
		expect(bot.botToken).toBeTruthy();
		const entry = {...app, application_id: bot.application.id};
		expect((await patch(admin, {official_apps: [entry]}).execute()).policy).toMatchObject({official_apps: [entry]});
		const discovery = await createBuilderWithoutAuth<{features: {official_apps: Array<typeof app>}}>(harness)
			.get('/.well-known/fluxer')
			.execute();
		expect(discovery.features.official_apps).toContainEqual(entry);
		const publicView = () =>
			createBuilderWithoutAuth<ApplicationPublicResponse>(harness).get(
				`/oauth2/applications/${entry.application_id}/public`,
			);
		expect(await publicView().execute()).toMatchObject({
			id: entry.application_id,
			bot_public: true,
			bot: {id: bot.botUserId},
		});
		await createBuilder(harness, owner.token)
			.patch(`/oauth2/applications/${entry.application_id}`)
			.body({bot_public: false})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(await publicView().execute()).toMatchObject({id: entry.application_id, bot_public: false});
		const discoverApps = async () =>
			(
				await createBuilderWithoutAuth<{features: {official_apps: Array<typeof app>}}>(harness)
					.get('/.well-known/fluxer')
					.execute()
			).features.official_apps;
		await vi.waitFor(async () => expect(await discoverApps()).not.toContainEqual(entry));
		await createBuilder(harness, owner.token)
			.patch(`/oauth2/applications/${entry.application_id}`)
			.body({bot_public: true})
			.expect(HTTP_STATUS.OK)
			.execute();
		await vi.waitFor(async () => expect(await discoverApps()).toContainEqual(entry));
		await deleteOAuth2Application(harness, owner.token, entry.application_id, owner.password);
		await publicView().expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_APPLICATION).execute();
		await vi.waitFor(async () => expect(await discoverApps()).not.toContainEqual(entry));
	}, 90000);
	it.each(
		[
			[app, {...app, invite_permissions: '0'}],
			Array.from({length: 21}, (_, i) => ({...app, application_id: String(i + 1)})),
		].map((official_apps) => ({official_apps})),
	)('rejects duplicate or oversized lists without changing policy or writing audits: %j', async ({official_apps}) => {
		const admin = await createAdmin();
		await patch(admin, {official_apps}).expect(HTTP_STATUS.BAD_REQUEST).execute();
		expect(await getInstanceConfigRepository().readStoredInstancePolicyConfig()).toMatchObject({official_apps: []});
		expect(
			(await getAdminRepository().listAllAuditLogsPaginated(100)).filter(
				(log) => log.action === 'update_instance_config',
			),
		).toEqual([]);
	});
});
