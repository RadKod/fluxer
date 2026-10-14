// SPDX-License-Identifier: AGPL-3.0-or-later

import {showGenericErrorModal} from '@app/features/app/components/alerts/GenericErrorModalCommands';
import {GuildSettingsModal} from '@app/features/guild/components/modals/GuildSettingsModal';
import {
	SOMETHING_WENT_WRONG_DESCRIPTOR,
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {i18n} from '@lingui/core';

const BOOST_PANEL_MODAL_KEY = 'guild-boost-panel';

export function openGuildBoostSettings(guildId: string): void {
	ModalCommands.pushWithKey(
		modal(() => <GuildSettingsModal guildId={guildId} initialTab="boost" initialMobileTab="boost" />),
		BOOST_PANEL_MODAL_KEY,
	);
}

export function openGuildBoostPanel(guildId: string): void {
	void import('@app/features/boost/components/GuildBoostPanel')
		.then(({GuildBoostPanel}) => {
			ModalCommands.pushWithKey(
				modal(() => <GuildBoostPanel guildId={guildId} />),
				BOOST_PANEL_MODAL_KEY,
			);
		})
		.catch(() => {
			showGenericErrorModal({
				title: i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR),
				message: i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR),
				dataFlx: 'boost.panel.load-error',
				defer: true,
			});
		});
}
