// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import * as PlutoniumPageCommands from '@app/features/premium/commands/PlutoniumPageCommands';
import {PremiumModal} from '@app/features/premium/components/modals/PremiumModal';
import PlutoniumPageRollout from '@app/features/premium/state/PlutoniumPageRollout';
import {shouldShowPremiumFeatures} from '@app/features/premium/utils/PremiumUtils';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as UnsavedChangesCommands from '@app/features/ui/commands/UnsavedChangesCommands';
import Modal from '@app/features/ui/state/Modal';
import UnsavedChanges from '@app/features/ui/state/UnsavedChanges';
import {UserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import {getSettingsTabs} from '@app/features/user/components/settings_utils/SettingsConstants';
import {i18n} from '@lingui/core';

interface OpenOptions {
	defaultGiftMode?: boolean;
}

export function open(optionsOrDefaultGiftMode: OpenOptions | boolean = {}): void {
	if (RuntimeConfig.isSelfHosted()) {
		// Micup: self-hosted premium (trial, keys, Payriff) is its own page beside the DM list, not the Stripe modal.
		// Callers inside the settings or another dialog land on the page, so every dialog closes first.
		if (!shouldShowPremiumFeatures()) return;
		// The settings close guard (UserSettingsModal handleClose): a tab with unsaved changes flashes its banner and
		// nothing closes, so the premium buttons of My Profile never drop an edit. Only while the user settings are open
		// and only their own tabs: a dialog closed from outside can leave its entry behind (useWebhookUpdates).
		const unsavedTabId = Modal.hasModalOfType(UserSettingsModal)
			? getSettingsTabs(i18n).find((tab) => UnsavedChanges.unsavedChanges[tab.type])?.type
			: undefined;
		if (unsavedTabId) {
			UnsavedChangesCommands.triggerFlashEffect(unsavedTabId);
			return;
		}
		ModalCommands.popAll();
		RouterUtils.transitionTo(Routes.PREMIUM);
		return;
	}
	const options =
		typeof optionsOrDefaultGiftMode === 'boolean'
			? {defaultGiftMode: optionsOrDefaultGiftMode}
			: optionsOrDefaultGiftMode;
	const {defaultGiftMode = false} = options;
	if (PlutoniumPageRollout.enabled) {
		if (defaultGiftMode) {
			PlutoniumPageCommands.openGiftPlutoniumModal();
		} else {
			PlutoniumPageCommands.openPlutoniumPage();
		}
		return;
	}
	ModalCommands.push(
		modal(() => (
			<PremiumModal defaultGiftMode={defaultGiftMode} data-flx="premium.premium-modal-commands.open.premium-modal" />
		)),
	);
}
