// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {PREMIUM_PRODUCT_FULL_NAME, PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {DMPageFrame, type DMPageTab} from '@app/features/channel/components/direct_message/DMPageFrame';
import {PremiumCompareTable} from '@app/features/premium/components/PremiumCompareTable';
import {PremiumFloatingBuy} from '@app/features/premium/components/PremiumFloatingBuy';
import {PremiumPackages} from '@app/features/premium/components/PremiumPackages';
import {PremiumPerkTiles} from '@app/features/premium/components/PremiumPerkTiles';
import styles from '@app/features/premium/components/pages/PremiumPage.module.css';
import {PremiumHero, PremiumQuestions} from '@app/features/premium/components/pages/PremiumPageSections';
import {ShopRedeemJumpButton} from '@app/features/shop/components/ShopRedeemField';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {ADD_TIME_DESCRIPTOR, BUY_PREMIUM_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import Users from '@app/features/user/state/Users';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CrownIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useEffect, useId, useRef, useState} from 'react';

const HOME_DESCRIPTOR = msg({
	message: 'Home',
	comment: 'Tab at the top of the Plus page: jumps to the Plus overview with the account status.',
});
const PLANS_DESCRIPTOR = msg({
	message: 'Plans',
	comment: 'Tab at the top of the Plus page: jumps to the Plus packages (1, 3 and 12 months) to buy.',
});
const COMPARE_DESCRIPTOR = msg({
	message: 'Compare',
	comment: 'Tab at the top of the Plus page: jumps to the table comparing the free plan with Plus.',
});

type PremiumPageTab = 'home' | 'plans' | 'compare';

// A section counts as the one being read once its top passes a line 15% down the scroll area (about 120 px on a laptop
// screen). The observer's box runs from far above the page down to that line, so a section is inside it exactly while
// its top is above the line.
const READING_LINE_MARGIN = '100000px 0px -85% 0px';
// The user taking over the scroll ends a tab's reveal: the wheel, a touch, a key, or a press on the scrollbar (which
// also starts a middle-click autoscroll).
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

// Micup: self-hosted premium beside the DM list (Routes.PREMIUM): one long page under the bar, whose tabs jump to
// the hero, the comparison and the plans and follow the scroll. The sections' look lives in PremiumPageSections.
export const PremiumPage = observer(function PremiumPage() {
	const {i18n} = useLingui();
	const [tab, setTab] = useState<PremiumPageTab>('home');
	const scrollerRef = useRef<ScrollerHandle>(null);
	const homeRef = useRef<HTMLElement>(null);
	const compareRef = useRef<HTMLElement>(null);
	const plansRef = useRef<HTMLElement>(null);
	const packagesRef = useRef<HTMLDivElement>(null);
	const heroActionsRef = useRef<HTMLDivElement>(null);
	// While a tab's reveal runs, the sections it scrolls past do not take the tab's mark ('running'). Once it lands, its
	// own last scroll is skipped and the observer's report after it moves the mark ('landed'); a reveal that ends at the
	// end of the page, where its section may stop short of the line, keeps 'running' until the user takes over.
	const revealRef = useRef<'running' | 'landed' | null>(null);
	const codeInputId = useId();
	// The shop runs where premium goes through codes (mirror mode); its catalog says whether premium is on sale.
	const shopRuns = RuntimeConfig.giftCodesEnabled;
	useEffect(() => {
		if (shopRuns) void ShopCatalog.load();
	}, [shopRuns]);
	// With premium on sale, or packages priced and shown as paused, the page sells through the shop checkout.
	const onSale =
		shopRuns &&
		ShopCatalog.status === 'ready' &&
		(ShopCatalog.packageEntries.length > 0 || Boolean(ShopCatalog.settings?.premium_sales_open));
	const user = Users.currentUser;
	// A lifetime account has no plans to buy; sales open with no package priced would leave the section empty.
	const showPlans =
		onSale &&
		user?.premiumType !== UserPremiumTypes.LIFETIME &&
		(ShopCatalog.packageEntries.length > 0 || !ShopCatalog.settings?.premium_sales_open);
	const canBuyTime =
		showPlans && Boolean(ShopCatalog.settings?.premium_sales_open) && ShopCatalog.packageEntries.length > 0;
	// Set up again when the plans come or go. No layout is read on scroll: the observer keeps which tops are above the
	// line, and a scroll that crosses none (after the user took over from a reveal) moves the mark from that.
	useEffect(() => {
		const viewport = scrollerRef.current?.getViewportElement();
		if (!viewport) return;
		// In page order; a section that is not drawn has no node and never counts.
		const targets = [
			['home', homeRef.current],
			['compare', compareRef.current],
			['plans', plansRef.current],
		] as const;
		const above = new Set<Element>();
		const follow = () => {
			if (revealRef.current) return;
			let reading: PremiumPageTab = 'home';
			for (const [key, node] of targets) {
				if (node && above.has(node)) reading = key;
			}
			setTab(reading);
		};
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) above.add(entry.target);
					else above.delete(entry.target);
				}
				follow();
			},
			{root: viewport, rootMargin: READING_LINE_MARGIN},
		);
		for (const [, node] of targets) {
			if (node) observer.observe(node);
		}
		const onScroll = () => {
			if (revealRef.current === 'landed') {
				revealRef.current = null;
				return;
			}
			follow();
		};
		const release = () => {
			revealRef.current = null;
		};
		viewport.addEventListener('scroll', onScroll, {passive: true});
		for (const type of USER_SCROLL_EVENTS) viewport.addEventListener(type, release, {passive: true});
		return () => {
			observer.disconnect();
			viewport.removeEventListener('scroll', onScroll);
			for (const type of USER_SCROLL_EVENTS) viewport.removeEventListener(type, release);
		};
	}, [showPlans]);
	const reveal = (key: PremiumPageTab, node: HTMLElement | null) => {
		if (!node) return;
		setTab(key);
		const scroller = scrollerRef.current;
		// Nothing scrolls without the scroller, so nothing holds the mark.
		if (!scroller) return;
		revealRef.current = 'running';
		scroller.revealElement({
			node,
			alignment: 'start',
			animate: Accessibility.useSmoothScrolling,
			callback: () => {
				// The scroller's own end (it clamps to scrollHeight − offsetHeight).
				const viewport = scroller.getViewportElement();
				const atEnd = !viewport || viewport.scrollHeight - viewport.offsetHeight - viewport.scrollTop <= 1;
				if (revealRef.current === 'running' && !atEnd) revealRef.current = 'landed';
			},
		});
	};
	const sectionOf = {home: homeRef, compare: compareRef, plans: plansRef};
	const goToPlans = () => {
		reveal('plans', plansRef.current);
		packagesRef.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
	};
	const tabs: Array<DMPageTab<PremiumPageTab>> = [
		{key: 'home', label: i18n._(HOME_DESCRIPTOR)},
		...(showPlans ? [{key: 'plans' as const, label: i18n._(PLANS_DESCRIPTOR)}] : []),
		{key: 'compare', label: i18n._(COMPARE_DESCRIPTOR)},
	];
	const activeTab = tab === 'plans' && !showPlans ? 'home' : tab;
	const isPremium = user?.isPremium() ?? false;
	return (
		<DMPageFrame
			icon={CrownIcon}
			title={PREMIUM_PRODUCT_FULL_NAME}
			tabs={tabs}
			tabsMode="anchor"
			activeTab={activeTab}
			onTabChange={(key) => reveal(key, sectionOf[key].current)}
			action={shopRuns && <ShopRedeemJumpButton inputId={codeInputId} data-flx="premium.premium-page.redeem-jump" />}
			bodyClassName={styles.page}
			scrollerRef={scrollerRef}
			data-flx="premium.premium-page.dm-page-frame"
		>
			<PremiumHero
				sectionRef={homeRef}
				actionsRef={heroActionsRef}
				onBuy={canBuyTime ? goToPlans : null}
				data-flx="premium.premium-page.premium-hero"
			/>
			{onSale && (
				<section
					className={clsx(styles.section, styles.perks)}
					data-section="perks"
					data-flx="premium.premium-page.perks"
				>
					<PremiumPerkTiles data-flx="premium.premium-page.perk-tiles" />
				</section>
			)}
			<section
				ref={compareRef}
				className={clsx(styles.section, styles.compare)}
				data-section="compare"
				data-flx="premium.premium-page.compare"
			>
				<PremiumCompareTable data-flx="premium.premium-page.compare-table" />
			</section>
			{showPlans && (
				<section
					ref={plansRef}
					className={clsx(styles.section, styles.plans)}
					data-section="plans"
					data-flx="premium.premium-page.plans"
				>
					<PremiumPackages
						sectionRef={packagesRef}
						codeInputId={codeInputId}
						data-flx="premium.premium-page.packages"
					/>
				</section>
			)}
			<section className={clsx(styles.section, styles.faq)} data-section="faq" data-flx="premium.premium-page.faq">
				<PremiumQuestions codeInputId={shopRuns ? codeInputId : null} data-flx="premium.premium-page.questions" />
			</section>
			{canBuyTime && (
				<PremiumFloatingBuy
					heroRef={heroActionsRef}
					plansRef={packagesRef}
					label={
						isPremium
							? i18n._(ADD_TIME_DESCRIPTOR)
							: i18n._(BUY_PREMIUM_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})
					}
					onClick={goToPlans}
					data-flx="premium.premium-page.floating-buy"
				/>
			)}
		</DMPageFrame>
	);
});
