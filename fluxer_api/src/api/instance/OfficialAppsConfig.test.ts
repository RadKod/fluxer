// SPDX-License-Identifier: AGPL-3.0-or-later

import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {ALL_PERMISSIONS, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {InstanceConfigUpdateRequest} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

const app = {application_id: '123456789012345678', invite_permissions: Permissions.VIEW_CHANNEL.toString()};
const parse = (official_apps: unknown) => InstanceConfigUpdateRequest.safeParse({policy: {official_apps}});

describe('official app policy validation', () => {
	it('exports the permission decimal pattern and security bounds to OpenAPI input schemas', () => {
		const schema = z.toJSONSchema(InstanceConfigUpdateRequest, {io: 'input', target: 'openapi-3.0'});
		const officialApps = (schema.properties!.policy as z.core.JSONSchema.JSONSchema).properties!
			.official_apps as z.core.JSONSchema.JSONSchema;
		expect(officialApps.description).toContain('unique application IDs');
		const fields = (officialApps.items as z.core.JSONSchema.JSONSchema).properties as Record<
			string,
			z.core.JSONSchema.JSONSchema
		>;
		expect(fields.invite_permissions.pattern).toBe('^[0-9]+$');
		expect(fields.invite_permissions.description).toContain('18446744073709551615');
		expect(fields.invite_permissions.description).toContain('ADMINISTRATOR');
		expect(fields.application_id.description).toContain('9223372036854775807');
	});
	it('preserves decimal strings and accepts twenty distinct apps', () => {
		const official_apps = Array.from({length: 20}, (_, i) => ({...app, application_id: String(i + 1)}));
		expect(parse(official_apps)).toMatchObject({success: true, data: {policy: {official_apps}}});
	});
	it('accepts zero and all known non-administrator permissions', () => {
		for (const invite_permissions of ['0', (ALL_PERMISSIONS & ~Permissions.ADMINISTRATOR).toString()]) {
			expect(parse([{...app, invite_permissions}])).toMatchObject({
				success: true,
				data: {policy: {official_apps: [{...app, invite_permissions}]}},
			});
		}
	});
	it('accepts the maximum signed 64-bit snowflake as a string', () => {
		const entry = {...app, application_id: '9223372036854775807'};
		expect(parse([entry])).toMatchObject({success: true, data: {policy: {official_apps: [entry]}}});
	});
	it.each([
		{...app, application_id: 123},
		{...app, invite_permissions: 1024},
	])('requires string fields for %j', (entry) => {
		expect(parse([entry]).success).toBe(false);
	});
	it.each(['bad', '-1', '1.5', '01', ' 1', '9223372036854775808'])('rejects invalid snowflake %s', (application_id) => {
		expect(parse([{...app, application_id}]).success).toBe(false);
	});
	it.each([
		'bad',
		'-1',
		'1.5',
		'1e3',
		'+1',
		' 1',
		'18446744073709551616',
		(1n << 63n).toString(),
		Permissions.ADMINISTRATOR.toString(),
	])('rejects invalid or unsafe permissions %s without throwing', (invite_permissions) => {
		expect(parse([{...app, invite_permissions}]).success).toBe(false);
	});
	it('rejects duplicate applications', () => {
		expect(parse([app, {...app, invite_permissions: '0'}]).success).toBe(false);
	});
	it('rejects twenty-one apps', () => {
		expect(parse(Array.from({length: 21}, (_, i) => ({...app, application_id: String(i + 1)}))).success).toBe(false);
	});
});

describe('official app policy persistence', () => {
	const repositories: Array<InstanceConfigRepository> = [];
	afterEach(() => {
		for (const repository of repositories) repository.shutdown();
		repositories.length = 0;
	});
	function repository() {
		const result = new InstanceConfigRepository(new MockKVProvider());
		repositories.push(result);
		return result;
	}
	it('defaults to empty and persists, preserves omitted values, and clears explicit empty arrays', async () => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		const first = repository();
		expect(await first.getInstancePolicyConfig()).toMatchObject({official_apps: []});
		const patch = {official_apps: [app]};
		await first.setInstancePolicyConfig(patch);
		expect(await repository().readStoredInstancePolicyConfig()).toMatchObject(patch);
		await first.setInstancePolicyConfig({premium_trial_days: 7});
		expect(await first.readStoredInstancePolicyConfig()).toMatchObject(patch);
		await first.setInstancePolicyConfig({official_apps: []});
		expect(await repository().readStoredInstancePolicyConfig()).toMatchObject({
			official_apps: [],
			premium_trial_days: 7,
		});
	});
	it.each(
		[
			'bad',
			[{...app, invite_permissions: 'bad'}],
			[{...app, invite_permissions: Permissions.ADMINISTRATOR.toString()}],
			[{...app, invite_permissions: (1n << 63n).toString()}],
			[{...app, application_id: '9223372036854775808'}],
			[app, app],
			Array.from({length: 21}, (_, i) => ({...app, application_id: String(i + 1)})),
		].map((official_apps) => ({official_apps})),
	)('discards malformed stored official apps while preserving valid policy fields: %j', async ({official_apps}) => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		const current = repository();
		await current.setConfig('instance_policy_config', JSON.stringify({official_apps, premium_trial_days: 7}));
		expect(await current.getInstancePolicyConfig()).toMatchObject({official_apps: [], premium_trial_days: 7});
	});
});
