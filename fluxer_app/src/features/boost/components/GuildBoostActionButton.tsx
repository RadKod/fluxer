// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import GuildBoosts from '@app/features/boost/state/GuildBoosts';
import {GET_PREMIUM_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {shouldShowPremiumFeatures} from '@app/features/premium/utils/PremiumUtils';
import {Button} from '@app/features/ui/button/Button';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const BOOST_COMMUNITY_DESCRIPTOR = msg({
	message: 'Boost this community',
	comment: 'Button that assigns one of your free boost slots to this community.',
});

export const GuildBoostActionButton = observer(({acting, onBoost}: {acting: boolean; onBoost: () => Promise<void>}) => {
	const {i18n} = useLingui();
	const hasFreeSlot = GuildBoosts.hasFreeSlot;
	if (!hasFreeSlot && !shouldShowPremiumFeatures()) return null;
	return (
		<Button small submitting={acting} onClick={onBoost} data-flx="boost.action.button">
			{hasFreeSlot
				? i18n._(BOOST_COMMUNITY_DESCRIPTOR)
				: i18n._(GET_PREMIUM_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
		</Button>
	);
});
