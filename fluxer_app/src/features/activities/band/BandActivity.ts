// SPDX-License-Identifier: AGPL-3.0-or-later

import BandCatalog from '@app/features/activities/band/BandCatalog';
import {bandSongPlaying, describeBandState, describeMyBandPart} from '@app/features/activities/band/BandStatus';
import {BandCover} from '@app/features/activities/band/cover/BandCover';
import type {ActivityDefinition} from '@app/features/activities/registry/ActivityDefinition';
import {msg} from '@lingui/core/macro';
import {GuitarIcon} from '@phosphor-icons/react';
import {lazy} from 'react';

const SONG_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# song} other {# songs}}',
	comment: 'Voice activities: chip on the band game card and detail page. {count} is how many songs the library has.',
});

export const BAND_ACTIVITY: ActivityDefinition = {
	id: 'band',
	name: msg({
		message: 'Bir Daha Baştan',
		comment:
			'Voice activities: name of the band game (play songs together, Rock Band style). A Turkish proper name; keep it as is in every language.',
	}),
	icon: GuitarIcon,
	tagline: msg({
		message:
			'Play as a band on guitar, bass, drums, keys and vocals. With your keyboard, with your friends in the channel.',
		comment: 'Voice activities: one-line description of the band game on its card in the activity picker.',
	}),
	presence: msg({
		message: 'In Bir Daha Baştan',
		comment:
			'Voice activities: label on the call tile of someone playing the band game. Bir Daha Baştan is its name; in Turkish "Bir Daha Baştan\'da".',
	}),
	description: msg({
		message:
			'Pick a song together and everyone takes an instrument. Miss and you go quiet, hit and you carry the band. Rock, metal, Turkish, pop; from Queen to Duman.',
		comment: 'Voice activities: paragraph about the band game on its detail page in the activity picker.',
	}),
	minPlayers: 1,
	maxPlayers: 6,
	facts: [
		msg({
			message: 'Played with the keyboard',
			comment: 'Voice activities: chip on the band game detail page. The game is played on the computer keyboard.',
		}),
		msg({
			message: 'Web and desktop',
			comment: 'Voice activities: chip on the band game detail page. The game runs in the web app and the desktop app.',
		}),
	],
	steps: [
		{
			title: msg({
				message: 'Vote for a song',
				comment: 'Voice activities: first step of how the band game goes, on its detail page.',
			}),
			body: msg({
				message: 'The most voted one plays',
				comment: 'Voice activities: explanation under the first step (voting) on the band game detail page.',
			}),
		},
		{
			title: msg({
				message: 'Take your part',
				comment:
					'Voice activities: second step of how the band game goes, on its detail page. Each player picks an instrument.',
			}),
			body: msg({
				message: 'Guitar, bass, drums, keys, vocals',
				comment: 'Voice activities: explanation under the second step (taking a part) on the band game detail page.',
			}),
		},
		{
			title: msg({
				message: 'Play',
				context: 'band-howto',
				comment: 'Voice activities: third step of how the band game goes, on its detail page: play the song.',
			}),
			body: msg({
				message: 'Then rate each other',
				comment:
					'Voice activities: explanation under the third step (playing) on the band game detail page. After the song, players give each other stars.',
			}),
		},
	],
	startNote: msg({
		message: 'Everyone in the channel sees it as a tile. Whoever joins hears the song; the others carry on talking.',
		comment:
			'Voice activities: note under the Start button on the band game detail page. Starting shows the game as a tile in the call; only those who join play and hear the music.',
	}),
	Cover: BandCover,
	contentCount: (i18n) => {
		const count = BandCatalog.songCount;
		return count === null ? null : i18n._(SONG_COUNT_DESCRIPTOR, {count});
	},
	describeState: describeBandState,
	describeMine: describeMyBandPart,
	showsInTile: bandSongPlaying,
	// The game brings its own heavy code; it loads when someone here first joins.
	View: lazy(() =>
		import('@app/features/activities/band/BandView').then((module) => ({
			default: module.BandView,
		})),
	),
};
