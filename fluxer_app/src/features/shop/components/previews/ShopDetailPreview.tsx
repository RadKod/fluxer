// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {DECORATION_SCALE} from '@app/features/cosmetics/constants/AvatarDecorationGeometry';
import styles from '@app/features/shop/components/modals/ShopItemDetailModal.module.css';
import {ShopMemberRowPreview} from '@app/features/shop/components/previews/ShopMemberRowPreview';
import {ShopMessagePreview} from '@app/features/shop/components/previews/ShopMessagePreview';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {PROFILE_CARD_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {previewUserForSurface} from '@app/features/shop/utils/ShopPreviewUser';
import {shopStageLayout} from '@app/features/shop/utils/ShopStageLayout';
import {
	detailSurfacesFor,
	isShopCosmeticType,
	SHOP_SURFACES,
	type ShopSurface,
} from '@app/features/shop/utils/ShopSurfaces';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {
	PROFILE_POPOUT_GEOMETRY as G,
	getProfileAvatarDecorationBounds,
} from '@app/features/user/constants/UserProfileSurfaceGeometry';
import type {User} from '@app/features/user/models/User';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {type CSSProperties, useEffect, useState} from 'react';

const CHAT_DESCRIPTOR = msg({message: 'Chat', comment: 'Label of the chat message preview in the shop detail dialog.'});
const MEMBER_LIST_DESCRIPTOR = msg({
	message: 'Member list',
	comment: 'Label of the member list preview in the shop detail dialog.',
});
const HOW_IT_LOOKS_DESCRIPTOR = msg({
	message: 'How it looks on you',
	comment: 'Heading above personal previews of a shop item or bundle.',
});
const SURFACE_LABELS = {profile: PROFILE_CARD_DESCRIPTOR, chat: CHAT_DESCRIPTOR, member_list: MEMBER_LIST_DESCRIPTOR};

// Each mounted surface keeps its props while the next one appears, avoiding repeated profile work.
const SurfacePreview = observer(function SurfacePreview({
	surface,
	items,
	user,
}: {
	surface: Exclude<ShopSurface, 'voice'>;
	items: ReadonlyArray<CosmeticItemResponse>;
	user: User;
}) {
	if (surface === 'profile')
		return (
			<ShopItemStage
				items={items.filter((item) => isShopCosmeticType(item.type) && SHOP_SURFACES[item.type].includes('profile'))}
				size="full"
				data-flx="shop.previews.shop-detail-preview.surface-preview.shop-item-stage"
			/>
		);
	if (surface === 'member_list')
		return (
			<div className={styles.memberList} data-flx="shop.previews.shop-detail-preview.surface-preview.member-list">
				<ShopMemberRowPreview
					user={previewUserForSurface(user, surface, items)}
					data-flx="shop.previews.shop-detail-preview.surface-preview.shop-member-row-preview"
				/>
			</div>
		);
	return (
		<ShopMessagePreview
			user={previewUserForSurface(user, surface, items)}
			data-flx="shop.previews.shop-detail-preview.surface-preview.shop-message-preview"
		/>
	);
});

export const ShopDetailPreview = observer(function ShopDetailPreview({
	items,
	user,
}: {
	items: ReadonlyArray<CosmeticItemResponse>;
	user: User;
}) {
	const {i18n} = useLingui();
	const surfaces = detailSurfacesFor(items.map((item) => item.type));
	const [drawnCount, setDrawnCount] = useState(0);
	useEffect(() => {
		if (drawnCount >= surfaces.length) return;
		// Two frame boundaries leave a painted skeleton before the next finite surface mount.
		let frame = window.requestAnimationFrame(() => {
			frame = window.requestAnimationFrame(() => setDrawnCount((count) => count + 1));
		});
		return () => window.cancelAnimationFrame(frame);
	}, [drawnCount, surfaces.length]);
	return (
		<div className={styles.preview} aria-busy={drawnCount < surfaces.length} data-flx="shop.shop-detail-preview.panel">
			<h2 className={styles.previewTitle} data-flx="shop.previews.shop-detail-preview.preview-title">
				{i18n._(HOW_IT_LOOKS_DESCRIPTOR)}
			</h2>
			{surfaces.map((surface, index) => (
				<section
					key={surface}
					className={styles.surface}
					data-surface={surface}
					style={
						surface === 'profile'
							? profilePreviewMinimum(previewUserForSurface(user, surface, items))
							: compactPreviewPadding(previewUserForSurface(user, surface, items), surface === 'member_list' ? 32 : 40)
					}
					data-pending={index >= drawnCount || undefined}
					data-flx="shop.previews.shop-detail-preview.surface"
				>
					<h3 className={styles.surfaceLabel} data-flx="shop.previews.shop-detail-preview.surface-label">
						{i18n._(SURFACE_LABELS[surface])}
					</h3>
					<div className={styles.surfaceBody} data-flx="shop.previews.shop-detail-preview.surface-body">
						{index < drawnCount && (
							<SurfacePreview
								surface={surface}
								items={items}
								user={user}
								data-flx="shop.previews.shop-detail-preview.surface-preview"
							/>
						)}
					</div>
				</section>
			))}
		</div>
	);
});

// Both compact ultra layers use the decoration box, regardless of their profile layout or front asset.
function compactPreviewPadding(user: User, size: number): CSSProperties {
	const overhang = user.avatarDecoration || user.avatarUltra ? ((DECORATION_SCALE - 1) * size) / 2 : 0;
	return {
		'--preview-overhang-top': remFromPx(overhang),
		'--preview-overhang-bottom': remFromPx(overhang),
		'--preview-message-group-spacing': remFromPx(Accessibility.getMessageGroupSpacingValue(false)),
	} as CSSProperties;
}

// Preserve the existing skeleton base and add only the banner growth caused by this decoration.
function profilePreviewMinimum(user: User): CSSProperties {
	const bounds = getProfileAvatarDecorationBounds(user, G.avatarSizePx, G.avatarBorderPx);
	const avatarTop = Math.max(G.avatarTopPx, -G.avatarBorderPx - bounds.top);
	const growth = Math.max(0, avatarTop + G.avatarBorderPx + bounds.bottom - G.headerHeightPx);
	const layout = shopStageLayout(user, 'full');
	return {
		'--preview-profile-growth': remFromPx(growth),
		'--preview-profile-width': remFromPx(layout.width),
		'--preview-profile-scale': layout.scale,
	} as CSSProperties;
}
