// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import Accessibility from '@app/features/accessibility/state/Accessibility';
import guildStyles from '@app/features/app/components/layout/GuildsLayout.module.css';
import styles from '@app/features/app/components/layout/sidebar_nav/FeedButton.module.css';
import {resolveGuildListIndicatorBarTarget} from '@app/features/app/components/layout/sidebar_nav/GuildListIndicator';
import {useHover} from '@app/features/app/hooks/useHover';
import {useMergeRefs} from '@app/features/app/hooks/useMergeRefs';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {useLocation} from '@app/features/platform/components/router/RouterReact';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {NewspaperIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {AnimatePresence, motion} from 'framer-motion';
import {observer} from 'mobx-react-lite';
import {useCallback, useRef, useState} from 'react';

const FEED_DESCRIPTOR = msg({
	message: 'Feed',
	comment: 'Short label in the sidebar navigation button that opens the feed of posts from followed accounts.',
});
export const FeedButton = observer(() => {
	const {i18n} = useLingui();
	const [hoverRef, isHovering] = useHover();
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const iconRef = useRef<HTMLDivElement | null>(null);
	const mergedRef = useMergeRefs([hoverRef, buttonRef]);
	const location = useLocation();
	const isSelected = Routes.isFeedRoute(location.pathname);
	// Micup: the instance icon (branding icon_url) is the feed glyph on the home tile's gray (white when selected or
	// hovered, with the rail's left bar); if it does not load, the newspaper tile comes back.
	const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
	const iconUrl = RuntimeConfig.iconUrl !== failedIconUrl ? RuntimeConfig.iconUrl : null;
	const isHighlighted = isSelected || isHovering;
	const handleClick = useCallback(() => {
		RouterUtils.transitionTo(Routes.FEED);
	}, []);
	return (
		<div className={guildStyles.createGuildButton} data-flx="app.sidebar-nav.feed-button.div">
			<AnimatePresence data-flx="app.sidebar-nav.feed-button.animate-presence">
				{iconUrl && isHighlighted && (
					<div className={guildStyles.guildIndicator} data-flx="app.sidebar-nav.feed-button.guild-indicator">
						<motion.span
							className={guildStyles.guildIndicatorBar}
							initial={false}
							animate={resolveGuildListIndicatorBarTarget({isSelected, showHoverState: isHovering})}
							exit={{opacity: 0, height: 0}}
							transition={{duration: Accessibility.useReducedMotion ? 0 : 0.2, ease: [0.25, 0.1, 0.25, 1]}}
							data-flx="app.sidebar-nav.feed-button.guild-indicator-bar"
						/>
					</div>
				)}
			</AnimatePresence>
			<Tooltip
				position="right"
				size="large"
				text={i18n._(FEED_DESCRIPTOR)}
				data-flx="app.sidebar-nav.feed-button.tooltip"
			>
				<FocusRing
					offset={-2}
					focusTarget={buttonRef}
					ringTarget={iconRef}
					data-flx="app.sidebar-nav.feed-button.focus-ring"
				>
					<button
						type="button"
						aria-label={i18n._(FEED_DESCRIPTOR)}
						aria-current={isSelected ? 'page' : undefined}
						data-guild-list-focus-item="true"
						onClick={handleClick}
						className={styles.button}
						ref={mergedRef}
						data-flx="app.sidebar-nav.feed-button.button.click"
					>
						<motion.div
							ref={iconRef}
							className={
								iconUrl
									? clsx(guildStyles.fluxerButtonIcon, isHighlighted && guildStyles.fluxerButtonIconSelected)
									: guildStyles.createGuildButtonIcon
							}
							animate={{borderRadius: '30%'}}
							initial={{borderRadius: '30%'}}
							transition={{duration: Accessibility.useReducedMotion ? 0 : 0.07, ease: 'easeOut'}}
							style={
								isSelected && !iconUrl
									? {backgroundColor: 'var(--brand-primary)', color: 'var(--brand-primary-fill)'}
									: undefined
							}
							data-flx="app.sidebar-nav.feed-button.div--2"
						>
							{iconUrl ? (
								<img
									src={iconUrl}
									alt={i18n._(FEED_DESCRIPTOR)}
									draggable={false}
									onError={() => setFailedIconUrl(iconUrl)}
									className={isHighlighted ? styles.logoHighlighted : styles.logo}
									data-flx="app.sidebar-nav.feed-button.logo"
								/>
							) : (
								<NewspaperIcon
									weight="fill"
									className={isSelected ? styles.iconTextSelected : styles.iconText}
									data-flx="app.sidebar-nav.feed-button.icon-text"
								/>
							)}
						</motion.div>
					</button>
				</FocusRing>
			</Tooltip>
		</div>
	);
});
