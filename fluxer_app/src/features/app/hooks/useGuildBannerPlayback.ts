// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {useAnimatedMediaPlaybackAllowed} from '@app/features/app/hooks/useAnimatedMediaPlayback';
import {useHover} from '@app/features/app/hooks/useHover';
import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import {toSinglePlayAnimatedImage} from '@app/features/app/utils/AnimatedImageLoop';
import {type RefCallback, useEffect, useRef, useState} from 'react';

export const GUILD_BANNER_MAX_BYTES = 8 * 1024 * 1024;
const NOOP_HOVER_REF: RefCallback<HTMLElement> = () => {};

interface GuildBannerPlaybackOptions {
	guildId: string;
	bannerHash: string | null;
	staticUrl: string | null;
	animatedUrl: string | null;
	visible: boolean;
}

interface BannerEntry {
	guildId: string;
	bannerHash: string | null;
	controller: AbortController | null;
	blob: Blob | null;
	url: string | null;
	failed: boolean;
	consumed: boolean;
	hovering: boolean;
	interactionPlayback: boolean;
}

function release(entry: BannerEntry): void {
	entry.controller?.abort();
	entry.controller = null;
	if (entry.url) URL.revokeObjectURL(entry.url);
	entry.url = null;
	entry.blob = null;
}

async function loadBanner(url: string, controller: AbortController): Promise<Blob | null> {
	const response = await fetch(url, {signal: controller.signal});
	if (controller.signal.aborted) return null;
	if (!response.ok || !response.body) {
		controller.abort();
		return null;
	}
	const declaredLength = Number(response.headers.get('content-length'));
	if (declaredLength > GUILD_BANNER_MAX_BYTES) {
		controller.abort();
		return null;
	}
	const reader = response.body.getReader();
	const chunks: Array<Uint8Array> = [];
	let length = 0;
	try {
		while (!controller.signal.aborted) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > GUILD_BANNER_MAX_BYTES) {
				controller.abort();
				return null;
			}
			chunks.push(next.value);
		}
	} finally {
		if (controller.signal.aborted) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	if (controller.signal.aborted) return null;
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	chunks.length = 0;
	const image = toSinglePlayAnimatedImage(bytes);
	if (!image) return null;
	if (image.loopOffset != null) {
		bytes[image.loopOffset] = 1;
		bytes[image.loopOffset + 1] = 0;
	}
	return new Blob(image.parts, {type: image.type});
}

export function useGuildBannerPlayback({
	guildId,
	bannerHash,
	staticUrl,
	animatedUrl,
	visible,
}: GuildBannerPlaybackOptions) {
	const [hoverRef, isHovering] = useHover();
	const isAnimated = Boolean(animatedUrl && animatedUrl !== staticUrl);
	const policyAutoplay = useShouldAnimate({kind: 'gif', isAnimated});
	const hoverAllowed = useShouldAnimate({kind: 'gif', isAnimated, isHovering: true});
	// Banner entry autoplay is stricter than the shared keep-GIF reduced-motion exception.
	const autoplay = policyAutoplay && !Accessibility.useReducedMotion;
	const playbackAllowed = useAnimatedMediaPlaybackAllowed({isAnimated});
	const canStartPlayback = useRef(false);
	canStartPlayback.current = visible && playbackAllowed && hoverAllowed && (autoplay || isHovering);
	const owner = useRef<BannerEntry | null>(null);
	const [playing, setPlaying] = useState<{entry: BannerEntry; url: string} | null>(null);

	useEffect(() => {
		const entry: BannerEntry = {
			guildId,
			bannerHash,
			controller: null,
			blob: null,
			url: null,
			failed: false,
			consumed: false,
			hovering: false,
			interactionPlayback: false,
		};
		owner.current = entry;
		setPlaying(null);
		return () => {
			owner.current = null;
			release(entry);
		};
	}, [guildId, bannerHash]);

	useEffect(() => {
		const entry = owner.current;
		if (!entry) return;
		const enteredHover = isHovering && !entry.hovering;
		entry.hovering = isHovering;
		if (
			!visible ||
			(!playbackAllowed && !entry.consumed) ||
			!hoverAllowed ||
			(!autoplay && !entry.interactionPlayback && !enteredHover)
		) {
			release(entry);
			entry.interactionPlayback = false;
			setPlaying(null);
			return;
		}
		if (!playbackAllowed) return;
		const start = !entry.failed && (enteredHover || (autoplay && !entry.consumed));
		if (!start || !animatedUrl) return;
		if (enteredHover && !entry.failed) entry.interactionPlayback = true;
		const play = () => {
			if (!entry.blob || owner.current !== entry || !canStartPlayback.current) return;
			const url = URL.createObjectURL(entry.blob);
			if (entry.url) URL.revokeObjectURL(entry.url);
			entry.url = url;
			entry.consumed = true;
			setPlaying({entry, url});
		};
		if (entry.blob) {
			play();
		} else if (!entry.controller) {
			const controller = new AbortController();
			entry.controller = controller;
			void loadBanner(animatedUrl, controller)
				.then((blob) => {
					if (owner.current !== entry || entry.controller !== controller) return;
					entry.controller = null;
					if (!blob) {
						entry.failed = true;
						return;
					}
					entry.blob = blob;
					play();
				})
				.catch((error: unknown) => {
					// Network, CORS and malformed media failures keep the static banner for this entry.
					if (owner.current !== entry || entry.controller !== controller) return;
					entry.controller = null;
					if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
						entry.failed = true;
					}
				});
		}
	}, [guildId, bannerHash, animatedUrl, visible, playbackAllowed, hoverAllowed, autoplay, isHovering]);

	const current =
		playing?.entry === owner.current && playing?.entry.guildId === guildId && playing?.entry.bannerHash === bannerHash;
	return {
		hoverRef: isAnimated ? hoverRef : NOOP_HOVER_REF,
		imageUrl:
			visible && hoverAllowed && current && (autoplay || playing.entry.interactionPlayback) ? playing.url : staticUrl,
	};
}
