// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import styles from '@app/features/shop/components/ShopEquippedSuccess.module.css';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {
	BUNDLE_ITEMS_YOURS_DESCRIPTOR,
	EQUIPPED_SUCCESS_DESCRIPTOR,
	NOW_ON_YOUR_PROFILE_DESCRIPTOR,
	PREMIUM_ACTIVE_DESCRIPTOR,
	UNTIL_DATE_DESCRIPTOR,
	YOU_ARE_A_VISIONARY_DESCRIPTOR,
	YOU_ARE_VISIONARY_NUMBER_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {getFormattedFullDate} from '@app/features/user/utils/DateFormatting';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {useLingui} from '@lingui/react/macro';
import {CheckCircleIcon, CrownIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

export type ShopEquippedSuccessResult =
	| {kind: 'item'; item: CosmeticItemResponse}
	| {kind: 'bundle'; name: string; items: Array<CosmeticItemResponse>}
	| {kind: 'premium'; premiumUntil: string | null}
	| {kind: 'visionary'; number: number | null};

interface ShopEquippedSuccessProps {
	result: ShopEquippedSuccessResult;
}

// Takes focus when it appears, so the new state is announced.
const focusOnMount = (node: HTMLHeadingElement | null) => node?.focus();

// The success view of buying and of redeeming a code; the dialog around it owns the buttons.
export const ShopEquippedSuccess = observer<ShopEquippedSuccessProps>(({result}) => {
	const {i18n} = useLingui();
	let title: string;
	let body: string | null = null;
	switch (result.kind) {
		case 'item':
			title = i18n._(EQUIPPED_SUCCESS_DESCRIPTOR);
			body = i18n._(NOW_ON_YOUR_PROFILE_DESCRIPTOR, {name: result.item.name});
			break;
		case 'bundle':
			title = i18n._(EQUIPPED_SUCCESS_DESCRIPTOR);
			body = i18n._(BUNDLE_ITEMS_YOURS_DESCRIPTOR, {name: result.name});
			break;
		case 'premium':
			title = i18n._(PREMIUM_ACTIVE_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME});
			body = result.premiumUntil
				? i18n._(UNTIL_DATE_DESCRIPTOR, {date: getFormattedFullDate(result.premiumUntil)})
				: null;
			break;
		case 'visionary':
			title =
				result.number != null
					? i18n._(YOU_ARE_VISIONARY_NUMBER_DESCRIPTOR, {number: result.number})
					: i18n._(YOU_ARE_A_VISIONARY_DESCRIPTOR);
			break;
	}
	return (
		<div className={styles.success} role="status" data-flx="shop.shop-equipped-success.success">
			<div className={styles.visual} data-flx="shop.shop-equipped-success.visual">
				{result.kind === 'item' || result.kind === 'bundle' ? (
					<ShopItemStage
						items={result.kind === 'item' ? [result.item] : result.items}
						size="grid"
						data-flx="shop.shop-equipped-success.shop-item-stage"
					/>
				) : (
					<div className={styles.crownBox} data-flx="shop.shop-equipped-success.crown-box">
						<CrownIcon weight="fill" className={styles.crown} data-flx="shop.shop-equipped-success.crown" />
					</div>
				)}
				<CheckCircleIcon weight="fill" className={styles.check} data-flx="shop.shop-equipped-success.check" />
			</div>
			<h2 ref={focusOnMount} tabIndex={-1} className={styles.title} data-flx="shop.shop-equipped-success.title">
				{title}
			</h2>
			{body && (
				<p className={styles.body} data-flx="shop.shop-equipped-success.body">
					{body}
				</p>
			)}
			{result.kind === 'bundle' && (
				<ul className={styles.items} data-flx="shop.shop-equipped-success.items">
					{result.items.map((item) => (
						<li key={item.id} data-flx="shop.shop-equipped-success.item">
							{item.name}
						</li>
					))}
				</ul>
			)}
		</div>
	);
});
