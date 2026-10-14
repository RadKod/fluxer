// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SoundType} from '@app/features/notification/utils/SoundUtils';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {SwitchGroup} from '@app/features/ui/components/SwitchGroup';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import type React from 'react';

const TABLE_GAME_SOUNDS_DESCRIPTOR = msg({
	message: 'Table game sounds',
	comment:
		'Sound settings: switch that turns every table game sound (okey, 101, chess, draughts, backgammon) on or off.',
});
const TABLE_GAME_SOUNDS_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Only at the table you have open or sit at.',
	comment: 'Sound settings: description under the table game sounds switch; when the sounds play.',
});

type SoundEntry = readonly [SoundType, string];

// Settings → Notifications → Sounds: one switch for all table game sounds, then each of them (the sound list's rows).
export function TableGameSoundSettings({
	entries,
	allDisabled,
	isSoundEnabled,
	onToggleSound,
	renderSoundToggle,
}: {
	entries: ReadonlyArray<SoundEntry>;
	allDisabled: boolean;
	isSoundEnabled: (soundType: SoundType) => boolean;
	onToggleSound: (soundType: SoundType, enabled: boolean) => void;
	renderSoundToggle: (entry: SoundEntry) => React.ReactNode;
}): React.JSX.Element {
	const {i18n} = useLingui();
	const on = !allDisabled && entries.some(([type]) => isSoundEnabled(type));
	return (
		<>
			<Switch
				label={i18n._(TABLE_GAME_SOUNDS_DESCRIPTOR)}
				description={i18n._(TABLE_GAME_SOUNDS_DESCRIPTION_DESCRIPTOR)}
				value={on}
				disabled={allDisabled}
				onChange={(enabled) => {
					for (const [type] of entries) onToggleSound(type, enabled);
				}}
				data-flx="table-game.table-game-sound-settings.switch"
			/>
			{on && (
				<SwitchGroup data-flx="table-game.table-game-sound-settings.switch-group">
					{entries.map(renderSoundToggle)}
				</SwitchGroup>
			)}
		</>
	);
}
