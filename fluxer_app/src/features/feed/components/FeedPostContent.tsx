// SPDX-License-Identifier: AGPL-3.0-or-later

import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import styles from '@app/features/feed/components/FeedPostContent.module.css';
import {splitFeedGifs} from '@app/features/feed/utils/FeedGifUtils';
import {SafeMarkdown} from '@app/features/messaging/components/markdown';
import {MarkdownContext} from '@app/features/messaging/components/markdown/renderers/RendererTypes';
import markupStyles from '@app/features/theme/styles/Markup.module.css';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useMemo} from 'react';

const GIF_DESCRIPTOR = msg({
	message: 'GIF',
	comment: 'Alternative text of a GIF drawn in a feed post or comment. Keep it as the format name.',
});

// Post and comment text is plain text drawn with the message markdown renderer, which builds React nodes and never
// injects HTML, so markup in a post shows as text. The one exception is a Klipy GIF from our own media proxy
// (isFeedGifUrl) in a comment or reply (inlineGifs), drawn as an image under the text while GIFs play; every other
// link stays a link. A post body never draws one: a post's GIF is an attachment, which Keşfet's media gate sees.
export const FeedPostContent = observer(
	({content, postId, inlineGifs = false}: {content: string; postId: string; inlineGifs?: boolean}) => {
		const {i18n} = useLingui();
		// Off with GIF autoplay off, reduced motion or data saver: the GIF stays its link, like a GIF nobody hovers.
		const animate = useShouldAnimate({kind: 'gif'});
		const drawGifs = inlineGifs && animate;
		const mediaEndpoint = RuntimeConfig.mediaEndpoint;
		const {text, gifs} = useMemo(
			() => (drawGifs ? splitFeedGifs(content, mediaEndpoint) : {text: content, gifs: []}),
			[content, drawGifs, mediaEndpoint],
		);
		return (
			<>
				<div className={markupStyles.markup} data-flx="feed.feed-post-content.markup">
					<SafeMarkdown
						content={text}
						options={{context: MarkdownContext.STANDARD_WITHOUT_JUMBO, messageId: postId}}
						data-flx="feed.feed-post-content.safe-markdown"
					/>
				</div>
				{gifs.map((src, index) => (
					<img
						key={index}
						className={styles.gif}
						src={src}
						alt={i18n._(GIF_DESCRIPTOR)}
						loading="lazy"
						data-flx="feed.feed-post-content.gif"
					/>
				))}
			</>
		);
	},
);
