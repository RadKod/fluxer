// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {DMPageFrame, type DMPageTab} from '@app/features/channel/components/direct_message/DMPageFrame';
import {COSMETIC_TYPE_LABELS} from '@app/features/cosmetics/utils/CosmeticLabels';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {useSearch} from '@app/features/platform/components/router/RouterReact';
import styles from '@app/features/shop/components/pages/ShopPage.module.css';
import {ShopRedeemJumpButton} from '@app/features/shop/components/ShopRedeemField';
import {SHOP_TYPE_ORDER, type ShopFilter, ShopTab} from '@app/features/shop/components/ShopTab';
import {SHOP_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {SHOP_SET_QUERY} from '@app/features/shop/utils/ShopSets';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {StorefrontIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useId, useState} from 'react';

const ALL_DESCRIPTOR = msg({
	message: 'All',
	comment: 'Shop page type filter: every decoration type.',
});

// Micup: the shop beside the DM list (Routes.SHOP). The bar holds the type filter and "Redeem a code", which jumps to
// the code bar at the bottom of the page; the body lays itself out so the hero spans the full width. ?set=<bundle ID>
// opens that set's page; picking a filter there goes back to the whole shop.
export const ShopPage = observer(function ShopPage() {
	const {i18n} = useLingui();
	const [filter, setFilter] = useState<ShopFilter>('all');
	const setId = useSearch().get(SHOP_SET_QUERY);
	const changeFilter = (next: ShopFilter) => {
		setFilter(next);
		if (setId) RouterUtils.transitionTo(Routes.SHOP);
	};
	const redeemInputId = useId();
	const tabs: Array<DMPageTab<ShopFilter>> = [
		{key: 'all', label: i18n._(ALL_DESCRIPTOR)},
		...SHOP_TYPE_ORDER.map((type) => ({key: type, label: i18n._(COSMETIC_TYPE_LABELS[type])})),
	];
	return (
		<DMPageFrame<ShopFilter>
			icon={StorefrontIcon}
			title={i18n._(SHOP_DESCRIPTOR)}
			tabs={tabs}
			activeTab={filter}
			onTabChange={changeFilter}
			action={
				RuntimeConfig.giftCodesEnabled && (
					<ShopRedeemJumpButton inputId={redeemInputId} data-flx="shop.shop-page.shop-redeem-jump-button" />
				)
			}
			bodyClassName={styles.body}
			data-flx="shop.shop-page.dm-page-frame"
		>
			<ShopTab filter={filter} redeemInputId={redeemInputId} setId={setId} data-flx="shop.shop-page.shop-tab" />
		</DMPageFrame>
	);
});
