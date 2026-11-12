// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {UserSettingsModal} from '@app/features/app/components/dialogs/LoadableSettingsModals';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {GiftPlutoniumModal} from '@app/features/premium/components/modals/GiftPlutoniumModal';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as UnsavedChangesCommands from '@app/features/ui/commands/UnsavedChangesCommands';
import Modal from '@app/features/ui/state/Modal';
import UnsavedChanges from '@app/features/ui/state/UnsavedChanges';
import {UserSettingsModal as ActiveUserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import {getSettingsTabs} from '@app/features/user/components/settings_utils/SettingsConstants';
import {i18n} from '@lingui/core';
import * as PopoutCommands from '@app/features/ui/commands/PopoutCommands';
import type {UserSettingsTabType} from '@app/features/user/components/settings_utils/SettingsSectionRegistry';

export function openPlutoniumPage(): void {
	const unsavedTab = Modal.hasModalOfType(ActiveUserSettingsModal)
		? getSettingsTabs(i18n).find((tab) => UnsavedChanges.unsavedChanges[tab.type])
		: undefined;
	if (unsavedTab) {
		UnsavedChangesCommands.triggerFlashEffect(unsavedTab.type);
		return;
	}
	ModalCommands.popAll();
	PopoutCommands.closeAll();
	RouterUtils.transitionTo(Routes.PLUTONIUM);
}

export function openGiftPlutoniumModal(chatChannelId?: string): void {
	ModalCommands.push(
		modal(() => (
			<GiftPlutoniumModal
				chatChannelId={chatChannelId}
				data-flx="premium.plutonium-page-commands.open-gift-plutonium-modal.modal"
			/>
		)),
	);
}

function openBillingSettings(tab: UserSettingsTabType): void {
	ModalCommands.push(
		modal(
			() => (
				<UserSettingsModal
					initialTab={tab}
					data-flx="premium.plutonium-page-commands.open-billing-settings.user-settings-modal"
				/>
			),
			'user-settings',
		),
	);
}

export function openGiftInventorySettings(): void {
	openBillingSettings('gift_inventory');
}

export function openSubscriptionSettings(): void {
	openBillingSettings('subscriptions');
}
