// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannel, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {addGuildFeature} from '@app/api/channel/tests/CrosspostTestUtils';
import {getInstanceConfigRepository, getVoiceActivityService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ACTIVITY_METADATA_KEY} from '@fluxer/constants/src/VoiceActivityConstants';
import type {VoiceActivitySession} from '@fluxer/schema/src/domains/voice_activity/VoiceActivitySchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const conn = (account: TestAccount) => `c${account.userId}`;

describe('VoiceActivityController', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		await getInstanceConfigRepository().updateVoiceRoomConfig(() => ({
			rooms_enabled: true,
			games_enabled: true,
			room_cameras_enabled: false,
			default_room_theme: null,
		}));
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	// Voice membership is the seat service's j: mark; here a caller is in voice under the connection c<user id>.
	function voiceMembers(...inVoice: Array<TestAccount>) {
		const {voiceSeatService, liveKitService} = getVoiceActivityService().deps;
		const ids = new Set(inVoice.map(conn));
		vi.spyOn(voiceSeatService, 'membership').mockImplementation(async ({connectionId}) =>
			ids.has(connectionId) ? {regionId: 'eu', serverId: 'lk-1'} : null,
		);
		return vi.spyOn(liveKitService, 'updateRoomMetadata').mockResolvedValue('ok');
	}

	async function voiceChannel() {
		const setup = await setupTestGuildWithMembers(harness, 1);
		await addGuildFeature(setup.guild.id, 'VOICE_ACTIVITIES');
		const voice = await createChannel(harness, setup.owner.token, setup.guild.id, 'voice', ChannelTypes.GUILD_VOICE);
		return {...setup, member: setup.members[0]!, channelId: voice.id};
	}

	const activityPath = (channelId: string) => `/channels/${channelId}/activity`;

	it('start, read, conflict, end by another member, read null', async () => {
		const {owner, member, channelId} = await voiceChannel();
		const metadata = voiceMembers(owner, member);
		const session = await createBuilder<VoiceActivitySession>(harness, owner.token)
			.post(activityPath(channelId))
			.body({activity_id: 'band', connection_id: conn(owner)})
			.expect(201)
			.execute();
		expect(session).toMatchObject({activity_id: 'band', started_by: owner.userId});
		expect(metadata).toHaveBeenCalledWith(expect.objectContaining({entries: {[VOICE_ACTIVITY_METADATA_KEY]: session}}));
		const read = await createBuilder<VoiceActivitySession | null>(harness, member.token)
			.get(`${activityPath(channelId)}?connection_id=${conn(member)}`)
			.expect(200)
			.execute();
		expect(read).toEqual(session);
		await createBuilder(harness, member.token)
			.post(activityPath(channelId))
			.body({activity_id: 'band', connection_id: conn(member)})
			.expect(409, 'VOICE_ACTIVITY_CONFLICT')
			.execute();
		await createBuilder(harness, member.token)
			.delete(`${activityPath(channelId)}?connection_id=${conn(member)}`)
			.expect(204)
			.execute();
		expect(metadata).toHaveBeenLastCalledWith(
			expect.objectContaining({entries: {[VOICE_ACTIVITY_METADATA_KEY]: null}}),
		);
		const after = await createBuilder<VoiceActivitySession | null>(harness, owner.token)
			.get(`${activityPath(channelId)}?connection_id=${conn(owner)}`)
			.expect(200)
			.execute();
		expect(after).toBeNull();
	});

	it('unknown activity ids fail validation and callers outside voice get USER_NOT_IN_VOICE', async () => {
		const {owner, member, channelId} = await voiceChannel();
		voiceMembers(owner);
		await createBuilder(harness, owner.token)
			.post(activityPath(channelId))
			.body({activity_id: 'poker', connection_id: conn(owner)})
			.expect(400)
			.execute();
		await createBuilder(harness, member.token)
			.post(activityPath(channelId))
			.body({activity_id: 'band', connection_id: conn(member)})
			.expect(400, 'USER_NOT_IN_VOICE')
			.execute();
	});
});
