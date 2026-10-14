// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAttachmentID, createChannelID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {NcmecSubmissionService} from '@app/api/csam/NcmecSubmissionService';
import type {NcmecAttachmentSubmissionRow, NcmecUserWorkflowRow} from '@app/api/database/types/CsamTypes';
import {CachePurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {Message} from '@app/api/models/Message';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {MockStorageService} from '@app/api/test/mocks/MockStorageService';
import {MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

type NcmecSubmissionServiceDeps = ConstructorParameters<typeof NcmecSubmissionService>[0];

const NOW = new Date('2026-09-24T00:00:00.000Z');

function messageWithAttachment(): Message {
	return new Message({
		channel_id: createChannelID(10n),
		bucket: 0,
		message_id: createMessageID(100n),
		author_id: createUserID(3n),
		type: MessageTypes.DEFAULT,
		webhook_id: null,
		webhook_name: null,
		webhook_avatar_hash: null,
		content: '',
		edited_timestamp: null,
		pinned_timestamp: null,
		flags: 0,
		mention_everyone: false,
		mention_users: null,
		mention_roles: null,
		mention_channels: null,
		attachments: [
			{
				attachment_id: createAttachmentID(200n),
				filename: 'reported.png',
				size: 1024n,
				title: null,
				description: null,
				width: 16,
				height: 16,
				content_type: 'image/png',
				content_hash: null,
				placeholder: null,
				flags: 0,
				duration: null,
				nsfw: null,
				waveform: null,
			},
		],
		embeds: null,
		sticker_items: null,
		message_reference: null,
		message_snapshots: null,
		call: null,
		has_reaction: null,
		version: 1,
	});
}

const SUBMISSION: NcmecAttachmentSubmissionRow = {
	attachment_id: 200n,
	user_id: 3n,
	channel_id: 10n,
	message_id: 100n,
	filename: 'reported.png',
	source_report_id: null,
	status: 'submitted',
	ncmec_report_id: '1',
	ncmec_file_id: 'file-1',
	submitted_at: NOW,
	submitted_by_admin_id: 1n,
	reporter_full_name: 'Reporter',
	failure_reason: null,
	archive_completed_at: null,
	content_deleted_at: null,
	created_at: NOW,
	updated_at: NOW,
};

// Archived before any ban, so finalizing goes straight to removing the content.
const WORKFLOW: NcmecUserWorkflowRow = {
	user_id: 3n,
	deleted_at: null,
	deleted_by_admin_id: null,
	deletion_private_reason: null,
	deletion_ncmec_report_id: null,
	archive_id: 5n,
	archive_requested_at: NOW,
	archive_requested_by_admin_id: 1n,
	archive_audit_log_reason: null,
	archive_completed_at: NOW,
	deletion_job_queued_at: NOW,
	previous_report_ids: null,
	created_at: NOW,
	updated_at: NOW,
};

describe('NcmecSubmissionService.finalizeAttachmentReport', () => {
	let previousMedia: string;

	beforeEach(() => {
		previousMedia = Config.endpoints.media;
		Config.endpoints.media = 'https://media.test';
	});

	afterEach(() => {
		Config.endpoints.media = previousMedia;
	});

	it('queues the CDN purge of the reported attachment as urgent', async () => {
		const kvClient = new MockKVProvider();
		const message = messageWithAttachment();
		const service = new NcmecSubmissionService({
			ncmecRepository: {
				getAttachmentSubmission: async () => SUBMISSION,
				getUserWorkflow: async () => WORKFLOW,
				upsertAttachmentSubmission: async () => {},
				upsertUserWorkflow: async () => {},
			},
			adminArchiveService: {getArchive: async () => ({completed_at: NOW.toISOString()})},
			channelRepository: {
				findUnique: async () => null,
				getMessage: async () => message,
				deleteMessage: async () => {},
			},
			storageService: new MockStorageService(),
			purgeQueue: new CachePurgeQueue(kvClient),
			updatePropagator: {},
		} as unknown as NcmecSubmissionServiceDeps);

		await service.finalizeAttachmentReport(createAttachmentID(200n));

		expect(await kvClient.smembers('cache_purge:{q}:priority')).toEqual(['media.test/attachments/10/200/reported']);
		expect(await kvClient.smembers('cache_purge:{q}:queue')).toEqual([]);
	});
});
