// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {createPost} from '@app/api/feed/tests/FeedTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import type {FeedCommentResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {ReportResponse} from '@fluxer/schema/src/domains/report/ReportSchemas';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

describe('admin report list filters for feed reports', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness({search: 'enabled'});
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('filters the admin report list by feed_post and feed_comment', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'süzgeç'}).execute();
		const reply = await createBuilder<FeedCommentResponse>(harness, alice.token)
			.post(`/feed/posts/${post.id}/comments`)
			.body({content: 'yorum'})
			.execute();
		const postReport = await createBuilder<ReportResponse>(harness, bob.token)
			.post('/reports/feed-post')
			.body({post_id: post.id, category: 'spam'})
			.execute();
		const commentReport = await createBuilder<ReportResponse>(harness, bob.token)
			.post('/reports/feed-comment')
			.body({post_id: post.id, comment_id: reply.id, category: 'spam'})
			.execute();
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.REPORT_VIEW,
		]);
		const list = async (reportType: string) =>
			(
				await createBuilder<{reports: Array<{report_id: string; report_type: number}>}>(harness, admin.token)
					.get(`/admin/reports?report_type=${reportType}&limit=200`)
					.expect(HTTP_STATUS.OK)
					.execute()
			).reports;

		const posts = await list('feed_post');
		const comments = await list('feed_comment');

		expect(posts.map((entry) => [entry.report_id, entry.report_type])).toContainEqual([postReport.report_id, 3]);
		expect(posts.every((entry) => entry.report_type === 3)).toBe(true);
		expect(comments.map((entry) => [entry.report_id, entry.report_type])).toContainEqual([commentReport.report_id, 4]);
		expect(comments.every((entry) => entry.report_type === 4)).toBe(true);
	});
});
