// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {BOT_SYSTEM_DESCRIPTOR} from '@app/features/bots/utils/BotMessageDescriptors';
import dmStyles from '@app/features/channel/components/direct_message/DirectMessageList.module.css';
import styles from '@app/features/channel/components/direct_message/DMListPageItems.module.css';
import {resolveSectionPagePath} from '@app/features/navigation/utils/FeedSectionPages';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {useLocation} from '@app/features/platform/components/router/RouterReact';
import * as PremiumModalCommands from '@app/features/premium/commands/PremiumModalCommands';
import HiddenPlutoniumButton from '@app/features/premium/state/HiddenPlutoniumButton';
import {getPremiumProductName, shouldShowPremiumFeatures} from '@app/features/premium/utils/PremiumUtils';
import {isShopPageAvailable} from '@app/features/shop/utils/ShopAvailability';
import {SHOP_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {HideIcon} from '@app/features/ui/action_menu/ContextMenuIcons';
import {MenuGroup} from '@app/features/ui/action_menu/MenuGroup';
import {MenuItem} from '@app/features/ui/action_menu/MenuItem';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Trans, useLingui} from '@lingui/react/macro';
import {CrownIcon, type Icon, RobotIcon, StorefrontIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

interface DMListPageRowProps {
	icon: Icon;
	label: string;
	selected: boolean;
	onClick: () => void;
	onContextMenu?: (event: React.MouseEvent) => void;
	accent?: boolean;
}

// Micup: one row of the DM list (Friends, Personal notes), also the rows of the feed sidebar.
export const DMListPageRow = ({
	icon: RowIcon,
	label,
	selected,
	onClick,
	onContextMenu,
	accent = false,
}: DMListPageRowProps) => (
	<FocusRing offset={-2} data-flx="channel.direct-message.dm-list-page-row.focus-ring">
		<button
			type="button"
			className={clsx(selected ? dmStyles.clickableItemSelected : dmStyles.clickableItem, accent && styles.accent)}
			onClick={onClick}
			onContextMenu={onContextMenu}
			aria-current={selected ? 'page' : undefined}
			data-flx="channel.direct-message.dm-list-page-row.button"
		>
			<div className={dmStyles.clickableItemContent} data-flx="channel.direct-message.dm-list-page-row.content">
				<div
					className={clsx(dmStyles.clickableItemIcon, accent && styles.accentIcon)}
					data-flx="channel.direct-message.dm-list-page-row.icon"
				>
					<RowIcon
						weight="fill"
						className={dmStyles.iconSize5}
						aria-hidden
						data-flx="channel.direct-message.dm-list-page-row.glyph"
					/>
				</div>
				<span
					className={clsx(dmStyles.clickableItemText, accent && styles.accentLabel)}
					data-flx="channel.direct-message.dm-list-page-row.label"
				>
					{label}
				</span>
			</div>
		</button>
	</FocusRing>
);

const openBots = () => RouterUtils.transitionTo(Routes.BOTS);
const openShop = () => RouterUtils.transitionTo(Routes.SHOP);

const openPremiumContextMenu = (event: React.MouseEvent) => {
	event.preventDefault();
	event.stopPropagation();
	const productName = getPremiumProductName();
	ContextMenuCommands.openFromEvent(event, ({onClose}) => (
		<MenuGroup data-flx="channel.direct-message.dm-list.plutonium-context-menu.menu-group">
			<MenuItem
				icon={<HideIcon data-flx="channel.direct-message.dm-list.plutonium-context-menu.menu-icon" />}
				onClick={() => {
					HiddenPlutoniumButton.hide();
					onClose();
				}}
				data-flx="channel.direct-message.dm-list.plutonium-context-menu.menu-item.hide-plutonium-button"
			>
				<Trans comment="Context menu item on the Plutonium button in the direct messages list. Hides the button. productName is the premium product name, Plutonium on fluxer.com.">
					Hide {productName} button
				</Trans>
			</MenuItem>
		</MenuGroup>
	));
};

// Micup: premium and the shop (the two accented rows, together), then Bot System, under the DM list's and the feed
// sidebar's own rows. Each page opens beside the sidebar it is opened from (FeedSectionPages), so the row is current on
// either path.
export const DMListPageItems = observer(() => {
	const {i18n} = useLingui();
	const {pathname} = useLocation();
	const isCurrent = (page: string) => pathname === resolveSectionPagePath(page, pathname);
	return (
		<>
			{shouldShowPremiumFeatures() && !HiddenPlutoniumButton.hidden && (
				<DMListPageRow
					icon={CrownIcon}
					label={getPremiumProductName()}
					selected={isCurrent(Routes.PREMIUM)}
					onClick={() => PremiumModalCommands.open()}
					onContextMenu={openPremiumContextMenu}
					accent
					data-flx="channel.direct-message.dm-list-page-items.premium"
				/>
			)}
			{isShopPageAvailable() && (
				<DMListPageRow
					icon={StorefrontIcon}
					label={i18n._(SHOP_DESCRIPTOR)}
					selected={isCurrent(Routes.SHOP)}
					onClick={openShop}
					accent
					data-flx="channel.direct-message.dm-list-page-items.shop"
				/>
			)}
			<DMListPageRow
				icon={RobotIcon}
				label={i18n._(BOT_SYSTEM_DESCRIPTOR)}
				selected={isCurrent(Routes.BOTS)}
				onClick={openBots}
				data-flx="channel.direct-message.dm-list-page-items.bots"
			/>
		</>
	);
});
