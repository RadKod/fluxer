// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceParticipantAvatarEntry} from '@app/features/voice/components/VoiceParticipantAvatarList';
import {defaultTvSource, tvSources} from '@app/features/voice_scene/video/TvSource';
import {describe, expect, it} from 'vitest';

function entry(
	userId: string,
	connectionId: string,
	media: {camera?: boolean; screen?: boolean; local?: boolean} = {},
): VoiceParticipantAvatarEntry {
	return {
		user: {id: userId} as never,
		userId,
		connectionId,
		speaking: false,
		hasCamera: media.camera ?? false,
		hasScreenShare: media.screen ?? false,
		isLocal: media.local ?? false,
		selfMute: false,
		selfDeaf: false,
	};
}

describe('tvSources', () => {
	it('lists remote screen shares then remote cameras, never mine', () => {
		const entries = [
			entry('1', 'a', {camera: true}),
			entry('2', 'b', {screen: true, camera: true}),
			entry('9', 'me', {screen: true, camera: true, local: true}),
			// My second device is still me.
			entry('9', 'me-phone', {camera: true}),
			entry('3', 'c', {screen: true}),
			entry('4', 'd'),
		];
		expect(tvSources(entries, '9')).toEqual([
			{kind: 'screen', identity: 'user_2_b'},
			{kind: 'screen', identity: 'user_3_c'},
			{kind: 'camera', identity: 'user_1_a'},
			{kind: 'camera', identity: 'user_2_b'},
		]);
	});

	it("default is the first screen share (today's poster)", () => {
		const sources = tvSources([entry('1', 'a', {camera: true}), entry('2', 'b', {screen: true})], null);
		expect(defaultTvSource(sources)).toEqual({kind: 'screen', identity: 'user_2_b'});
	});

	it('cameras alone leave the TV dark until someone picks one', () => {
		expect(defaultTvSource(tvSources([entry('1', 'a', {camera: true})], null))).toBeNull();
		expect(defaultTvSource([])).toBeNull();
	});
});
