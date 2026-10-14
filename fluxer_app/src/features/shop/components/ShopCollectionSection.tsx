// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {NEXT_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {observeIntersection} from '@app/features/platform/utils/SharedIntersectionObserver';
import styles from '@app/features/shop/components/ShopTab.module.css';
import {Button} from '@app/features/ui/button/Button';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowLeftIcon, ArrowRightIcon} from '@phosphor-icons/react';
import {type ReactNode, useEffect, useId, useRef, useState} from 'react';

const PREVIOUS_DESCRIPTOR = msg({
	message: 'Previous',
	comment: 'Arrow button at the start of a shop row that scrolls it back by one page of cards.',
});

// How much of an end card the row must show for that end to count as reached.
const EDGE_IN_VIEW = 0.99;

export function ShopCollectionSection({
	id,
	title,
	action,
	hero = false,
	children,
}: {
	id?: string;
	title: string;
	// The featured set at the top of the page: the page's heading, over the set's art.
	hero?: boolean;
	// Beside the heading: the collection's own purchase, when it has one.
	action?: ReactNode;
	children: ReactNode;
}) {
	const {i18n} = useLingui();
	const headingId = useId();
	const rowRef = useRef<HTMLDivElement>(null);
	const Heading = hero ? 'h1' : 'h2';
	const [startInView, setStartInView] = useState(true);
	const [endInView, setEndInView] = useState(true);
	// One observer per row, rooted at the row and watching only its end cards, so no card measures anything. It runs
	// after every render, since a filter can swap the end cards while the count stays.
	useEffect(() => {
		const row = rowRef.current;
		const first = row?.firstElementChild;
		const last = row?.lastElementChild;
		if (!row || !first || !last || typeof IntersectionObserver === 'undefined') return;
		const options = {root: row, threshold: EDGE_IN_VIEW};
		const releaseStart = observeIntersection(
			first,
			(entry) => setStartInView(entry.intersectionRatio >= EDGE_IN_VIEW),
			options,
		);
		const releaseEnd = observeIntersection(
			last,
			(entry) => setEndInView(entry.intersectionRatio >= EDGE_IN_VIEW),
			options,
		);
		return () => {
			releaseStart();
			releaseEnd();
		};
	});
	// The arrows are for the pointer and stay out of the tab order: Tab walks the cards, which scroll into view, and an
	// arrow that leaves at its end would drop focus to the page.
	const page = (direction: 1 | -1) => {
		const row = rowRef.current;
		if (!row) return;
		const rtl = getComputedStyle(row).direction === 'rtl';
		row.scrollBy({
			left: direction * (rtl ? -1 : 1) * row.clientWidth,
			behavior: Accessibility.useSmoothScrolling ? 'smooth' : 'auto',
		});
	};
	return (
		<section
			id={id}
			className={styles.section}
			data-hero={hero || undefined}
			aria-labelledby={headingId}
			data-flx="shop.shop-tab.section"
		>
			<div className={styles.sectionHead} data-flx="shop.shop-tab.section-head">
				<Heading id={headingId} className={styles.sectionTitle} data-flx="shop.shop-tab.section-title">
					{title}
				</Heading>
				{action}
			</div>
			<div className={styles.rowFrame} data-flx="shop.shop-tab.row-frame">
				<div ref={rowRef} className={styles.collectionRow} role="list" data-flx="shop.shop-tab.grid">
					{children}
				</div>
				{!startInView && (
					<div className={styles.rowArrow} data-side="start" data-flx="shop.shop-tab.row-arrow">
						<Button
							square
							variant="secondary"
							icon={
								<ArrowLeftIcon
									className={styles.rowArrowIcon}
									weight="bold"
									aria-hidden
									data-flx="shop.shop-tab.row-previous-icon"
								/>
							}
							aria-label={i18n._(PREVIOUS_DESCRIPTOR)}
							tabIndex={-1}
							onClick={() => page(-1)}
							data-flx="shop.shop-tab.row-previous"
						/>
					</div>
				)}
				{!endInView && (
					<div className={styles.rowArrow} data-side="end" data-flx="shop.shop-tab.row-arrow--2">
						<Button
							square
							variant="secondary"
							icon={
								<ArrowRightIcon
									className={styles.rowArrowIcon}
									weight="bold"
									aria-hidden
									data-flx="shop.shop-tab.row-next-icon"
								/>
							}
							aria-label={i18n._(NEXT_DESCRIPTOR)}
							tabIndex={-1}
							onClick={() => page(1)}
							data-flx="shop.shop-tab.row-next"
						/>
					</div>
				)}
			</div>
		</section>
	);
}
