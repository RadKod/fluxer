// SPDX-License-Identifier: AGPL-3.0-or-later

import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import styles from '@app/features/shop/components/ShopSetArt.module.css';
import type {ShopBundleEntry} from '@app/features/shop/utils/ShopEntries';
import {TAKE_ME_THERE_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {openShopSet} from '@app/features/shop/utils/ShopSetNavigation';
import {shopSetArtKey} from '@app/features/shop/utils/ShopSets';
import {Button} from '@app/features/ui/button/Button';
import anaUrl from '@app/media/images/shop/sets/ana.webp';
import anaSmallUrl from '@app/media/images/shop/sets/ana-1200.webp';
import angelWingsUrl from '@app/media/images/shop/sets/angel-wings.webp';
import angelWingsSmallUrl from '@app/media/images/shop/sets/angel-wings-1200.webp';
import karaEjderUrl from '@app/media/images/shop/sets/kara-ejder.webp';
import karaEjderSmallUrl from '@app/media/images/shop/sets/kara-ejder-1200.webp';
import kediUrl from '@app/media/images/shop/sets/kedi.webp';
import kediSmallUrl from '@app/media/images/shop/sets/kedi-1200.webp';
import kuzgunUrl from '@app/media/images/shop/sets/kuzgun.webp';
import kuzgunSmallUrl from '@app/media/images/shop/sets/kuzgun-1200.webp';
import neonUrl from '@app/media/images/shop/sets/neon.webp';
import neonSmallUrl from '@app/media/images/shop/sets/neon-1200.webp';
import sakuraUrl from '@app/media/images/shop/sets/sakura.webp';
import sakuraSmallUrl from '@app/media/images/shop/sets/sakura-1200.webp';
import sonbaharUrl from '@app/media/images/shop/sets/sonbahar.webp';
import sonbaharSmallUrl from '@app/media/images/shop/sets/sonbahar-1200.webp';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {useId} from 'react';

// Each art at 1200 and 2400 px wide.
type ArtSources = readonly [small: string, large: string];

// TEMPORARY: art shipped with the client, by shopSetArtKey (see there for the target and when to move).
const SET_ART: Partial<Record<string, ArtSources>> = {
	'angel-wings': [angelWingsSmallUrl, angelWingsUrl],
	kuzgun: [kuzgunSmallUrl, kuzgunUrl],
	sakura: [sakuraSmallUrl, sakuraUrl],
	sonbahar: [sonbaharSmallUrl, sonbaharUrl],
	neon: [neonSmallUrl, neonUrl],
	kedi: [kediSmallUrl, kediUrl],
	'kara-ejder': [karaEjderSmallUrl, karaEjderUrl],
};
// The shop's own art, behind the front page's featured set.
const FRONT_ART: ArtSources = [anaSmallUrl, anaUrl];

// The item that stands for the set when it has no art: wings first, then a decoration, an effect, a nameplate.
const STAND_IN_RANK: Record<CosmeticItemResponse['type'], number> = {
	avatar_ultra: 0,
	avatar_decoration: 1,
	profile_effect: 2,
	nameplate: 3,
};

function standInImage(items: ReadonlyArray<CosmeticItemResponse>): string | null {
	const item = [...items].sort((a, b) => STAND_IN_RANK[a.type] - STAND_IN_RANK[b.type])[0];
	if (!item) return null;
	return getCosmeticAssetURL(item.type, {asset: item.asset, item_id: item.id}, 256, false) || null;
}

interface ShopSetArtProps {
	entry: ShopBundleEntry;
	// The front page shows the shop's own art behind its featured set.
	front?: boolean;
	// The page's top art loads first; a tile's waits until it is near.
	priority?: boolean;
	// How wide the art is drawn, for picking the 1200 or 2400 px file.
	sizes?: string;
	className?: string;
}

// The set's illustration, or a stand-in built from its own items: one of them enlarged and blurred under a wash of
// the page's colours. Decorative: the set's name is always written beside it.
export function ShopSetArt({entry, front = false, priority = false, sizes = '100vw', className}: ShopSetArtProps) {
	const key = shopSetArtKey(entry.bundle.name);
	const art = front ? FRONT_ART : key ? SET_ART[key] : undefined;
	const src = art ? art[1] : standInImage(entry.bundle.items);
	return (
		<div
			className={clsx(styles.art, className)}
			data-stand-in={art ? undefined : true}
			aria-hidden
			data-flx="shop.shop-set-art.art"
		>
			{src && (
				<img
					className={styles.image}
					src={src}
					srcSet={art ? `${art[0]} 1200w, ${art[1]} 2400w` : undefined}
					sizes={art ? sizes : undefined}
					alt=""
					loading={priority ? 'eager' : 'lazy'}
					fetchPriority={priority ? 'high' : 'auto'}
					decoding="async"
					draggable={false}
					data-flx="shop.shop-set-art.image"
				/>
			)}
		</div>
	);
}

// A set on the shop's front page: its art, its name and a button to its page.
export function ShopSetTile({entry}: {entry: ShopBundleEntry}) {
	const {i18n} = useLingui();
	const titleId = useId();
	return (
		<section className={styles.tile} aria-labelledby={titleId} data-flx="shop.shop-set-art.tile">
			<ShopSetArt entry={entry} sizes="50vw" className={styles.tileArt} data-flx="shop.shop-set-art.shop-set-art" />
			<ShopItemStage
				items={entry.bundle.items}
				size="grid"
				composed
				animateNameplate={false}
				data-flx="shop.shop-set-art.shop-item-stage"
			/>
			<h2 id={titleId} className={styles.tileTitle} data-flx="shop.shop-set-art.tile-title">
				{entry.bundle.name}
			</h2>
			<Button
				variant="inverted"
				className={styles.tileButton}
				onClick={() => openShopSet(entry.bundle.id)}
				data-shop-set-opener={entry.bundle.id}
				data-flx="shop.shop-set-art.button.take-me-there"
			>
				{i18n._(TAKE_ME_THERE_DESCRIPTOR)}
			</Button>
		</section>
	);
}
