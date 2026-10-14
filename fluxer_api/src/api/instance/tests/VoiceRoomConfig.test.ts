// SPDX-License-Identifier: AGPL-3.0-or-later

import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const VOICE_ROOM_CONFIG_KEY = 'voice_room_config';
const OFF = {rooms_enabled: false, games_enabled: false, room_cameras_enabled: false, default_room_theme: null};

describe('voice room config', () => {
	const pods: Array<InstanceConfigRepository> = [];

	beforeEach(() => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	afterEach(() => {
		for (const pod of pods) pod.shutdown();
		pods.length = 0;
	});

	function createPod(): InstanceConfigRepository {
		const pod = new InstanceConfigRepository(new MockKVProvider());
		pods.push(pod);
		return pod;
	}

	it('defaults rooms and games off', async () => {
		expect(await createPod().getVoiceRoomConfig()).toEqual(OFF);
	});

	it('salvages a broken stored value', async () => {
		const pod = createPod();
		await pod.setConfig(VOICE_ROOM_CONFIG_KEY, JSON.stringify({rooms_enabled: 'yes', games_enabled: true}));
		expect(await pod.getVoiceRoomConfig()).toEqual(OFF);

		await pod.setConfig(VOICE_ROOM_CONFIG_KEY, '{not json');
		expect(await pod.getVoiceRoomConfig()).toEqual(OFF);
	});

	it('persists the default theme in the existing instance config and clears it with null', async () => {
		const pod = createPod();
		const updated = await pod.updateVoiceRoomConfig((current) => ({
			...current,
			default_room_theme: VOICE_ROOM_THEME_IDS[0],
		}));
		expect(updated).toMatchObject({default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		expect(await createPod().getVoiceRoomConfig()).toMatchObject({default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		const cleared = await pod.updateVoiceRoomConfig((current) => ({...current, default_room_theme: null}));
		expect(cleared).toMatchObject({default_room_theme: null});
	});

	it('update persists and refreshes the cache', async () => {
		const pod = createPod();
		expect(await pod.getVoiceRoomConfig()).toEqual(OFF);

		const updated = await pod.updateVoiceRoomConfig((current) => ({...current, rooms_enabled: true}));

		expect(updated).toEqual({...OFF, rooms_enabled: true});
		expect(await pod.getVoiceRoomConfig()).toEqual(updated);
		expect(await createPod().getVoiceRoomConfig()).toEqual(updated);
		expect(JSON.parse((await pod.getConfig(VOICE_ROOM_CONFIG_KEY))!)).toEqual(updated);
	});

	it('room_cameras_enabled persists and defaults off', async () => {
		const pod = createPod();
		// A value stored before the field existed reads it as off.
		await pod.setConfig(VOICE_ROOM_CONFIG_KEY, JSON.stringify({rooms_enabled: true, games_enabled: true}));
		expect((await pod.getVoiceRoomConfig()).room_cameras_enabled).toBe(false);

		const updated = await pod.updateVoiceRoomConfig((current) => ({
			...current,
			room_cameras_enabled: true,
			default_room_theme: null,
		}));

		expect(updated).toEqual({
			rooms_enabled: true,
			games_enabled: true,
			room_cameras_enabled: true,
			default_room_theme: null,
		});
		expect(await createPod().getVoiceRoomConfig()).toEqual(updated);
		expect(JSON.parse((await pod.getConfig(VOICE_ROOM_CONFIG_KEY))!)).toEqual(updated);
	});
});
