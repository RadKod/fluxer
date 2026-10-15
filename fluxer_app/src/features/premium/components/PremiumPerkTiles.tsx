// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import Accessibility from '@app/features/accessibility/state/Accessibility';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {useHover} from '@app/features/app/hooks/useHover';
import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import {useViewportPlayback} from '@app/features/app/hooks/useViewportPlayback';
import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import {COSMETIC_TYPE_DESCRIPTIONS, COSMETIC_TYPE_LABELS} from '@app/features/cosmetics/utils/CosmeticLabels';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import styles from '@app/features/premium/components/PremiumPerkTiles.module.css';
import {premiumBadgeUrl} from '@app/features/premium/utils/PremiumBadgeAsset';
import {SPECIAL_DISCOUNTS_IN_SHOP_DESCRIPTOR} from '@app/features/premium/utils/PremiumCompareRows';
import {ShopMemberRowPreview} from '@app/features/shop/components/previews/ShopMemberRowPreview';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {previewEffectFor, previewUserFor} from '@app/features/shop/utils/ShopPreviewUser';
import {Avatar} from '@app/features/ui/components/Avatar';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {PROFILE_THEME_PRESETS} from '@app/features/user/components/modals/tabs/my_profile_tab/PlusAppearanceForm';
import {profileGradientSurface} from '@app/features/user/components/profile/ProfileGradientSurface';
import {ProfilePreview} from '@app/features/user/components/profile/ProfilePreview';
import Users from '@app/features/user/state/Users';
import earlyAccessBadgeUrl from '@app/media/images/premium/plus/erken-erisim.webp';
import nameStylePosterUrl from '@app/media/images/premium/plus/kart-ad-stili.webp';
import discountPosterUrl from '@app/media/images/premium/plus/kart-indirim.webp';
import nameStyleVideoUrl from '@app/media/videos/premium/plus/kart-ad-stili.mp4';
import discountVideoUrl from '@app/media/videos/premium/plus/kart-indirim.mp4';
import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import type {
	CosmeticAssetDataResponse,
	CosmeticItemResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckCircleIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useState} from 'react';

const HEADING_DESCRIPTOR = msg({
	message: 'Let everyone notice you',
	comment: 'Heading of the Plus page section that shows what Plus puts on your profile.',
});
const LEAD_DESCRIPTOR = msg({
	message: 'Your decorations show in chat, in the member list, in voice rooms and on your profile.',
	comment: 'Line under the heading of the Plus page section that shows what Plus puts on your profile.',
});
const WORN_ITEM_DESCRIPTOR = msg({
	message: '{type}: {name}',
	comment:
		'Line under the Plus profile card preview naming an item it wears. {type} is a decoration type such as Nameplate, {name} the item name.',
});
const BADGE_TITLE_DESCRIPTOR = msg({
	message: '{premiumProductName} badge',
	comment: 'Plus perk tile title: the badge shown next to the name of every Plus member.',
});
const BADGE_BODY_DESCRIPTOR = msg({
	message: 'Next to your name, for everyone to see.',
	comment: 'Plus perk tile text under the Plus badge title. At most two short lines.',
});
const EARLY_ACCESS_TITLE_DESCRIPTOR = msg({
	message: 'Early Access badge',
	comment: 'Plus perk tile title: the badge given to members who joined Plus early.',
});
const EARLY_ACCESS_BODY_DESCRIPTOR = msg({
	message: 'For members who join {premiumProductName} early. It stays on your profile.',
	comment: 'Plus perk tile text under the Early Access badge title. At most two short lines.',
});
const PROFILE_GRADIENT_TITLE_DESCRIPTOR = msg({
	message: 'Profile gradient',
	comment: 'Plus perk tile title: a two-colour gradient across the profile card.',
});
const PROFILE_GRADIENT_BODY_DESCRIPTOR = msg({
	message: 'Two colours across your profile card.',
	comment: 'Plus perk tile text under the profile gradient title. At most two short lines.',
});
const NAME_STYLE_TITLE_DESCRIPTOR = msg({
	message: 'Name style',
	comment: 'Plus perk tile title: a font and colours for the display name.',
});
const NAME_STYLE_BODY_DESCRIPTOR = msg({
	message: 'A font and a gradient for your name in chat, the member list and your profile.',
	comment: 'Plus perk tile text under the name style title. At most two short lines.',
});
const NAMEPLATE_BODY_DESCRIPTOR = msg({
	message: 'A background behind your name in the member list.',
	comment: 'Plus perk tile text under the nameplate title. At most two short lines.',
});
const DISCOUNT_BODY_DESCRIPTOR = msg({
	message: 'A special discount on shop decorations for {premiumProductName} members.',
	comment: 'Plus perk tile text under the shop discounts title. At most two short lines.',
});
const SEE_ULTRA_IN_SHOP_DESCRIPTOR = msg({
	message: 'See ultra decorations and more in the shop',
	comment: 'Link under the Plus perk tiles; opens the shop. Ultra decorations (wings) are sold, not included.',
});
const ACTIVE_DESCRIPTOR = msg({
	message: 'Active',
	comment: 'Status at the foot of a Plus perk tile when the account has that perk on right now.',
});

// Asks for the size the profile card's effect uses, so both draw from one cached image.
const EFFECT_CSS_SIZE = 480;
const AVATAR_SIZE = 72;
// What the profile gradient tile shows for an account that has not picked its own.
const SAMPLE_THEME_COLORS: ThemeColors = PROFILE_THEME_PRESETS[1];

// The tiles that show a decoration type, in the design's order.
const TYPE_TILES = ['avatar_decoration', 'profile_effect', 'nameplate'] as const;
const TYPE_BODIES: Record<(typeof TYPE_TILES)[number], MessageDescriptor> = {
	avatar_decoration: COSMETIC_TYPE_DESCRIPTIONS.avatar_decoration,
	profile_effect: COSMETIC_TYPE_DESCRIPTIONS.profile_effect,
	nameplate: NAMEPLATE_BODY_DESCRIPTOR,
};

function assetData(item: CosmeticItemResponse): CosmeticAssetDataResponse {
	return {asset: item.asset, item_id: item.id};
}

function openShop(): void {
	RouterUtils.transitionTo(Routes.SHOP);
}

interface PerkTileProps {
	title: string;
	body: string;
	// Whether the account has this perk on right now; only then the foot says Active.
	active: boolean;
	// The picture, told whether the pointer is on the tile: moving images play only then.
	art: (hovering: boolean) => React.ReactNode;
}

// A perk card: the picture band (the perk itself on one flat colour), the title, the text, and a foot with the plan
// it comes with and its state.
function PerkTile({title, body, active, art}: PerkTileProps) {
	const {i18n} = useLingui();
	const [hoverRef, hovering] = useHover();
	return (
		<div ref={hoverRef} className={styles.tile} data-flx="premium.premium-perk-tiles.tile">
			<div className={styles.art} aria-hidden="true" data-flx="premium.premium-perk-tiles.art">
				{art(hovering)}
			</div>
			<div className={styles.content} data-flx="premium.premium-perk-tiles.content">
				<h3 className={styles.title} data-flx="premium.premium-perk-tiles.tile-title">
					{title}
				</h3>
				<p className={styles.body} data-flx="premium.premium-perk-tiles.tile-body">
					{body}
				</p>
				<div className={styles.foot} data-flx="premium.premium-perk-tiles.foot">
					<span className={styles.tier} data-flx="premium.premium-perk-tiles.tier">
						<img
							className={styles.tierBadge}
							src={premiumBadgeUrl()}
							alt=""
							width={16}
							height={16}
							draggable={false}
							data-flx="premium.premium-perk-tiles.tier-badge"
						/>
						{PREMIUM_PRODUCT_NAME}
					</span>
					{active && (
						<span className={styles.active} data-flx="premium.premium-perk-tiles.active">
							<CheckCircleIcon
								className={styles.activeIcon}
								weight="fill"
								aria-hidden
								data-flx="premium.premium-perk-tiles.active-icon"
							/>
							{i18n._(ACTIVE_DESCRIPTOR)}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

// The effect's banner band. The moving file loads only on hover, never with Data Saver, and reduced motion keeps it
// still like every decoration (AvatarDecorationLayer).
// A perk's picture as a short muted loop over the whole band. It plays all the time while it is on screen; under reduced
// motion only its poster, the first frame, shows.
const PerkVideo = observer(({src, poster}: {src: string; poster: string}) => {
	const [video, setVideo] = useState<HTMLVideoElement | null>(null);
	const plays = useViewportPlayback(video) && !Accessibility.useReducedMotion;
	useEffect(() => {
		if (!video) return;
		if (plays) {
			void video.play().catch(() => {});
		} else {
			video.pause();
		}
	}, [video, plays]);
	return (
		<video
			ref={setVideo}
			className={styles.artVideo}
			src={src}
			poster={poster}
			preload="none"
			loop
			muted
			playsInline
			disablePictureInPicture
			draggable={false}
			data-flx="premium.premium-perk-tiles.art-video"
		/>
	);
});

const EffectArt = observer(({effect, hovering}: {effect: CosmeticAssetDataResponse; hovering: boolean}) => {
	const animated = useShouldAnimate({kind: 'avatar', isHovering: hovering && !Accessibility.useReducedMotion});
	const url = getCosmeticAssetURL('profile_effect', effect, EFFECT_CSS_SIZE, animated);
	return (
		<div className={styles.band} data-flx="premium.premium-perk-tiles.band">
			{url && (
				<img
					className={styles.effect}
					src={url}
					alt=""
					draggable={false}
					loading="lazy"
					data-flx="premium.premium-perk-tiles.effect"
				/>
			)}
		</div>
	);
});

// What premium puts on the user's own profile: their real profile card
// wearing only the items premium includes, and six tiles with one subject each. What the user wears stays off, the
// ultra wings above all: those are sold in the shop, never included. Item pictures come from the catalog, so a
// new premium set needs no app release.
export const PremiumPerkTiles = observer(() => {
	const {i18n} = useLingui();
	const user = Users.currentUser;
	if (!user) return null;
	const included = new Map<string, CosmeticItemResponse>();
	for (const {item} of ShopCatalog.itemEntries) {
		if (item.availability === 'premium' && item.type !== 'avatar_ultra' && !included.has(item.type)) {
			included.set(item.type, item);
		}
	}
	const previewUser = previewUserFor(user, ...included.values());
	const effectItem = included.get('profile_effect');
	const previewEffect = effectItem ? previewEffectFor(effectItem) : null;
	const discount = ShopCatalog.settings?.premium_discount_percent ?? 0;
	// What the account has on now: a trial wears the included items but pays the list price
	// (viewer.premium_discount), and the badge shows only while the server sets its flag (not hidden).
	const member = user.isPremium();
	const badgeShown = (user.flags & PublicUserFlags.PREMIUM_BADGE) !== 0;
	const tiles: Array<PerkTileProps & {key: string}> = TYPE_TILES.flatMap((type) => {
		const item = included.get(type);
		if (!item) return [];
		const art = (hovering: boolean) =>
			type === 'avatar_decoration' ? (
				<Avatar
					user={previewUser}
					size={AVATAR_SIZE}
					forceAnimate={hovering}
					data-flx="premium.premium-perk-tiles.avatar"
				/>
			) : type === 'profile_effect' ? (
				<EffectArt effect={assetData(item)} hovering={hovering} data-flx="premium.premium-perk-tiles.effect-art" />
			) : (
				<div className={styles.memberRow} data-flx="premium.premium-perk-tiles.member-row">
					<ShopMemberRowPreview
						user={previewUser}
						animateNameplate={hovering}
						data-flx="premium.premium-perk-tiles.shop-member-row-preview"
					/>
				</div>
			);
		return [
			{
				key: type,
				title: i18n._(COSMETIC_TYPE_LABELS[type]),
				body: i18n._(TYPE_BODIES[type]),
				active: member,
				art,
			},
		];
	});
	const profileGradient = profileGradientSurface(user.themeColors ?? SAMPLE_THEME_COLORS);
	// Whether this account holds the badge is not known here, so its tile never says Active.
	tiles.push({
		key: 'early_access',
		title: i18n._(EARLY_ACCESS_TITLE_DESCRIPTOR),
		body: i18n._(EARLY_ACCESS_BODY_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME}),
		active: false,
		art: () => (
			<img
				className={styles.earlyAccessBadge}
				src={earlyAccessBadgeUrl}
				alt=""
				width={130}
				height={80}
				loading="lazy"
				draggable={false}
				data-flx="premium.premium-perk-tiles.early-access-badge"
			/>
		),
	});
	tiles.push({
		key: 'name_style',
		title: i18n._(NAME_STYLE_TITLE_DESCRIPTOR),
		body: i18n._(NAME_STYLE_BODY_DESCRIPTOR),
		active: member,
		art: () => <PerkVideo src={nameStyleVideoUrl} poster={nameStylePosterUrl} />,
	});
	tiles.push({
		key: 'badge',
		title: i18n._(BADGE_TITLE_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME}),
		body: i18n._(BADGE_BODY_DESCRIPTOR),
		active: badgeShown,
		art: () => (
			<img
				className={styles.badge}
				src={premiumBadgeUrl()}
				alt=""
				width={48}
				height={48}
				draggable={false}
				data-flx="premium.premium-perk-tiles.badge"
			/>
		),
	});
	tiles.push({
		key: 'profile_gradient',
		title: i18n._(PROFILE_GRADIENT_TITLE_DESCRIPTOR),
		body: i18n._(PROFILE_GRADIENT_BODY_DESCRIPTOR),
		active: member,
		art: () => (
			<div
				className={clsx(styles.gradientCard, profileGradient?.className)}
				style={profileGradient?.style}
				data-flx="premium.premium-perk-tiles.gradient-card"
			>
				<span className={styles.gradientPanel} data-flx="premium.premium-perk-tiles.gradient-panel">
					{user.displayName}
				</span>
			</div>
		),
	});
	if (discount > 0) {
		tiles.push({
			key: 'discount',
			title: i18n._(SPECIAL_DISCOUNTS_IN_SHOP_DESCRIPTOR),
			body: i18n._(DISCOUNT_BODY_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME}),
			active: ShopCatalog.premiumDiscount,
			art: () => <PerkVideo src={discountVideoUrl} poster={discountPosterUrl} />,
		});
	}
	const legend = TYPE_TILES.flatMap((type) => {
		const item = included.get(type);
		return item
			? [{type, text: i18n._(WORN_ITEM_DESCRIPTOR, {type: i18n._(COSMETIC_TYPE_LABELS[type]), name: item.name})}]
			: [];
	});
	return (
		<div className={styles.section} data-flx="premium.premium-perk-tiles.section">
			<div className={styles.head} data-flx="premium.premium-perk-tiles.head">
				<h2 className={styles.heading} data-flx="premium.premium-perk-tiles.heading">
					{i18n._(HEADING_DESCRIPTOR)}
				</h2>
				<p className={styles.lead} data-flx="premium.premium-perk-tiles.lead">
					{i18n._(LEAD_DESCRIPTOR)}
				</p>
			</div>
			<div className={styles.showcase} data-flx="premium.premium-perk-tiles.showcase">
				<div className={styles.profile} data-flx="premium.premium-perk-tiles.profile">
					<ProfilePreview
						user={previewUser}
						previewProfileEffect={previewEffect}
						showMembershipInfo={false}
						showMessageButton={false}
						showPreviewLabel={false}
						data-flx="premium.premium-perk-tiles.profile-preview"
					/>
					{legend.length > 0 && (
						<ul className={styles.legend} data-flx="premium.premium-perk-tiles.legend">
							{legend.map(({type, text}) => (
								<li
									key={type}
									className={styles.legendItem}
									data-type={type}
									data-flx="premium.premium-perk-tiles.legend-item"
								>
									{text}
								</li>
							))}
						</ul>
					)}
				</div>
				<div className={styles.tiles} data-flx="premium.premium-perk-tiles.tiles">
					{tiles.map(({key, ...tile}) => (
						<PerkTile key={key} {...tile} data-flx="premium.premium-perk-tiles.perk-tile" />
					))}
				</div>
			</div>
			<p className={styles.more} data-flx="premium.premium-perk-tiles.more">
				<FocusRing offset={-2} data-flx="premium.premium-perk-tiles.shop-link.focus-ring">
					<button
						type="button"
						className={styles.moreLink}
						onClick={openShop}
						data-flx="premium.premium-perk-tiles.shop-link.click"
					>
						{i18n._(SEE_ULTRA_IN_SHOP_DESCRIPTOR)}
					</button>
				</FocusRing>
			</p>
		</div>
	);
});
