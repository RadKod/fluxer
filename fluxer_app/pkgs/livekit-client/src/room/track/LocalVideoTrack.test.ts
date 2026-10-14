// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import LocalVideoTrack from './LocalVideoTrack.ts';
import {Track} from './Track.ts';

class FakeMediaStreamTrack {
	readonly kind = 'video';
	enabled = true;
	muted = false;
	readyState: MediaStreamTrackState = 'live';

	getConstraints(): MediaTrackConstraints {
		return {};
	}

	getSettings(): MediaTrackSettings {
		return {};
	}

	async applyConstraints(): Promise<void> {}

	addEventListener(): void {}

	removeEventListener(): void {}

	clone(): FakeMediaStreamTrack {
		const clone = new FakeMediaStreamTrack();
		clone.readyState = this.readyState;
		return clone;
	}

	stop(): void {
		this.readyState = 'ended';
	}
}

describe('LocalVideoTrack camera re-acquisition', () => {
	let getUserMedia: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubGlobal(
			'MediaStream',
			class {
				constructor(readonly tracks: Array<MediaStreamTrack>) {}
			},
		);
		getUserMedia = vi.fn(async () => ({getTracks: () => [new FakeMediaStreamTrack()]}));
		vi.stubGlobal('navigator', {mediaDevices: {getUserMedia}});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function createCameraTrack() {
		const raw = new FakeMediaStreamTrack();
		const track = new LocalVideoTrack(raw as unknown as MediaStreamTrack, undefined, false);
		await track.runWithTrackChangeLock(async () => {});
		track.source = Track.Source.Camera;
		return {raw, track};
	}

	it('does not open a new capture when a stopped camera track is unmuted', async () => {
		const {track} = await createCameraTrack();
		await track.mute();
		track.stop();
		await track.unmute();
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it('does not open a new capture when a stopped camera track is restarted', async () => {
		const {track} = await createCameraTrack();
		track.stop();
		await track.restartTrack();
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it('does not hand a simulcast sender an ended clone when a stopped camera track is restarted', async () => {
		const {track} = await createCameraTrack();
		const replaceTrack = vi.fn(async () => {});
		track.simulcastCodecs.set('vp9', {
			codec: 'vp9',
			mediaStreamTrack: new FakeMediaStreamTrack() as unknown as MediaStreamTrack,
			sender: {transport: {state: 'connected'}, replaceTrack} as unknown as RTCRtpSender,
			encodings: undefined,
		});
		track.stop();
		await track.restartTrack();
		expect(replaceTrack).not.toHaveBeenCalled();
	});

	it('re-acquires the camera on unmute after mute released it', async () => {
		const {raw, track} = await createCameraTrack();
		await track.mute();
		expect(raw.readyState).toBe('ended');
		await track.unmute();
		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(track.mediaStreamTrack.readyState).toBe('live');
		expect(track.isMuted).toBe(false);
	});
});
