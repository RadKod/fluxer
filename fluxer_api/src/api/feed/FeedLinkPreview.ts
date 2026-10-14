// SPDX-License-Identifier: AGPL-3.0-or-later

import {signAttachmentUrl} from '@app/api/attachment/AttachmentUrls';
import {Config} from '@app/api/Config';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import type {MessageEmbedMedia} from '@app/api/database/types/MessageTypes';
import type {IMediaService} from '@app/api/infrastructure/IMediaService';
import {URL_REGEX} from '@fluxer/constants/src/Core';
import type {FeedLinkPreviewResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {EmbedMediaResponse} from '@fluxer/schema/src/domains/message/EmbedSchemas';

export type FeedLinkPreviewTargetKind = 'youtube' | 'twitch' | 'kick' | 'invite';

export interface FeedLinkPreviewTarget {
	kind: FeedLinkPreviewTargetKind;
	/** The link as written in the post, canonical (new URL().toString(): lower case host). */
	url: string;
	inviteCode: string | null;
}

export interface FeedInviteBase {
	/** Scheme, host and port of the configured endpoint (URL.origin): an invite link must match all three. */
	origin: string;
	pathPrefix: string;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);
const KICK_HOSTS = new Set(['kick.com', 'www.kick.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PATH = /^\/(?:shorts|live|embed)\/[A-Za-z0-9_-]{11}\/?$/;
const YOUTU_BE_PATH = /^\/[A-Za-z0-9_-]{11}\/?$/;
const TWITCH_CHANNEL = /^\/([A-Za-z0-9_]{3,25})\/?$/;
const TWITCH_RESERVED = new Set([
	'directory',
	'downloads',
	'jobs',
	'p',
	'search',
	'settings',
	'subscriptions',
	'turbo',
	'videos',
	'wallet',
]);
const TWITCH_PATHS = [/^\/videos\/\d+\/?$/, /^\/[A-Za-z0-9_]{3,25}\/clip\/[A-Za-z0-9_-]+\/?$/];
const TWITCH_CLIP_PATH = /^\/[A-Za-z0-9_-]+\/?$/;
const KICK_PATHS = [
	/^\/[A-Za-z0-9_-]{3,25}\/?$/,
	/^\/[A-Za-z0-9_-]{3,25}\/videos\/[0-9a-f-]{36}\/?$/,
	/^\/[A-Za-z0-9_-]{3,25}\/clips\/[A-Za-z0-9_-]+\/?$/,
];
const INVITE_CODE = /^([a-zA-Z0-9-]{2,32})\/?$/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function siteKind(url: URL): FeedLinkPreviewTargetKind | null {
	const {hostname, pathname} = url;
	if (YOUTUBE_HOSTS.has(hostname)) {
		const watch = /^\/watch\/?$/.test(pathname) && YOUTUBE_ID.test(url.searchParams.get('v') ?? '');
		return watch || YOUTUBE_PATH.test(pathname) ? 'youtube' : null;
	}
	if (hostname === 'youtu.be') return YOUTU_BE_PATH.test(pathname) ? 'youtube' : null;
	if (TWITCH_HOSTS.has(hostname)) {
		const channel = TWITCH_CHANNEL.exec(pathname)?.[1];
		const isChannel = channel !== undefined && !TWITCH_RESERVED.has(channel.toLowerCase());
		return isChannel || TWITCH_PATHS.some((path) => path.test(pathname)) ? 'twitch' : null;
	}
	if (hostname === 'clips.twitch.tv') return TWITCH_CLIP_PATH.test(pathname) ? 'twitch' : null;
	if (KICK_HOSTS.has(hostname)) return KICK_PATHS.some((path) => path.test(pathname)) ? 'kick' : null;
	return null;
}

/**
 * The preview target of one link, or null. Exact host match on the parsed URL (look-alike hosts, a host inside a query
 * or behind credentials never match), http(s) only, and only the path shapes the unfurler resolves. The unfurler is
 * asked only for YouTube, Twitch and Kick links on their default port; invites are never fetched and keep the scheme and
 * port of the configured endpoint (https on the default port in production).
 */
export function classifyFeedLinkPreviewUrl(
	raw: string,
	inviteBases: ReadonlyArray<FeedInviteBase>,
): FeedLinkPreviewTarget | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
		return null;
	}
	for (const base of inviteBases) {
		if (url.origin !== base.origin || !url.pathname.startsWith(base.pathPrefix)) continue;
		const code = INVITE_CODE.exec(url.pathname.slice(base.pathPrefix.length))?.[1];
		if (code) return {kind: 'invite', url: url.toString(), inviteCode: code};
	}
	if (url.port !== '') return null;
	const kind = siteKind(url);
	return kind ? {kind, url: url.toString(), inviteCode: null} : null;
}

/** The first allowed link of a post's text (at most one preview per post). */
export function findFeedLinkPreviewTarget(
	content: string | null,
	inviteBases: ReadonlyArray<FeedInviteBase>,
): FeedLinkPreviewTarget | null {
	for (const candidate of content?.match(URL_REGEX) ?? []) {
		const target = classifyFeedLinkPreviewUrl(candidate.replace(TRAILING_PUNCTUATION, ''), inviteBases);
		if (target) return target;
	}
	return null;
}

function inviteBase(endpoint: string, pathPrefix?: string): FeedInviteBase | null {
	try {
		const url = new URL(endpoint);
		return {origin: url.origin, pathPrefix: pathPrefix ?? `${url.pathname.replace(/\/+$/, '')}/`};
	} catch {
		return null;
	}
}

/** Where this instance's invite links live: only the configured endpoints, never a fixed host. */
export function feedInviteBases(): Array<FeedInviteBase> {
	const bases: Array<FeedInviteBase> = [];
	for (const base of [inviteBase(Config.endpoints.invite), inviteBase(Config.endpoints.webApp, '/invite/')]) {
		if (base && !bases.some((seen) => seen.origin === base.origin && seen.pathPrefix === base.pathPrefix)) {
			bases.push(base);
		}
	}
	return bases;
}

function httpUrl(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const {protocol} = new URL(raw);
		return protocol === 'https:' || protocol === 'http:' ? raw : null;
	} catch {
		return null;
	}
}

function mapMedia(
	media: MessageEmbedMedia | null | undefined,
	mediaService: Pick<IMediaService, 'getExternalMediaProxyURL'>,
): EmbedMediaResponse | null {
	const url = httpUrl(media?.url);
	if (!media || !url) return null;
	return {
		url,
		proxy_url: signAttachmentUrl(mediaService.getExternalMediaProxyURL(url)),
		content_type: media.content_type,
		width: media.width,
		height: media.height,
		placeholder: media.placeholder,
		duration: media.duration,
		flags: media.flags,
	};
}

/**
 * The response form of a post's stored preview. Kind and invite code come from classifying the stored link again, so
 * the allow list decides on every read; images go through the media proxy; html, fields, footer, icons and nested
 * cards are left out, and a YouTube player is kept only when it is a YouTube embed URL (the client puts it in an
 * iframe).
 */
export function mapFeedLinkPreview(
	row: Pick<FeedPostRow, 'embeds'>,
	mediaService: Pick<IMediaService, 'getExternalMediaProxyURL'>,
	inviteBases: ReadonlyArray<FeedInviteBase>,
): FeedLinkPreviewResponse | null {
	const embed = row.embeds?.[0];
	const target = embed?.url ? classifyFeedLinkPreviewUrl(embed.url, inviteBases) : null;
	if (!embed || !target) return null;
	if (target.kind === 'invite') return {kind: 'invite', url: target.url, invite_code: target.inviteCode, embed: null};
	const player =
		target.kind !== 'youtube' || classifyFeedLinkPreviewUrl(embed.video?.url ?? '', [])?.kind === 'youtube';
	return {
		kind: target.kind,
		url: target.url,
		invite_code: null,
		embed: {
			type: embed.type ?? 'link',
			url: target.url,
			title: embed.title,
			description: embed.description,
			color: embed.color,
			timestamp: embed.timestamp?.toISOString() ?? null,
			author: embed.author?.name ? {name: embed.author.name, url: httpUrl(embed.author.url)} : null,
			provider: embed.provider?.name ? {name: embed.provider.name, url: httpUrl(embed.provider.url)} : null,
			thumbnail: mapMedia(embed.thumbnail, mediaService),
			image: mapMedia(embed.image, mediaService),
			video: player ? mapMedia(embed.video, mediaService) : null,
		},
	};
}
