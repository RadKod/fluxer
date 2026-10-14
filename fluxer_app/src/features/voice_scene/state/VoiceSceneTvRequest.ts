// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import {getFullscreenElement} from '@app/features/platform/utils/FullscreenMediaUtils';
import {VoiceTrackSource} from '@app/features/voice/engine/VoiceTrackSource';
import VoiceCallLayout from '@app/features/voice/state/VoiceCallLayout';
import type {TvSource} from '@app/features/voice_scene/video/TvSource';
import {makeAutoObservable} from 'mobx';
import {useEffect, useRef} from 'react';

// What this viewer chose for the room's TV: only this client, only this session.
class VoiceSceneTvRequestState {
	private selections: Readonly<Record<string, TvSource>> = {};
	private cameraWatch: {channelId: string; identity: string} | null = null;
	fullscreen: TvSource | null = null;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		ResettableStates.register(this, this.reset);
	}

	reset(): void {
		this.selections = {};
		this.cameraWatch = null;
		this.fullscreen = null;
	}

	selected(channelId: string): TvSource | null {
		return this.selections[channelId] ?? null;
	}

	select(channelId: string, source: TvSource): void {
		this.selections = {...this.selections, [channelId]: source};
		const watch = this.cameraWatch;
		if (watch?.channelId === channelId && (source.kind !== 'camera' || source.identity !== watch.identity)) {
			this.cameraWatch = null;
		}
	}

	// A camera plays on the TV only after Watch: it is the one high-quality subscription.
	watchCamera(channelId: string, identity: string): void {
		this.cameraWatch = {channelId, identity};
	}

	stopCamera(): void {
		this.cameraWatch = null;
	}

	watchedCamera(channelId: string): string | null {
		return this.cameraWatch?.channelId === channelId ? this.cameraWatch.identity : null;
	}

	requestFullscreen(source: TvSource): void {
		this.fullscreen = source;
	}

	clearFullscreen(): void {
		this.fullscreen = null;
	}
}

const VoiceSceneTvRequest = new VoiceSceneTvRequestState();
export default VoiceSceneTvRequest;

// The TV's Full screen in VoiceCallView: the flat view with the source pinned, in the call's own app fullscreen; leaving
// fullscreen (or fullscreen being unavailable) returns to the room and the viewer's earlier call layout. Call from an
// observer; `active` is false in a call popout.
export function useVoiceSceneTvFullscreen({
	active,
	isFullscreen,
	enterFullscreen,
}: {
	active: boolean;
	isFullscreen: boolean;
	enterFullscreen: () => Promise<void>;
}): boolean {
	const request = active ? VoiceSceneTvRequest.fullscreen : null;
	useEffect(() => {
		if (!request) return;
		const {pinnedParticipantIdentity, pinnedParticipantSource, layoutMode} = VoiceCallLayout;
		VoiceCallLayout.setPinnedParticipant(
			request.identity,
			request.kind === 'screen' ? VoiceTrackSource.ScreenShare : VoiceTrackSource.Camera,
		);
		void enterFullscreen().then(() => {
			if (!getFullscreenElement()) VoiceSceneTvRequest.clearFullscreen();
		});
		return () => {
			VoiceCallLayout.setPinnedParticipant(pinnedParticipantIdentity, pinnedParticipantSource);
			VoiceCallLayout.setLayoutMode(layoutMode);
		};
	}, [request, enterFullscreen]);
	const sawFullscreen = useRef(false);
	useEffect(() => {
		if (!request) {
			sawFullscreen.current = false;
			return;
		}
		if (isFullscreen) sawFullscreen.current = true;
		else if (sawFullscreen.current) VoiceSceneTvRequest.clearFullscreen();
	}, [request, isFullscreen]);
	return request !== null;
}
