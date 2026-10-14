// SPDX-License-Identifier: AGPL-3.0-or-later

import {PRODUCT_NAME, YOUTUBE_PROVIDER_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {EmbedYouTube} from '@app/features/channel/components/embeds/media/EmbedYouTube';
import {InviteEmbed} from '@app/features/channel/components/InviteEmbed';
import styles from '@app/features/feed/components/FeedLinkPreview.module.css';
import {openExternalUrlWithWarning} from '@app/features/messaging/utils/ExternalLinkUtils';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import type {FeedLinkPreviewKind, FeedLinkPreviewResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {MessageEmbed} from '@fluxer/schema/src/domains/message/EmbedSchemas';
import {observer} from 'mobx-react-lite';

// The name comes from the kind the server classified, never from the unfurled provider text.
const PROVIDER_NAMES: Record<FeedLinkPreviewKind, string> = {
	youtube: YOUTUBE_PROVIDER_NAME,
	twitch: 'Twitch',
	kick: 'Kick',
	invite: PRODUCT_NAME,
};

function displayUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.hostname + parsed.pathname;
	} catch {
		return url;
	}
}

// The one previewed link of a post. Everything that opens it opens preview.url, the link as written in the post;
// images are only ever the media proxy copies. Twitch and Kick get no player, only this card.
export const FeedLinkPreview = observer(({preview}: {preview: FeedLinkPreviewResponse}) => {
	const {kind, url, embed} = preview;
	if (kind === 'youtube' && embed?.video && embed.thumbnail?.proxy_url) {
		// Same wire shape as message embeds; its "open in new tab" follows embed.url, so that is the post's own link.
		return (
			<div className={styles.preview} data-flx="feed.feed-link-preview.preview">
				<EmbedYouTube embed={{...embed, url} as MessageEmbed} data-flx="feed.feed-link-preview.embed-you-tube" />
			</div>
		);
	}
	if (kind === 'invite' && preview.invite_code) {
		return (
			<div className={styles.preview} data-flx="feed.feed-link-preview.preview">
				<InviteEmbed code={preview.invite_code} data-flx="feed.feed-link-preview.invite-embed" />
			</div>
		);
	}
	const image = embed?.thumbnail?.proxy_url || embed?.image?.proxy_url || null;
	return (
		<FocusRing offset={-2} data-flx="feed.feed-link-preview.focus-ring">
			<button
				type="button"
				className={styles.card}
				onClick={() => openExternalUrlWithWarning(url)}
				data-flx="feed.feed-link-preview.card.open-link"
			>
				{image && (
					<img className={styles.image} src={image} alt="" loading="lazy" data-flx="feed.feed-link-preview.image" />
				)}
				<span className={styles.text} data-flx="feed.feed-link-preview.text">
					<span className={styles.provider} data-flx="feed.feed-link-preview.provider">
						{PROVIDER_NAMES[kind]}
					</span>
					<span className={styles.title} data-flx="feed.feed-link-preview.title">
						{embed?.title || displayUrl(url)}
					</span>
					{embed?.description && !MobileLayout.enabled && (
						<span className={styles.description} data-flx="feed.feed-link-preview.description">
							{embed.description}
						</span>
					)}
				</span>
			</button>
		</FocusRing>
	);
});
