// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivityDefinition} from '@app/features/activities/registry/ActivityDefinition';
import {msg} from '@lingui/core/macro';
import {GuitarIcon} from '@phosphor-icons/react';
import {lazy} from 'react';

export const BAND_ACTIVITY: ActivityDefinition = {
	id: 'band',
	name: msg({
		message: 'Bir Daha Baştan',
		comment:
			'Voice activities: name of the band game (play songs together, Rock Band style). A Turkish proper name; keep it as is in every language.',
	}),
	icon: GuitarIcon,
	minPlayers: 1,
	// The game brings its own heavy code; it loads when the panel first opens.
	View: lazy(() =>
		import('@app/features/activities/band/components/BandPlaceholderView').then((module) => ({
			default: module.BandPlaceholderView,
		})),
	),
};
