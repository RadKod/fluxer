// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {Nagbar} from '@app/features/app/components/layout/Nagbar';
import {NagbarButton} from '@app/features/app/components/layout/NagbarButton';
import {NagbarContent} from '@app/features/app/components/layout/NagbarContent';
import {NAGBAR_TONES, NagbarToneKind} from '@app/features/app/components/layout/NagbarTones';
import {ExternalLink} from '@app/features/app/components/shared/ExternalLink';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {OKAY_DESCRIPTOR, SETTINGS_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as UserSettingsCommands from '@app/features/user/commands/UserSettingsCommands';
import {UserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const TITLE_DESCRIPTOR = msg({
	message: 'Game activity is now on by default',
	comment:
		'One-time notice title for existing accounts: game activity sharing starts on by default after this notice. Legal-effect text: approved before release.',
});
const BODY_DESCRIPTOR = msg({
	message:
		'The sanalyer desktop app will detect the game running on your computer and show its name and icon to your friends and to members of servers you share. Your list of programs never leaves your computer, no game history is kept, and people you’ve blocked can’t see it. You can switch to Friends or Off at any time in Settings › Privacy › Show my game activity.',
	comment:
		'One-time notice body. "Friends" and "Off" are option labels and "Settings › Privacy › Show my game activity" is the settings path; keep them identical to those labels. Legal-effect text: approved before release.',
});
const DETAILS_DESCRIPTOR = msg({
	message: 'Details: Privacy Policy',
	comment:
		'Link under the game activity default notice to the privacy policy. Legal-effect text: approved before release.',
});

export function canShowGameActivityDefault(params: {
	pending: boolean;
	hydrated: boolean;
	rolloutEnabled: boolean;
}): boolean {
	return params.pending && params.hydrated && params.rolloutEnabled;
}

// The server records the acknowledgement; the notice stays until it reports nothing pending.
function acknowledge(): void {
	void UserSettingsCommands.acknowledgeGameActivityDefault().catch(() => {});
}

export const GameActivityDefaultNagbar = observer(({isMobile}: {isMobile: boolean}) => {
	const {i18n} = useLingui();
	const handleOpenSettings = () => {
		ModalCommands.push(
			modal(() => (
				<UserSettingsModal
					initialTab="privacy_safety"
					initialSubtab="game-activity"
					data-flx="app.app-layout.nagbars.game-activity-default-nagbar.handle-open-settings.user-settings-modal"
				/>
			)),
		);
		acknowledge();
	};
	return (
		<Nagbar
			isMobile={isMobile}
			backgroundColor={NAGBAR_TONES[NagbarToneKind.BRAND].backgroundColor}
			textColor={NAGBAR_TONES[NagbarToneKind.BRAND].textColor}
			dismissible
			onDismiss={acknowledge}
			data-flx="app.app-layout.nagbars.game-activity-default-nagbar.nagbar"
		>
			<NagbarContent
				isMobile={isMobile}
				onDismiss={acknowledge}
				message={
					<>
						<strong>{i18n._(TITLE_DESCRIPTOR)}</strong> {i18n._(BODY_DESCRIPTOR)}{' '}
						<ExternalLink href={RuntimeConfig.privacyUrl ?? Routes.privacy()}>
							{i18n._(DETAILS_DESCRIPTOR)}
						</ExternalLink>
					</>
				}
				actions={
					<>
						<NagbarButton
							isMobile={isMobile}
							onClick={handleOpenSettings}
							data-flx="app.app-layout.nagbars.game-activity-default-nagbar.nagbar-button.open-settings"
						>
							{i18n._(SETTINGS_DESCRIPTOR)}
						</NagbarButton>
						<NagbarButton
							isMobile={isMobile}
							onClick={acknowledge}
							data-flx="app.app-layout.nagbars.game-activity-default-nagbar.nagbar-button.okay"
						>
							{i18n._(OKAY_DESCRIPTOR)}
						</NagbarButton>
					</>
				}
				data-flx="app.app-layout.nagbars.game-activity-default-nagbar.nagbar-content"
			/>
		</Nagbar>
	);
});
