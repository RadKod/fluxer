// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/premium/components/PremiumFloatingBuy.module.css';
import {PremiumHalo} from '@app/features/premium/components/PremiumHalo';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {Button} from '@app/features/ui/button/Button';
import {CrownIcon} from '@phosphor-icons/react';
import type React from 'react';
import {useEffect, useState} from 'react';

interface PremiumFloatingBuyProps {
	// The hero's buy buttons (or the status box); while they show, the capsule hides.
	heroRef: React.RefObject<HTMLElement | null>;
	// The plans; while one of their buttons shows below the top third, the capsule hides.
	plansRef: React.RefObject<HTMLElement | null>;
	label: string;
	onClick: () => void;
}

// Micup: the "Buy Premium" capsule floating at the bottom of the premium page between the hero and the plans, and
// again past the plans. The page mounts it only while premium is on sale.
export function PremiumFloatingBuy({heroRef, plansRef, label, onClick}: PremiumFloatingBuyProps) {
	const [visible, setVisible] = useState(false);
	// A catalog refresh can redraw the plan buttons (the page re-renders on it): the observers then watch the new ones.
	const packages = ShopCatalog.packageEntries;
	useEffect(() => {
		const hero = heroRef.current;
		if (!hero) return;
		const showing = new Set<Element>();
		const update = (entries: Array<IntersectionObserverEntry>) => {
			for (const entry of entries) {
				if (entry.isIntersecting) showing.add(entry.target);
				else showing.delete(entry.target);
			}
			setVisible(showing.size === 0);
		};
		const heroObserver = new IntersectionObserver(update);
		heroObserver.observe(hero);
		// Plan buttons scrolled into the top third no longer count, so the capsule returns past the plans.
		const plansObserver = new IntersectionObserver(update, {rootMargin: '-35% 0px 0px 0px'});
		for (const button of plansRef.current?.querySelectorAll('button') ?? []) plansObserver.observe(button);
		return () => {
			heroObserver.disconnect();
			plansObserver.disconnect();
		};
	}, [heroRef, plansRef, packages]);
	return (
		<div
			className={styles.capsule}
			data-visible={visible}
			inert={!visible}
			aria-hidden={!visible}
			data-flx="premium.premium-floating-buy.capsule"
		>
			<PremiumHalo size="large" className={styles.halo} data-flx="premium.premium-floating-buy.halo">
				<Button
					leftIcon={<CrownIcon weight="fill" aria-hidden="true" data-flx="premium.premium-floating-buy.icon" />}
					onClick={onClick}
					data-flx="premium.premium-floating-buy.button.click"
				>
					{label}
				</Button>
			</PremiumHalo>
		</div>
	);
}
