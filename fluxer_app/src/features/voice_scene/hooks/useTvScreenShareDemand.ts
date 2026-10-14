// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import {resolveDevicePixelRatio} from '@app/features/voice/DevicePixelRatio';
import {
	applyScreenShareViewerDemand,
	isWithinScreenShareViewerDemandDeadBand,
	measureScreenShareViewerDemand,
	releaseScreenShareViewerDemand,
	SCREEN_SHARE_VIEWER_DEMAND_DEBOUNCE_MS,
	type ScreenShareViewerDemandDimensions,
} from '@app/features/voice/utils/ScreenShareSubscriptionPolicy';
import type {VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {type RemoteTrackPublication, TrackEvent} from 'livekit-client';
import {type RefObject, useEffect, useId} from 'react';

const logger = new Logger('TvScreenShareDemand');

export function useTvScreenShareDemand({
	handle,
	publication,
	videoRef,
	enabled,
}: {
	handle: VoiceSceneHandle;
	publication: RemoteTrackPublication | null | undefined;
	videoRef: RefObject<HTMLVideoElement | null>;
	enabled: boolean;
}): void {
	const viewerKey = `tv-${useId()}`;
	const trackSid = publication?.trackSid;
	useEffect(() => {
		if (!enabled || !publication || publication.isLocal || !trackSid) return;
		const label = 'TV screen share video publication';
		const onError = (operation: string, errorLabel: string, error: unknown) => {
			logger.error(`${operation} failed for ${errorLabel}`, error);
		};
		let applied: ScreenShareViewerDemandDimensions | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const doc = videoRef.current?.ownerDocument ?? document;
		const release = () => {
			releaseScreenShareViewerDemand({publication, label, trackSid, viewerKey, onError});
			applied = null;
		};
		const apply = () => {
			timer = null;
			if (!publication.isSubscribed || publication.trackSid !== trackSid) return;
			const video = videoRef.current;
			if (!video) return;
			// Transforms change the displayed TV size without resizing its layout box.
			const rect = !doc.hidden && handle.screenInView() ? video.getBoundingClientRect() : null;
			const next = (rect &&
				measureScreenShareViewerDemand(
					{clientWidth: rect.width, clientHeight: rect.height},
					resolveDevicePixelRatio(video.ownerDocument.defaultView),
				)) || {width: 1, height: 1};
			if (isWithinScreenShareViewerDemandDeadBand(applied, next)) return;
			applied = next;
			applyScreenShareViewerDemand({publication, label, viewerKey, dimensions: next, onError});
		};
		const schedule = () => {
			if (doc.hidden) {
				if (timer !== null) clearTimeout(timer);
				apply();
				return;
			}
			if (timer === null) timer = setTimeout(apply, SCREEN_SHARE_VIEWER_DEMAND_DEBOUNCE_MS);
		};
		const onVisibilityChange = () => {
			// The resumed scene frame must restore the holder before its size is measured.
			if (timer !== null) clearTimeout(timer);
			timer = null;
			schedule();
		};
		schedule();
		const stopViewChanges = handle.onViewChange(schedule);
		doc.addEventListener('visibilitychange', onVisibilityChange);
		publication.on(TrackEvent.Subscribed, schedule);
		publication.on(TrackEvent.Unsubscribed, release);
		return () => {
			if (timer !== null) clearTimeout(timer);
			stopViewChanges();
			doc.removeEventListener('visibilitychange', onVisibilityChange);
			publication.off(TrackEvent.Subscribed, schedule);
			publication.off(TrackEvent.Unsubscribed, release);
			release();
		};
	}, [enabled, handle, publication, trackSid, videoRef, viewerKey]);
}
