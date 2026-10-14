// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {ShopBundleBuyButton, ShopBundleCard} from '@app/features/shop/components/ShopBundleCard';
import {ShopItemCard} from '@app/features/shop/components/ShopItemCard';
import {ShopSetArt} from '@app/features/shop/components/ShopSetArt';
import styles from '@app/features/shop/components/ShopTab.module.css';
import type {ShopCollection} from '@app/features/shop/utils/ShopCollections';
import type {ShopBundleEntry} from '@app/features/shop/utils/ShopEntries';
import {
	BROWSE_ALL_DESCRIPTOR,
	BUY_COLLECTION_DESCRIPTOR,
	SHOP_BREADCRUMB_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {leaveShopSet} from '@app/features/shop/utils/ShopSetNavigation';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import Modal from '@app/features/ui/state/Modal';
import {useLingui} from '@lingui/react/macro';
import {useEffect, useLayoutEffect, useRef} from 'react';

function browseAll(): void {
	RouterUtils.transitionTo(Routes.SHOP);
}

function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
	);
}

interface ShopSetViewProps {
	// A collection that is a set: its bundle and the items it holds.
	collection: ShopCollection & {bundle: ShopBundleEntry};
}

// One set's page: the breadcrumb back to the shop over the set's art, its bundles as wide cards and its items as
// square cards. Escape steps back to the shop, unless a dialog or a field has it; the breadcrumb is a link to it.
export function ShopSetView({collection}: ShopSetViewProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const {bundle} = collection;
	const bundleId = bundle.bundle.id;
	// A set opens at the top of the page with the focus on its heading, where the button that opened it was. Only the
	// page's own scroller moves (scrollIntoView would move the app too).
	useLayoutEffect(() => {
		let scroller = rootRef.current?.parentElement;
		while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
		scroller?.scrollTo({top: 0});
		headingRef.current?.focus({preventScroll: true});
	}, [bundleId]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented || Modal.hasModalOpen() || isTyping(event.target)) return;
			leaveShopSet(bundleId);
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [bundleId]);
	const bundles = collection.entries.filter((entry) => entry.kind === 'bundle');
	const items = collection.entries.filter((entry) => entry.kind === 'item');
	return (
		<div ref={rootRef} className={styles.setPage} data-flx="shop.shop-set-view.page">
			<ShopSetArt entry={bundle} priority className={styles.backdrop} data-flx="shop.shop-set-view.shop-set-art" />
			<nav
				className={styles.breadcrumb}
				aria-label={i18n._(SHOP_BREADCRUMB_DESCRIPTOR)}
				data-flx="shop.shop-set-view.nav"
			>
				<FocusRing offset={-2} data-flx="shop.shop-set-view.focus-ring">
					<button
						type="button"
						className={styles.breadcrumbLink}
						onClick={browseAll}
						data-flx="shop.shop-set-view.breadcrumb-link.browse-all"
					>
						{i18n._(BROWSE_ALL_DESCRIPTOR)}
					</button>
				</FocusRing>
				<span className={styles.breadcrumbSeparator} aria-hidden data-flx="shop.shop-set-view.breadcrumb-separator">
					/
				</span>
				<span className={styles.breadcrumbCurrent} aria-current="page" data-flx="shop.shop-set-view.breadcrumb-current">
					{bundle.bundle.name}
				</span>
			</nav>
			<div className={styles.sectionHead} data-hero data-flx="shop.shop-set-view.head">
				<h1 ref={headingRef} tabIndex={-1} className={styles.sectionTitle} data-flx="shop.shop-set-view.title">
					{bundle.bundle.name}
				</h1>
				<ShopBundleBuyButton
					entry={bundle}
					variant="inverted"
					label={BUY_COLLECTION_DESCRIPTOR}
					data-flx="shop.shop-set-view.shop-bundle-buy-button"
				/>
			</div>
			{bundles.length > 0 && (
				<div className={styles.bundleGrid} role="list" data-flx="shop.shop-set-view.bundle-grid">
					{bundles.map((entry) => (
						<ShopBundleCard key={entry.sku} entry={entry} opensDetails data-flx="shop.shop-set-view.shop-bundle-card" />
					))}
				</div>
			)}
			{items.length > 0 && (
				<div className={styles.itemGrid} role="list" data-flx="shop.shop-set-view.item-grid">
					{items.map((entry) => (
						<ShopItemCard key={entry.sku} entry={entry} data-flx="shop.shop-set-view.shop-item-card" />
					))}
				</div>
			)}
		</div>
	);
}
