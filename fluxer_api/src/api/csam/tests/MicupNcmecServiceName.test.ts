// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {createChannel, createGuild} from '@app/api/channel/tests/AttachmentTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {fakeNcmecServer} from '@app/api/test/Setup';
import {createMessageWithImageAttachment} from '@app/api/user/tests/FavoriteMemeTestUtils';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {afterEach, describe, expect, test} from 'vitest';

// NCMEC reports name Micup as the electronic service provider.
describe('NCMEC report service name', () => {
	let harness: ApiTestHarness | undefined;

	afterEach(async () => {
		await harness?.shutdown();
		harness = undefined;
	});

	test('names sanalyer, never Fluxer, in the submitted report', async () => {
		harness = await createApiTestHarness();
		const admin = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.WILDCARD]);
		const author = await createTestAccount(harness);
		const guild = await createGuild(harness, author.token, 'NCMEC Brand Guild');
		const channel = await createChannel(harness, author.token, guild.id, 'ncmec-brand');
		const message = await createMessageWithImageAttachment(harness, author.token, channel.id);
		const attachment = message.attachments[0];

		const response = await harness.requestJson({
			path: '/admin/messages/ncmec-reports',
			method: 'POST',
			body: {
				channel_id: channel.id,
				message_id: message.id,
				attachment_id: attachment.id,
				filename: attachment.filename,
				reporter_full_name: 'Brand Reporter',
				confirmed_viewed: true,
			},
			headers: {Authorization: admin.token, 'X-Audit-Log-Reason': 'sanalyer NCMEC brand check'},
		});
		expect(response.status).toBe(200);

		const [report] = fakeNcmecServer.getReports();
		expect(report?.reportXml).toContain('<platform>sanalyer</platform>');
		expect(report?.reportXml).toContain('<espService>sanalyer</espService>');
		expect(report?.reportXml).toContain('sanalyer admin attachment report.');
		expect(report?.reportXml).toContain('handled directly by sanalyer API');
		expect(report?.reportXml).not.toMatch(/Fluxer/);
	});
});
