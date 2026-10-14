// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import Initialization from '@app/features/app/state/Initialization';
import {useLayoutVariant} from '@app/features/app/state/LayoutVariantContext';
import {claimStoreAutostartPrompt, setAutostartEnabled} from '@app/features/platform/utils/Autostart';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

const START_WITH_COMPUTER_DESCRIPTOR = msg({
	message: 'Start {productName} when your computer starts?',
	comment:
		'Title of the one-time question in the Microsoft Store desktop app about launching at sign-in. {productName} is the app name.',
});
const CHANGE_LATER_IN_SETTINGS_DESCRIPTOR = msg({
	message: 'You can change this later in Settings.',
	comment: 'Body of the one-time launch-at-sign-in question in the Microsoft Store desktop app.',
});
const YES_DESCRIPTOR = msg({
	message: 'Yes',
	comment: 'Plain Yes answer button in a confirmation question.',
});
const NO_DESCRIPTOR = msg({
	message: 'No',
	comment: 'Plain No answer button in a confirmation question.',
});

// Microsoft Store Policy 10.2.8: the app may start with Windows only after the user agrees, asked once per install.
export const StoreAutostartPromptManager: React.FC = observer(() => {
	const {i18n} = useLingui();
	const variant = useLayoutVariant();
	const shouldAsk = Initialization.isReady && variant === 'app';
	useEffect(() => {
		if (!shouldAsk) return;
		void claimStoreAutostartPrompt().then((ask) => {
			if (!ask) return;
			ModalCommands.push(
				modal(() => (
					<ConfirmModal
						title={i18n._(START_WITH_COMPUTER_DESCRIPTOR, {productName: PRODUCT_NAME})}
						description={i18n._(CHANGE_LATER_IN_SETTINGS_DESCRIPTOR)}
						primaryText={i18n._(YES_DESCRIPTOR)}
						secondaryText={i18n._(NO_DESCRIPTOR)}
						onPrimary={async () => {
							await setAutostartEnabled(true);
						}}
						data-flx="platform.store-autostart-prompt-manager.confirm-modal"
					/>
				)),
			);
		});
	}, [shouldAsk, i18n]);
	return null;
});
