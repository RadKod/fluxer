// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import styles from '@app/features/premium/components/PremiumCompareTable.module.css';
import {premiumBadgeUrl} from '@app/features/premium/utils/PremiumBadgeAsset';
import {getPremiumCompareGroups, type PremiumCompareCell} from '@app/features/premium/utils/PremiumCompareRows';
import {ShopPrice} from '@app/features/shop/components/ShopPrice';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {shownCents} from '@app/features/shop/utils/ShopPriceFormat';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon, XIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useId} from 'react';

const HEADING_DESCRIPTOR = msg({
	message: '{count, plural, one {# thing changes} other {# things change}} with {premiumProductName}',
	comment: 'Heading of the Plus page table comparing the free plan with Plus. {count} is its number of rows.',
});
const LEAD_DESCRIPTOR = msg({
	message: 'The free account and {premiumProductName} side by side, with the values the app itself uses.',
	comment: 'Line under the heading of the Plus page table comparing the free plan with Plus.',
});
const RECOMMENDED_DESCRIPTOR = msg({
	message: 'Recommended',
	comment: 'Pill above the Plus column of the Plus page comparison table, as on the recommended package.',
});
const PRICING_AND_FEATURES_DESCRIPTOR = msg({
	message: 'Pricing and features',
	comment: 'Top left heading of the Plus page table comparing the free plan with Plus.',
});
const FREE_DESCRIPTOR = msg({
	message: 'Free',
	comment: 'Column heading in the Plus page comparison table: the free plan.',
});
const FROM_PRICE_DESCRIPTOR = msg({
	message: 'From {price}',
	comment: 'Under the Plus column heading of the comparison table. {price} is the lowest package price, in TL or AZN.',
});
const BETA_DESCRIPTOR = msg({
	message: 'Beta',
	comment: 'Small chip beside a Plus perk in the comparison table: the feature is still being tried out.',
});
const BETA_NOTE_DESCRIPTOR = msg({
	message:
		'Features marked Beta are still being tried out. When an admin changes a limit, this page shows the new value.',
	comment: 'Note under the Plus page comparison table.',
});
const YES_DESCRIPTOR = msg({
	message: 'Yes',
	comment: 'Hidden text for screen readers on a check in the Plus comparison table: the plan has the perk.',
});
const NO_DESCRIPTOR = msg({
	message: 'No',
	comment: 'Hidden text for screen readers on a cross in the Plus comparison table: the plan lacks the perk.',
});

// Discord's plan comparison as one table: a group heading per group, the free
// column with a value or a cross, the premium column highlighted with a value or a check. Upstream
// FeatureComparisonTable stays as it is for the Stripe dialog.
export const PremiumCompareTable = observer(() => {
	const {i18n} = useLingui();
	const headingId = useId();
	const premiumItems = ShopCatalog.itemEntries.filter((entry) => entry.item.availability === 'premium');
	const groups = getPremiumCompareGroups(i18n, {
		hasIncludedDecorations: premiumItems.length > 0,
		shopDiscountPercent: ShopCatalog.settings?.premium_discount_percent ?? 0,
	});
	const count = groups.reduce((sum, group) => sum + group.rows.length, 0);
	// The start price follows a campaign; the catalog's clock moves when it ends, so a page left open drops it.
	const now = ShopCatalog.now();
	const lowest = ShopCatalog.packageEntries.reduce<number | null>((min, entry) => {
		const cents = shownCents(entry.price, now);
		return min === null || cents < min ? cents : min;
	}, null);
	const hasBeta = groups.some((group) => group.rows.some((row) => row.beta));
	const firstItem = premiumItems[0]?.item;
	const iconFor = (rowId: string): string | null =>
		rowId === 'profile_badge'
			? premiumBadgeUrl()
			: rowId === 'included_decorations' && firstItem
				? getCosmeticAssetURL(firstItem.type, {asset: firstItem.asset, item_id: firstItem.id}, 18, false)
				: null;
	const cell = (value: PremiumCompareCell, premium: boolean, flx: string) => (
		<td
			className={clsx(styles.cell, premium && styles.premium, value === false && styles.lacks)}
			data-flx={`premium.premium-compare-table.${flx}`}
		>
			{typeof value === 'string' ? (
				value
			) : (
				<>
					{value ? (
						<CheckIcon
							className={styles.mark}
							weight="bold"
							aria-hidden="true"
							data-flx="premium.premium-compare-table.check"
						/>
					) : (
						<XIcon
							className={styles.mark}
							weight="bold"
							aria-hidden="true"
							data-flx="premium.premium-compare-table.cross"
						/>
					)}
					<span className={styles.srOnly} data-flx="premium.premium-compare-table.mark-label">
						{i18n._(value ? YES_DESCRIPTOR : NO_DESCRIPTOR)}
					</span>
				</>
			)}
		</td>
	);
	return (
		<div className={styles.section} data-flx="premium.premium-compare-table.section">
			<div className={styles.head} data-flx="premium.premium-compare-table.head">
				<h2 id={headingId} className={styles.heading} data-flx="premium.premium-compare-table.heading">
					{i18n._(HEADING_DESCRIPTOR, {count, premiumProductName: PREMIUM_PRODUCT_NAME})}
				</h2>
				<p className={styles.lead} data-flx="premium.premium-compare-table.lead">
					{i18n._(LEAD_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
				</p>
			</div>
			<div className={styles.wrap} data-flx="premium.premium-compare-table.wrap">
				<div className={styles.highlight} aria-hidden="true" data-flx="premium.premium-compare-table.highlight">
					<span className={styles.ribbon} data-flx="premium.premium-compare-table.ribbon">
						{i18n._(RECOMMENDED_DESCRIPTOR)}
					</span>
				</div>
				<table className={styles.table} aria-labelledby={headingId} data-flx="premium.premium-compare-table.table">
					<colgroup data-flx="premium.premium-compare-table.colgroup">
						<col data-flx="premium.premium-compare-table.col" />
						<col className={styles.planColumn} data-flx="premium.premium-compare-table.plan-column" />
						<col className={styles.planColumn} data-flx="premium.premium-compare-table.plan-column--2" />
					</colgroup>
					<thead data-flx="premium.premium-compare-table.thead">
						<tr className={styles.headRow} data-flx="premium.premium-compare-table.head-row">
							<th scope="col" className={styles.corner} data-flx="premium.premium-compare-table.corner">
								{i18n._(PRICING_AND_FEATURES_DESCRIPTOR)}
							</th>
							<th scope="col" className={styles.plan} data-flx="premium.premium-compare-table.free-head">
								<span className={styles.planName} data-flx="premium.premium-compare-table.plan-name">
									{i18n._(FREE_DESCRIPTOR)}
								</span>
								{lowest !== null && (
									<span className={styles.planPrice} data-flx="premium.premium-compare-table.plan-price">
										<ShopPrice cents={0} primaryOnly />
									</span>
								)}
							</th>
							<th scope="col" className={styles.plan} data-flx="premium.premium-compare-table.premium-head">
								<span className={styles.planName} data-flx="premium.premium-compare-table.plan-name--2">
									<img
										className={styles.planBadge}
										src={premiumBadgeUrl()}
										alt=""
										width={20}
										height={20}
										data-flx="premium.premium-compare-table.plan-badge"
									/>
									{PREMIUM_PRODUCT_NAME}
								</span>
								{lowest !== null && (
									<span className={styles.planPrice} data-flx="premium.premium-compare-table.plan-price--2">
										<ShopPrice cents={lowest} label={FROM_PRICE_DESCRIPTOR} />
									</span>
								)}
							</th>
						</tr>
					</thead>
					{groups.map((group) => (
						<tbody key={group.id} data-flx="premium.premium-compare-table.group">
							<tr data-flx="premium.premium-compare-table.group-row">
								<th
									scope="rowgroup"
									colSpan={3}
									className={styles.groupHead}
									data-flx="premium.premium-compare-table.group-head"
								>
									{group.label}
								</th>
							</tr>
							{group.rows.map((row) => {
								const icon = iconFor(row.id);
								return (
									<tr key={row.id} className={styles.row} data-flx="premium.premium-compare-table.row">
										<th scope="row" className={styles.feature} data-flx="premium.premium-compare-table.feature">
											<span className={styles.featureName} data-flx="premium.premium-compare-table.feature-name">
												{row.label}
											</span>
											{row.beta && (
												<span className={styles.beta} data-flx="premium.premium-compare-table.beta">
													{i18n._(BETA_DESCRIPTOR)}
												</span>
											)}
											{icon && (
												<img
													className={styles.featureIcon}
													src={icon}
													alt=""
													width={18}
													height={18}
													loading="lazy"
													data-flx="premium.premium-compare-table.feature-icon"
												/>
											)}
										</th>
										{cell(row.free, false, 'free')}
										{cell(row.premium, true, 'premium')}
									</tr>
								);
							})}
						</tbody>
					))}
				</table>
			</div>
			{hasBeta && (
				<p className={styles.note} data-flx="premium.premium-compare-table.note">
					{i18n._(BETA_NOTE_DESCRIPTOR)}
				</p>
			)}
		</div>
	);
});
