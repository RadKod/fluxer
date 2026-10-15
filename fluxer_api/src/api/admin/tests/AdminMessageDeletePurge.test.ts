// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import type {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import {AdminMessageService} from '@app/api/admin/services/AdminMessageService';
import {createAttachmentID, createChannelID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {setInjectedKVProvider} from '@app/api/middleware/ServiceRegistry';
import {resetServiceSingletonsForTesting, setInjectedStorageService} from '@app/api/middleware/ServiceSingletons';
import {Message} from '@app/api/models/Message';
import {MockStorageService} from '@app/api/test/mocks/MockStorageService';
import {MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

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
				filename: 'removed.png',
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

describe('AdminMessageService.deleteMessage', () => {
	let previousAdapter: typeof Config.cachePurge.adapter;
	let previousMedia: string;
	let kvClient: MockKVProvider;

	beforeEach(() => {
		previousAdapter = Config.cachePurge.adapter;
		previousMedia = Config.endpoints.media;
		Config.cachePurge.adapter = 'http';
		Config.endpoints.media = 'https://media.test';
		kvClient = new MockKVProvider();
		setInjectedKVProvider(kvClient);
		setInjectedStorageService(new MockStorageService());
		resetServiceSingletonsForTesting();
	});

	afterEach(() => {
		Config.cachePurge.adapter = previousAdapter;
		Config.endpoints.media = previousMedia;
		setInjectedKVProvider(new MockKVProvider());
		setInjectedStorageService(undefined);
		resetServiceSingletonsForTesting();
	});

	it('queues the CDN purge of a message an admin removes, a report outcome included, as urgent', async () => {
		const message = messageWithAttachment();
		const service = new AdminMessageService({
			apiContext: {services: {gateway: {}}} as unknown as ApiContext,
			channelRepository: {
				channelData: {findUnique: async () => null},
				messages: {getMessage: async () => message, deleteMessage: async () => {}},
			} as unknown as ChannelRepository,
			guildRepository: {} as GuildRepository,
			auditService: {createAuditLog: async () => {}} as unknown as AdminAuditService,
		});

		await service.deleteMessage(
			10n as never,
			100n as never,
			{basis: {type: 'housekeeping'}} as never,
			createUserID(1n),
			null,
		);

		expect(await kvClient.smembers('cache_purge:{q}:priority')).toEqual(['media.test/attachments/10/200/removed']);
		expect(await kvClient.smembers('cache_purge:{q}:queue')).toEqual([]);
	});
});
