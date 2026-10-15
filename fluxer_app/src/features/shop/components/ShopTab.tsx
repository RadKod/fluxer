// SPDX-License-Identifier: AGPL-3.0-or-later

import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import Cosmetics, {type CosmeticType, VISIBLE_COSMETIC_TYPES} from '@app/features/cosmetics/state/Cosmetics';
import UltraLayouts from '@app/features/cosmetics/state/UltraLayouts';
import {
	SOMETHING_WENT_WRONG_DESCRIPTOR,
	TRY_AGAIN_DESCRIPTOR,
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {ShopBundleBuyButton, ShopBundleCard} from '@app/features/shop/components/ShopBundleCard';
import {ShopCollectionSection} from '@app/features/shop/components/ShopCollectionSection';
import {ShopItemCard} from '@app/features/shop/components/ShopItemCard';
import {ShopRedeemField} from '@app/features/shop/components/ShopRedeemField';
import {ShopSetArt, ShopSetTile} from '@app/features/shop/components/ShopSetArt';
import {ShopSetView} from '@app/features/shop/components/ShopSetView';
import styles from '@app/features/shop/components/ShopTab.module.css';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {buildShopCollections, type ShopCollection} from '@app/features/shop/utils/ShopCollections';
import type {ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {
	BUY_COLLECTION_DESCRIPTOR,
	ITEM_SALES_PAUSED_NOTICE_DESCRIPTOR,
	NEW_ITEMS_SHOW_UP_HERE_DESCRIPTOR,
	NOTHING_ON_SALE_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {buildShopSetCollection, planShopFront} from '@app/features/shop/utils/ShopSets';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {InfoIcon, StorefrontIcon, WarningIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useId, useRef} from 'react';

const SKELETON_CARD_COUNT = 8;
const OTHER_COLLECTION_DESCRIPTOR = msg({
	message: 'Other',
	comment: 'Shop collection for items that do not belong to a bundle.',
});

export type ShopFilter = 'all' | CosmeticType;

// The page bar's filter order: ultras first. A new cosmetic type does not compile
// until it gets its place here.
const SHOP_TYPE_RANK = {
	avatar_ultra: 0,
	avatar_decoration: 1,
	nameplate: 2,
	profile_effect: 3,
} satisfies Record<CosmeticType, number>;
export const SHOP_TYPE_ORDER: ReadonlyArray<CosmeticType> = [...VISIBLE_COSMETIC_TYPES].sort(
	(a, b) => SHOP_TYPE_RANK[a] - SHOP_TYPE_RANK[b],
);

// The storefront rule: priced owned items and premium-included items. Free items and owned items
// without a price stay on the profile decorations tab, even for someone who has them.
function isOnDisplay({item, price}: ShopItemEntry): boolean {
	return item.availability === 'premium' || (item.availability === 'owned' && price !== null);
}

// Ultra sizes come with the catalog items and the bundles' items, so the stage draws them without asking again by ID.
function loadShop(force = false): void {
	void Cosmetics.load();
	void ShopCatalog.load(force).then(() =>
		UltraLayouts.prime([
			...ShopCatalog.itemEntries.map(({item}) => item),
			...ShopCatalog.bundleEntries.flatMap(({bundle}) => bundle.items),
		]),
	);
}

interface ShopTabProps {
	// The page bar's type filter.
	filter: ShopFilter;
	// The code bar's input, which the page bar's "Redeem a code" brings into view.
	redeemInputId: string;
	// The set whose page is open (its bundle ID), or null for the whole shop.
	setId: string | null;
}

// The shop page body: the featured set over its art, tiles to the next sets, the other collections as rows and the
// code bar last; or one set's page. The bar shows while the catalog loads, fails or is empty too,
// since a code is then the only way in.
export const ShopTab = observer(function ShopTab({filter, redeemInputId, setId}: ShopTabProps) {
	const {i18n} = useLingui();
	const collectionIdPrefix = useId();
	const pageRef = useRef<HTMLDivElement>(null);
	const shownSetId = useRef(setId);
	useEffect(() => loadShop(), []);
	// Back on the whole shop, the focus returns to the card or tile that opened the set.
	useEffect(() => {
		const left = shownSetId.current;
		shownSetId.current = setId;
		if (left === null || setId !== null) return;
		[...(pageRef.current?.querySelectorAll<HTMLElement>('[data-shop-set-opener]') ?? [])]
			.find((opener) => opener.dataset.shopSetOpener === left)
			?.focus();
	}, [setId]);
	const itemSalesClosed = ShopCatalog.settings?.item_sales_open === false;
	return (
		<div ref={pageRef} className={styles.page} data-flx="shop.shop-tab.page">
			<div className={styles.content} data-flx="shop.shop-tab.content">
				{itemSalesClosed && (
					<div className={styles.notice} data-flx="shop.shop-tab.notice">
						<InfoIcon className={styles.noticeIcon} aria-hidden data-flx="shop.shop-tab.notice-icon" />
						<span data-flx="shop.shop-tab.notice-text">{i18n._(ITEM_SALES_PAUSED_NOTICE_DESCRIPTOR)}</span>
					</div>
				)}
				<ShopCatalogView
					filter={filter}
					setId={setId}
					collectionIdPrefix={collectionIdPrefix}
					data-flx="shop.shop-tab.shop-catalog-view"
				/>
				{RuntimeConfig.giftCodesEnabled && (
					<ShopRedeemField variant="bar" inputId={redeemInputId} data-flx="shop.shop-tab.shop-redeem-field" />
				)}
			</div>
		</div>
	);
});

interface ShopCatalogViewProps {
	filter: ShopFilter;
	setId: string | null;
	collectionIdPrefix: string;
}

const ShopCatalogView = observer(function ShopCatalogView({filter, setId, collectionIdPrefix}: ShopCatalogViewProps) {
	const {i18n} = useLingui();
	if (ShopCatalog.status === 'failed' || Cosmetics.failed) {
		return (
			<StatusSlate
				Icon={WarningIcon}
				title={i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)}
				description={i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR)}
				actions={[{text: i18n._(TRY_AGAIN_DESCRIPTOR), onClick: () => loadShop(true)}]}
				data-flx="shop.shop-tab.error-status-slate"
			/>
		);
	}
	// Owned and worn items decide every card's button, so the grid waits for both.
	if (ShopCatalog.status !== 'ready' || !Cosmetics.ready) {
		return (
			<div className={styles.catalog} aria-busy data-flx="shop.shop-tab.catalog-loading">
				<div className={styles.grid} data-flx="shop.shop-tab.skeleton-grid">
					{Array.from({length: SKELETON_CARD_COUNT}, (_, index) => (
						<div key={index} className={styles.skeletonCard} data-flx="shop.shop-tab.skeleton-card">
							<div className={styles.skeletonLines} data-flx="shop.shop-tab.skeleton-lines">
								<span className={styles.skeletonName} data-flx="shop.shop-tab.skeleton-name" />
								<span className={styles.skeletonPrice} data-flx="shop.shop-tab.skeleton-price" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}
	const entries = ShopCatalog.itemEntries.filter(isOnDisplay);
	// A set that is no longer sold shows the whole shop instead.
	const set = setId ? ShopCatalog.bundleEntries.find((entry) => entry.bundle.id === setId) : undefined;
	if (set) {
		return <ShopSetView collection={buildShopSetCollection(set, entries)} data-flx="shop.shop-tab.shop-set-view" />;
	}
	const collections = buildShopCollections(entries, ShopCatalog.bundleEntries, filter);
	if (collections.length === 0) {
		return (
			<StatusSlate
				Icon={StorefrontIcon}
				title={i18n._(NOTHING_ON_SALE_DESCRIPTOR)}
				description={i18n._(NEW_ITEMS_SHOW_UP_HERE_DESCRIPTOR)}
				data-flx="shop.shop-tab.empty-status-slate"
			/>
		);
	}
	// The front page's layout is for the whole shop; a type filter shows its items as plain rows.
	const {featured, promos, rows} =
		filter === 'all' ? planShopFront(collections) : {featured: null, promos: [], rows: collections};
	const row = (collection: ShopCollection, hero = false) => (
		<ShopCollectionSection
			key={collection.id}
			id={collectionIdPrefix + collection.id}
			title={collection.bundle?.bundle.name ?? collection.series ?? i18n._(OTHER_COLLECTION_DESCRIPTOR)}
			hero={hero}
			action={
				collection.bundle && (
					<ShopBundleBuyButton
						entry={collection.bundle}
						variant={hero ? 'inverted' : 'secondary'}
						label={hero ? BUY_COLLECTION_DESCRIPTOR : undefined}
						data-flx="shop.shop-tab.shop-catalog-view.shop-bundle-buy-button"
					/>
				)
			}
			data-flx="shop.shop-tab.shop-catalog-view.shop-collection-section"
		>
			{collection.entries.map((entry) =>
				entry.kind === 'bundle' ? (
					<ShopBundleCard key={entry.sku} entry={entry} data-flx="shop.shop-tab.shop-catalog-view.shop-bundle-card" />
				) : (
					<ShopItemCard key={entry.sku} entry={entry} data-flx="shop.shop-tab.shop-catalog-view.shop-item-card" />
				),
			)}
		</ShopCollectionSection>
	);
	return (
		<div className={styles.catalog} data-flx="shop.shop-tab.catalog">
			{featured?.bundle && (
				<>
					<ShopSetArt
						entry={featured.bundle}
						front
						priority
						className={styles.backdrop}
						data-flx="shop.shop-tab.shop-set-art"
					/>
					{row(featured, true)}
				</>
			)}
			{promos.length > 0 && (
				<div className={styles.promos} data-flx="shop.shop-tab.promos">
					{promos.map(
						(collection) =>
							collection.bundle && (
								<ShopSetTile key={collection.id} entry={collection.bundle} data-flx="shop.shop-tab.shop-set-tile" />
							),
					)}
				</div>
			)}
			{rows.map((collection) => row(collection))}
		</div>
	);
});
