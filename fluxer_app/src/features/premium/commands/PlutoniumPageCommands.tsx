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

export function openPlutoniumPage(): void {
	const unsavedTab = Modal.hasModalOfType(ActiveUserSettingsModal)
		? getSettingsTabs(i18n).find((tab) => UnsavedChanges.unsavedChanges[tab.type])
		: undefined;
	if (unsavedTab) {
		UnsavedChangesCommands.triggerFlashEffect(unsavedTab.type);
		return;
	}
	ModalCommands.popAll();
	RouterUtils.transitionTo(Routes.PLUTONIUM);
}

export function openGiftPlutoniumModal(): void {
	ModalCommands.push(
		modal(() => <GiftPlutoniumModal data-flx="premium.plutonium-page-commands.open-gift-plutonium-modal.modal" />),
	);
}

export function openGiftInventorySettings(): void {
	ModalCommands.push(
		modal(() => (
			<UserSettingsModal
				initialTab="gift_inventory"
				data-flx="premium.plutonium-page-commands.open-gift-inventory-settings.user-settings-modal"
			/>
		)),
	);
}
