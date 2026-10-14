// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import type {MessageEmbed} from '@app/api/database/types/MessageTypes';
import {
	classifyFeedLinkPreviewUrl,
	type FeedLinkPreviewTarget,
	feedInviteBases,
	findFeedLinkPreviewTarget,
} from '@app/api/feed/FeedLinkPreview';
import type {FeedRepository} from '@app/api/feed/FeedRepository';
import {contentModerationService, type ModerationContext} from '@app/api/infrastructure/ContentModerationService';
import type {EmbedService} from '@app/api/infrastructure/EmbedService';
import {Logger} from '@app/api/Logger';
import {ContentBlockedError} from '@fluxer/errors/src/domains/content/ContentBlockedError';

// How long a feed preview may hold an unfurl lane slot. The NATS unfurler keeps its own 12 s timeout
// and does not stop on the signal, so the wait is cut here and a late answer is dropped.
const UNFURL_TIMEOUT_MS = 5000;
const PROVIDER_NAMES = {youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick', invite: 'sanalyer'} as const;

export type FeedEmbedResult = 'stored' | 'none' | 'gone' | 'blocked';

interface FeedEmbedServiceDeps {
	feedRepository: Pick<FeedRepository, 'getPost' | 'setPostEmbeds'>;
	embedService: Pick<EmbedService, 'processUrlWithCachePolicy'>;
	removePost: (post: FeedPostRow) => Promise<void>;
}

// The one link preview of a feed post, resolved once on the unfurl lane (extractFeedPostEmbeds, shared with
// message previews; TEMPORARY: see WorkerLaneConfig) and stored on the row. Only allow-listed links reach the unfurler,
// through Fluxer's own unfurl path; invites are never fetched.
export class FeedEmbedService {
	constructor(private readonly deps: FeedEmbedServiceDeps) {}

	async extractPostEmbeds(postId: bigint): Promise<FeedEmbedResult> {
		const {feedRepository} = this.deps;
		const post = await feedRepository.getPost(postId);
		if (!post) return 'gone';
		if (post.embeds?.length) return 'stored';
		const target = findFeedLinkPreviewTarget(post.content, feedInviteBases());
		if (!target) return 'none';
		const embed = (target.kind === 'invite' ? null : await this.unfurl(target)) ?? fallbackCard(target);
		if (isBlocked(target.url, embed, post)) {
			Logger.warn(
				{postId: postId.toString(), userId: post.author_id.toString()},
				'Content moderation blocked a feed link preview, deleting the post',
			);
			await this.deps.removePost(post);
			return 'blocked';
		}
		return (await feedRepository.setPostEmbeds(postId, [embed])) ? 'stored' : 'gone';
	}

	/**
	 * The first card that is not NSFW, or null when the unfurler has none, fails or does not answer in time, or when the
	 * card is for another kind of site than the link (an allowed path that redirected off the site must not show another
	 * site's card under the link's brand).
	 */
	private async unfurl(target: FeedLinkPreviewTarget): Promise<MessageEmbed | null> {
		const signal = AbortSignal.timeout(UNFURL_TIMEOUT_MS);
		try {
			const {embeds} = await Promise.race([
				this.deps.embedService.processUrlWithCachePolicy(target.url, 'block', {signal}),
				new Promise<never>((_, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), {once: true});
				}),
			]);
			const embed = embeds.map((entry) => entry.toMessageEmbed()).find((entry) => !isNsfw(entry));
			if (!embed || classifyFeedLinkPreviewUrl(embed.url ?? '', [])?.kind !== target.kind) return null;
			// The stored link is the post's own, so the preview classifies and opens as written.
			return {...embed, url: target.url, children: null};
		} catch (error) {
			Logger.warn({error, url: target.url}, 'Unfurling a feed link preview failed, storing the fallback card');
			return null;
		}
	}
}

function isNsfw(embed: MessageEmbed): boolean {
	return embed.nsfw === true || (embed.children ?? []).some((child) => child.nsfw === true);
}

function fallbackCard(target: FeedLinkPreviewTarget): MessageEmbed {
	const label = target.kind === 'twitch' || target.kind === 'kick' ? new URL(target.url).pathname.slice(1) : '';
	return {
		type: 'link',
		url: target.url,
		title: label.replace(/\/$/, '') || null,
		description: null,
		timestamp: null,
		color: null,
		author: null,
		provider: {name: PROVIDER_NAMES[target.kind], url: null},
		thumbnail: null,
		image: null,
		video: null,
		footer: null,
		fields: null,
		nsfw: null,
		children: null,
	};
}

// The message unfurl check (ExtractEmbeds): the link and every card image against the URL blocklist.
function isBlocked(url: string, embed: MessageEmbed, post: FeedPostRow): boolean {
	const ctx: ModerationContext = {
		userId: post.author_id,
		guildId: null,
		channelId: null,
		messageId: null,
		surface: 'message_embed_unfurl',
	};
	try {
		for (const candidate of [url, embed.thumbnail?.url, embed.image?.url, embed.video?.url, embed.audio?.url]) {
			if (candidate) contentModerationService.scanUrl(candidate, ctx);
		}
		return false;
	} catch (error) {
		if (error instanceof ContentBlockedError) return true;
		Logger.error({error, postId: post.post_id.toString()}, 'Content moderation check failed, keeping the feed preview');
		return false;
	}
}
