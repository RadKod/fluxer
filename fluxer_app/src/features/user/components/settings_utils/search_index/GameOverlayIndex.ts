// SPDX-License-Identifier: AGPL-3.0-or-later

import {IN_GAME_OVERLAY_DESCRIPTOR} from '@app/features/game_overlay/utils/GameOverlayMessageDescriptors';
import {isGameOverlaySupported} from '@app/features/game_overlay/utils/GameOverlaySupport';
import type {SearchableSettingDescriptor} from '@app/features/user/components/settings_utils/search_index/SearchIndexTypes';
import {msg} from '@lingui/core/macro';

const OVERLAY_DESCRIPTOR = msg({
	message: 'Overlay',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});
const GAME_DESCRIPTOR = msg({
	message: 'Game',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});

export const gameOverlayIndex: Array<SearchableSettingDescriptor> = [
	{
		id: 'game-overlay',
		tabType: 'game_overlay',
		label: IN_GAME_OVERLAY_DESCRIPTOR,
		keywords: [IN_GAME_OVERLAY_DESCRIPTOR, OVERLAY_DESCRIPTOR, GAME_DESCRIPTOR, 'overlay'],
		tags: ['desktop'],
		isVisible: isGameOverlaySupported,
	},
];
