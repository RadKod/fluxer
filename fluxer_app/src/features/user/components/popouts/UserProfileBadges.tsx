// SPDX-License-Identifier: AGPL-3.0-or-later

import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {mediaUrl} from '@app/features/messaging/utils/MessagingUrlUtils';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {getPremiumProductFullName} from '@app/features/premium/utils/PremiumUtils';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {handleExternalLinkClick} from '@app/features/ui/utils/NativeUtils';
import styles from '@app/features/user/components/popouts/UserProfileBadges.module.css';
import type {Profile} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import premiumBadgeUrl from '@app/media/images/micup-premium-badge.png';
import {PublicUserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useMemo} from 'react';

const BADGE_ASSET_VERSION = '3';
const PROFILE_BADGE_PRIORITY: Record<string, number> = {staff: 0, premium: 1, bug_hunter: 3};
const logger = new Logger('UserProfileBadges');

// Catalog assets have no fixed identity. Measure their alpha padding once they load; media responses allow CORS.
const measureCatalogBadge = (event: React.SyntheticEvent<HTMLImageElement>) => {
	const image = event.currentTarget;
	if (!image.naturalWidth || !image.naturalHeight) return;
	const canvas = image.ownerDocument.createElement('canvas');
	const ratio = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
	canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
	canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
	const context = canvas.getContext('2d', {willReadFrequently: true});
	if (!context) return;
	try {
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
		let top = canvas.height;
		let bottom = -1;
		let left = canvas.width;
		let right = -1;
		for (let y = 0; y < canvas.height; y++) {
			for (let x = 0; x < canvas.width; x++) {
				if (data[(y * canvas.width + x) * 4 + 3] >= 16) {
					top = Math.min(top, y);
					bottom = y;
					left = Math.min(left, x);
					right = Math.max(right, x);
				}
			}
		}
		if (bottom >= top) {
			image.style.setProperty('--badge-optical-scale', String(canvas.height / (bottom - top + 1)));
			image.style.setProperty('--badge-optical-inset-left', String(left / canvas.height));
			image.style.setProperty('--badge-optical-inset-right', String((canvas.width - right - 1) / canvas.height));
		}
	} catch (error) {
		logger.warn('Could not measure catalog badge alpha padding', error);
	}
};

// Micup: the flag badge icons are Micup's own, served under /badges/micup-*.
const badgeAssetUrl = (fileName: string) =>
	`${RuntimeConfig.staticCdnEndpoint}/badges/micup-${fileName}?v=${BADGE_ASSET_VERSION}`;

const STAFF_DESCRIPTOR = msg({
	message: '{productName} Staff',
	comment:
		'Short badge title in the user profile badges popout. Preserve {productName}; it is inserted by code. English locales use Title Case for official badge titles; other locales should use natural local capitalization.',
});
const PARTNER_DESCRIPTOR = msg({
	message: '{productName} Partner',
	comment:
		'Short badge title in the user profile badges popout. Preserve {productName}; it is inserted by code. English locales use Title Case for official badge titles; other locales should use natural local capitalization.',
});
const BUG_HUNTER_DESCRIPTOR = msg({
	message: '{productName} Bug Hunter',
	comment:
		'Short badge title in the user profile badges popout. Preserve {productName}; it is inserted by code. English locales use Title Case for official badge titles; other locales should use natural local capitalization.',
});
const VISIONARY_ID_DESCRIPTOR = msg({
	message: 'Visionary ID {visionaryIdLabel}',
	comment:
		'Short label in the user profile badges popout. Keep it concise. Preserve {visionaryIdLabel}; it is inserted by code.',
});

interface BaseBadge {
	key: string;
	priority?: number;
	tooltip: string;
	url?: string;
	onClick?: () => void;
}

interface IconBadge extends BaseBadge {
	type: 'icon';
	iconUrl: string;
	opticalScale?: number;
	opticalInsets?: [number, number];
}

interface TextBadge extends BaseBadge {
	type: 'text';
	text: string;
}

type Badge = IconBadge | TextBadge;

interface UserProfileBadgesProps {
	user: User;
	profile: Profile | null;
	isModal?: boolean;
	isMobile?: boolean;
	// The You page and DM welcome keep their existing crown next to the name.
	showPremium?: boolean;
	largeProfile?: boolean;
}

export const UserProfileBadges: React.FC<UserProfileBadgesProps> = observer(
	({user, profile, isModal = false, isMobile = false, showPremium = true, largeProfile = false}) => {
		const {i18n} = useLingui();
		const badges = useMemo(() => {
			const result: Array<Badge> = [];
			// Micup: every flag badge shows on this self-hosted instance, without links to Fluxer's marketing pages.
			if (user.flags & PublicUserFlags.STAFF) {
				result.push({
					type: 'icon',
					key: 'staff',
					iconUrl: badgeAssetUrl('staff.svg'),
					opticalScale: 1.15,
					opticalInsets: [19 / 512, 18 / 512],
					tooltip: i18n._(STAFF_DESCRIPTOR, {productName: PRODUCT_NAME}),
				});
			}
			if (showPremium && user.flags & PublicUserFlags.PREMIUM_BADGE) {
				result.push({
					type: 'icon',
					key: 'premium',
					iconUrl: premiumBadgeUrl,
					opticalScale: 1.37,
					opticalInsets: [18 / 512, 18 / 512],
					tooltip: getPremiumProductFullName(),
				});
			}
			if (user.flags & PublicUserFlags.PARTNER) {
				result.push({
					type: 'icon',
					key: 'partner',
					iconUrl: badgeAssetUrl('partner.svg'),
					opticalScale: 1,
					tooltip: i18n._(PARTNER_DESCRIPTOR, {productName: PRODUCT_NAME}),
				});
			}
			if (user.flags & PublicUserFlags.BUG_HUNTER) {
				result.push({
					type: 'icon',
					key: 'bug_hunter',
					iconUrl: badgeAssetUrl('bug-hunter.svg'),
					opticalScale: 1.02,
					opticalInsets: [41 / 512, 40 / 512],
					tooltip: i18n._(BUG_HUNTER_DESCRIPTOR, {productName: PRODUCT_NAME}),
				});
			}
			if (profile?.premiumType === UserPremiumTypes.LIFETIME && profile.premiumLifetimeSequence != null) {
				const visionaryIdLabel = `#${profile.premiumLifetimeSequence}`;
				result.push({
					type: 'text',
					key: 'premium_sequence',
					text: visionaryIdLabel,
					tooltip: i18n._(VISIONARY_ID_DESCRIPTOR, {visionaryIdLabel}),
				});
			}
			// Micup: catalog badges from the profile, in the server's order; the description is plain text.
			for (const badge of profile?.badges ?? []) {
				result.push({
					type: 'icon',
					key: `badge-${badge.id}`,
					priority: 2,
					iconUrl: mediaUrl(`branding/badge-${badge.id}/${badge.icon}.webp?size=128`),
					tooltip: badge.description,
				});
			}
			return showPremium
				? result.sort(
						(a, b) =>
							(PROFILE_BADGE_PRIORITY[a.key] ?? a.priority ?? 4) - (PROFILE_BADGE_PRIORITY[b.key] ?? b.priority ?? 4),
					)
				: result;
		}, [user.flags, profile?.premiumType, profile?.premiumLifetimeSequence, profile?.badges, i18n.locale, showPremium]);
		if (badges.length === 0) {
			return null;
		}
		const containerClassName = isModal
			? clsx(styles.containerModal, isMobile ? styles.containerModalMobile : styles.containerModalDesktop)
			: styles.containerPopout;
		const badgeClassName = showPremium ? styles.badge : isModal && isMobile ? styles.badgeMobile : styles.badgeDesktop;
		const isDesktopInteractions = !isMobile;
		const renderInteractiveWrapper = (
			url: string | undefined,
			onClick: (() => void) | undefined,
			children: React.ReactNode,
		) => {
			if (onClick && isDesktopInteractions) {
				return (
					<button
						type="button"
						className={clsx(styles.link, styles.linkButton)}
						onClick={onClick}
						data-flx="user.user-profile-badges.render-interactive-wrapper.button"
					>
						{children}
					</button>
				);
			}
			if (url && isDesktopInteractions) {
				return (
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className={styles.link}
						onClick={(event) => handleExternalLinkClick(event, url)}
						data-flx="user.user-profile-badges.render-interactive-wrapper.link"
					>
						{children}
					</a>
				);
			}
			return (
				<div className={styles.link} data-flx="user.user-profile-badges.render-interactive-wrapper.link--2">
					{children}
				</div>
			);
		};
		return (
			<div
				className={clsx(containerClassName, largeProfile && styles.largeProfile)}
				style={
					largeProfile
						? ({'--profile-badge-height': '17px', '--profile-badge-gap': 'var(--spacing-2)'} as React.CSSProperties)
						: showPremium
							? ({
									'--profile-badge-gap': 'calc(var(--profile-badge-height, 0.75rem) * 0.570327553)',
								} as React.CSSProperties)
							: undefined
				}
				data-flx="user.user-profile-badges.div"
			>
				{badges.map((badge) => {
					const sequenceClassName = isModal && isMobile ? styles.sequenceBadgeMobile : styles.sequenceBadgeDesktop;
					// The shipped flag SVGs fill their canvas; the 128px premium PNG has 90px of visible ink.
					const profileOpticalStyle =
						largeProfile && ['staff', 'premium', 'partner', 'bug_hunter'].includes(badge.key)
							? ({
									'--badge-optical-scale': badge.key === 'premium' ? 128 / 90 : 1,
									'--badge-optical-inset-left': badge.key === 'premium' ? 4 / 128 : 0,
									'--badge-optical-inset-right': badge.key === 'premium' ? 5 / 128 : 0,
								} as React.CSSProperties)
							: undefined;
					const badgeContent =
						badge.type === 'icon' ? (
							<img
								src={badge.iconUrl}
								alt={badge.tooltip}
								className={badgeClassName}
								style={
									profileOpticalStyle ??
									(showPremium && badge.opticalScale
										? ({
												'--badge-optical-scale': badge.opticalScale,
												'--badge-optical-inset-left': badge.opticalInsets?.[0],
												'--badge-optical-inset-right': badge.opticalInsets?.[1],
											} as React.CSSProperties)
										: undefined)
								}
								crossOrigin={showPremium && badge.opticalScale === undefined ? 'anonymous' : undefined}
								onLoad={showPremium && badge.opticalScale === undefined ? measureCatalogBadge : undefined}
								data-flx="user.user-profile-badges.img"
							/>
						) : (
							<span
								className={clsx(styles.sequenceBadge, sequenceClassName)}
								aria-hidden="true"
								data-flx="user.user-profile-badges.sequence-badge"
							>
								{badge.text}
							</span>
						);
					return (
						<Tooltip key={badge.key} text={badge.tooltip} maxWidth="xl" data-flx="user.user-profile-badges.tooltip">
							<FocusRing offset={-2} data-flx="user.user-profile-badges.focus-ring">
								{renderInteractiveWrapper(badge.url, badge.onClick, badgeContent)}
							</FocusRing>
						</Tooltip>
					);
				})}
			</div>
		);
	},
);
