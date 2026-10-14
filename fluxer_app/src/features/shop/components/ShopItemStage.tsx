// SPDX-License-Identifier: AGPL-3.0-or-later

import {useNearViewport} from '@app/features/messaging/hooks/useNearViewport';
import {ShopMemberRowPreview} from '@app/features/shop/components/previews/ShopMemberRowPreview';
import styles from '@app/features/shop/components/ShopItemStage.module.css';
import {previewEffectFor, previewUserFor} from '@app/features/shop/utils/ShopPreviewUser';
import {shopStageLayout} from '@app/features/shop/utils/ShopStageLayout';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {Avatar} from '@app/features/ui/components/Avatar';
import {ProfilePreview} from '@app/features/user/components/profile/ProfilePreview';
import type {User} from '@app/features/user/models/User';
import Users from '@app/features/user/state/Users';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {observer} from 'mobx-react-lite';
import type {CSSProperties} from 'react';

interface ShopItemStageProps {
	// One item, or a bundle's items worn together.
	items: ReadonlyArray<CosmeticItemResponse>;
	size: 'grid' | 'full';
	// Whether stage cosmetics play: a grid card passes its hover, the dialogs leave them on.
	animateNameplate?: boolean;
	// A bundle's shop card: every item at once instead of one view (grid only).
	composed?: boolean;
}

// The stage's layout: wings anywhere in a bundle need the ultra band, only nameplates the member row.
function stageType(items: ReadonlyArray<CosmeticItemResponse>): string | undefined {
	if (items.some((item) => item.type === 'avatar_ultra')) return 'avatar_ultra';
	if (items.every((item) => item.type === 'nameplate')) return 'nameplate';
	return items[0]?.type;
}

// Grid avatar products use one real avatar; effects use the profile and nameplates the member row. Full previews
// use the real profile card. Grid content mounts near the viewport and stays inert; cosmetics follow card hover.
export const ShopItemStage = observer(function ShopItemStage({
	items,
	size,
	animateNameplate = true,
	composed = false,
}: ShopItemStageProps) {
	const grid = size === 'grid';
	const composition = grid && composed;
	const {ref, isNearViewport} = useNearViewport<HTMLDivElement>({disabled: !grid});
	const user = Users.currentUser;
	const previewUser = user && isNearViewport ? previewUserFor(user, ...items) : null;
	const type = stageType(items);
	const avatarOnly =
		grid && !composition && items.some((item) => item.type === 'avatar_ultra' || item.type === 'avatar_decoration');
	const layout =
		previewUser && (avatarOnly || (!grid && type !== 'nameplate')) ? shopStageLayout(previewUser, size) : undefined;
	return (
		<div
			ref={ref}
			className={styles.stage}
			data-type={type}
			data-size={size}
			data-composed={composition || undefined}
			data-ultra={(composition && items.some((item) => item.type === 'avatar_ultra')) || undefined}
			data-custom-layout={layout ? true : undefined}
			style={
				layout
					? ({
							'--natural-w': remFromPx(layout.width),
							'--natural-h': layout.height === undefined ? undefined : remFromPx(layout.height),
							'--card-x': remFromPx(layout.cardX),
							'--card-y': remFromPx(layout.cardY),
							'--stage-scale': layout.scale,
						} as CSSProperties)
					: undefined
			}
			data-flx="shop.shop-item-stage.stage"
		>
			{previewUser && (
				<div
					className={styles.natural}
					inert={grid}
					aria-hidden={grid || undefined}
					data-flx="shop.shop-item-stage.natural"
				>
					{composition ? (
						<BundleComposition
							items={items}
							user={user ?? previewUser}
							animate={animateNameplate}
							data-flx="shop.shop-item-stage.bundle-composition"
						/>
					) : avatarOnly ? (
						<div className={styles.card}>
							<Avatar user={previewUser} size={80} decorationSurface="profile" forceAnimate={animateNameplate} />
						</div>
					) : type === 'nameplate' ? (
						<div className={styles.memberColumn} data-flx="shop.shop-item-stage.member-column">
							<SkeletonRow data-flx="shop.shop-item-stage.skeleton-row" />
							<ShopMemberRowPreview
								user={previewUser}
								animateNameplate={animateNameplate}
								data-flx="shop.shop-item-stage.shop-member-row-preview"
							/>
							<SkeletonRow data-flx="shop.shop-item-stage.skeleton-row--2" />
						</div>
					) : (
						<div className={styles.card} data-flx="shop.shop-item-stage.card">
							<ProfilePreview
								user={previewUser}
								previewProfileEffect={previewEffectFor(...items)}
								showMembershipInfo={false}
								showMessageButton={false}
								showPreviewLabel={false}
								data-flx="shop.shop-item-stage.profile-preview"
							/>
						</div>
					)}
					{!grid && type !== 'nameplate' && items.some((item) => item.type === 'nameplate') && (
						<div className={styles.plateRow} data-flx="shop.shop-item-stage.plate-row">
							<ShopMemberRowPreview
								user={previewUser}
								animateNameplate={animateNameplate}
								data-flx="shop.shop-item-stage.shop-member-row-preview--2"
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
});

interface BundleCompositionProps {
	items: ReadonlyArray<CosmeticItemResponse>;
	user: User;
	animate: boolean;
}

// The avatar size of a chat message, where ultra wings have their natural size.
const ULTRA_CHAT_SIZE = 40;

// Slot order on a bundle card: avatar items, then nameplates, then profile effects.
const COMPOSITION_RANK: Record<CosmeticItemResponse['type'], number> = {
	avatar_ultra: 0,
	avatar_decoration: 0,
	nameplate: 1,
	profile_effect: 2,
};

// Every item of a bundle at once, each worn alone in its own slot and in the app's own preview: an avatar item on the
// avatar, a nameplate in a member row, an effect on the profile card. Two items of one type get two slots. The fewer
// the slots, the larger each part is drawn.
function BundleComposition({items, user, animate}: BundleCompositionProps) {
	const ordered = [...items].sort((a, b) => COMPOSITION_RANK[a.type] - COMPOSITION_RANK[b.type]);
	return (
		<div
			className={styles.composition}
			data-parts={ordered.length}
			data-ultra={items.some((item) => item.type === 'avatar_ultra') || undefined}
			data-flx="shop.shop-item-stage.composition"
		>
			{ordered.map((item) => (
				<div key={item.id} className={styles.compositionSlot} data-flx="shop.shop-item-stage.composition-slot">
					<CompositionPart item={item} user={user} animate={animate} />
				</div>
			))}
		</div>
	);
}

function CompositionPart({item, user, animate}: {item: CosmeticItemResponse; user: User; animate: boolean}) {
	const wearer = previewUserFor(user, item);
	switch (item.type) {
		case 'nameplate':
			return (
				<div className={styles.compositionPlate} data-flx="shop.shop-item-stage.composition-plate">
					<ShopMemberRowPreview
						user={wearer}
						animateNameplate={animate}
						data-flx="shop.shop-item-stage.composition-member-row-preview"
					/>
				</div>
			);
		case 'profile_effect':
			return (
				<div className={styles.compositionPanel} data-flx="shop.shop-item-stage.composition-panel">
					<ProfilePreview
						user={wearer}
						previewProfileEffect={previewEffectFor(item)}
						showMembershipInfo={false}
						showMessageButton={false}
						showPreviewLabel={false}
						data-flx="shop.shop-item-stage.composition-profile-preview"
					/>
				</div>
			);
	}
	// Ultra wings at their natural size, exactly as in chat (a 40 px avatar on the compact surface), never scaled: the
	// card makes room for them.
	if (item.type === 'avatar_ultra') {
		return (
			<div className={styles.compositionUltra} data-flx="shop.shop-item-stage.composition-ultra">
				<Avatar
					user={wearer}
					size={ULTRA_CHAT_SIZE}
					decorationSurface="compact"
					forceAnimate={animate}
					data-flx="shop.shop-item-stage.composition-ultra-image"
				/>
			</div>
		);
	}
	// An avatar decoration, on the avatar.
	return (
		<div className={styles.compositionAvatar} data-flx="shop.shop-item-stage.composition-avatar">
			<Avatar
				user={wearer}
				size={80}
				decorationSurface="profile"
				forceAnimate={animate}
				data-flx="shop.shop-item-stage.composition-avatar-image"
			/>
		</div>
	);
}

// A faint row above and below the user's own: no made-up people in the member list.
function SkeletonRow() {
	return (
		<div className={styles.skeletonRow} data-flx="shop.shop-item-stage.skeleton-row">
			<span className={styles.skeletonAvatar} data-flx="shop.shop-item-stage.skeleton-avatar" />
			<span className={styles.skeletonName} data-flx="shop.shop-item-stage.skeleton-name" />
		</div>
	);
}
