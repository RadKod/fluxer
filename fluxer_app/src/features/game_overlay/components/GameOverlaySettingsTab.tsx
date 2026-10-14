// SPDX-License-Identifier: AGPL-3.0-or-later

import {SettingsTabContainer, SettingsTabSection} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import GameOverlaySettings from '@app/features/game_overlay/state/GameOverlaySettings';
import {IN_GAME_OVERLAY_DESCRIPTOR} from '@app/features/game_overlay/utils/GameOverlayMessageDescriptors';
import type {GameOverlayMode} from '@app/features/game_overlay/utils/GameOverlayModel';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {RadioGroup, type RadioOption} from '@app/features/ui/radio_group/RadioGroup';
import type {DesktopGameOverlayCorner} from '@app/types/electron.d';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const GAME_OVERLAY_DESCRIPTION_DESCRIPTOR = msg({
	message:
		"Doesn't appear over exclusive fullscreen; switch your game to borderless windowed mode. May add a little latency in games. Appears on your primary display.",
	comment: 'Description under the in-game overlay toggle in desktop settings (Windows only).',
});
const GAME_OVERLAY_MODE_DESCRIPTOR = msg({
	message: 'Who to show',
	comment: 'Heading above the in-game overlay mode options (only people speaking, or everyone in the voice channel).',
});
const GAME_OVERLAY_CORNER_DESCRIPTOR = msg({
	message: 'Corner',
	comment: 'Heading above the options choosing which screen corner the in-game overlay appears in.',
});
const GAME_OVERLAY_MODE_SPEAKING_DESCRIPTOR = msg({
	message: 'Speaking',
	comment: 'In-game overlay mode option: show only people who are currently speaking.',
});
const GAME_OVERLAY_MODE_ROOM_DESCRIPTOR = msg({
	message: 'Everyone in the channel',
	comment: 'In-game overlay mode option: show everyone in the voice channel, speaking or not.',
});
const GAME_OVERLAY_CORNER_TOP_LEFT_DESCRIPTOR = msg({
	message: 'Top left',
	comment: 'In-game overlay position option: top-left corner of the screen.',
});
const GAME_OVERLAY_CORNER_TOP_RIGHT_DESCRIPTOR = msg({
	message: 'Top right',
	comment: 'In-game overlay position option: top-right corner of the screen.',
});
const GAME_OVERLAY_CORNER_BOTTOM_LEFT_DESCRIPTOR = msg({
	message: 'Bottom left',
	comment: 'In-game overlay position option: bottom-left corner of the screen.',
});
const GAME_OVERLAY_CORNER_BOTTOM_RIGHT_DESCRIPTOR = msg({
	message: 'Bottom right',
	comment: 'In-game overlay position option: bottom-right corner of the screen.',
});

const GameOverlaySettingsTab: React.FC = observer(() => {
	const {i18n} = useLingui();
	const modeOptions: ReadonlyArray<RadioOption<GameOverlayMode>> = [
		{value: 'speaking', name: i18n._(GAME_OVERLAY_MODE_SPEAKING_DESCRIPTOR)},
		{value: 'room', name: i18n._(GAME_OVERLAY_MODE_ROOM_DESCRIPTOR)},
	];
	const cornerOptions: ReadonlyArray<RadioOption<DesktopGameOverlayCorner>> = [
		{value: 'top-left', name: i18n._(GAME_OVERLAY_CORNER_TOP_LEFT_DESCRIPTOR)},
		{value: 'top-right', name: i18n._(GAME_OVERLAY_CORNER_TOP_RIGHT_DESCRIPTOR)},
		{value: 'bottom-left', name: i18n._(GAME_OVERLAY_CORNER_BOTTOM_LEFT_DESCRIPTOR)},
		{value: 'bottom-right', name: i18n._(GAME_OVERLAY_CORNER_BOTTOM_RIGHT_DESCRIPTOR)},
	];
	return (
		<SettingsTabContainer data-flx="game-overlay.game-overlay-settings-tab.settings-tab-container">
			<Switch
				label={i18n._(IN_GAME_OVERLAY_DESCRIPTOR)}
				description={i18n._(GAME_OVERLAY_DESCRIPTION_DESCRIPTOR)}
				value={GameOverlaySettings.enabled}
				onChange={GameOverlaySettings.setEnabled}
				data-flx="game-overlay.game-overlay-settings-tab.switch.enabled"
			/>
			<SettingsTabSection
				title={i18n._(GAME_OVERLAY_MODE_DESCRIPTOR)}
				data-flx="game-overlay.game-overlay-settings-tab.mode-section"
			>
				<RadioGroup
					options={modeOptions}
					value={GameOverlaySettings.mode}
					disabled={!GameOverlaySettings.enabled}
					onChange={GameOverlaySettings.setMode}
					aria-label={i18n._(GAME_OVERLAY_MODE_DESCRIPTOR)}
					data-flx="game-overlay.game-overlay-settings-tab.radio-group.mode"
				/>
			</SettingsTabSection>
			<SettingsTabSection
				title={i18n._(GAME_OVERLAY_CORNER_DESCRIPTOR)}
				data-flx="game-overlay.game-overlay-settings-tab.corner-section"
			>
				<RadioGroup
					options={cornerOptions}
					value={GameOverlaySettings.corner}
					disabled={!GameOverlaySettings.enabled}
					onChange={GameOverlaySettings.setCorner}
					aria-label={i18n._(GAME_OVERLAY_CORNER_DESCRIPTOR)}
					data-flx="game-overlay.game-overlay-settings-tab.radio-group.corner"
				/>
			</SettingsTabSection>
		</SettingsTabContainer>
	);
});

export default GameOverlaySettingsTab;
