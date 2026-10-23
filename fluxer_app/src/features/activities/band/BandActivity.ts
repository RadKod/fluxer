// SPDX-License-Identifier: AGPL-3.0-or-later

import BandCatalog from '@app/features/activities/band/BandCatalog';
import {BAND_JAM_START_MODE} from '@app/features/activities/band/BandProtocol';
import {bandSongPlaying, describeBandState, describeMyBandPart} from '@app/features/activities/band/BandStatus';
import {BandCover} from '@app/features/activities/band/cover/BandCover';
import type {ActivityDefinition, ActivityEntry} from '@app/features/activities/registry/ActivityDefinition';
import {JamCover} from '@app/features/activities/registry/JamCover';
import {msg} from '@lingui/core/macro';
import {GuitarIcon} from '@phosphor-icons/react';
import {lazy} from 'react';

const SONG_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# song} other {# songs}}',
	comment: 'Voice activities: chip on the band game card and detail page. {count} is how many songs the library has.',
});

// Shared by the songs and the jam entry: both are played the same way, in the same places.
const BAND_FACTS = [
	msg({
		message: 'Played with the keyboard',
		comment:
			'Voice activities: chip on the band game and jam detail pages. The game is played on the computer keyboard.',
	}),
	msg({
		message: 'Web and desktop',
		comment:
			'Voice activities: chip on the band game and jam detail pages. The game runs in the web app and the desktop app.',
	}),
];

// The band game's jam mode as its own card: the room opens straight in jam instead of on the song picker.
const JAM_ENTRY: ActivityEntry = {
	startMode: BAND_JAM_START_MODE,
	name: msg({
		message: 'Jam',
		context: 'voice-activity',
		comment:
			'Voice activities: name of the jam card in the activity picker, where the people in the channel play freely together without a song. In Turkish "Doğaçlama".',
	}),
	tagline: msg({
		message: 'Pick a key and play freely together',
		comment: 'Voice activities: one-line description of jam on its card in the activity picker.',
	}),
	description: msg({
		message:
			'No song, no score. The leader picks a key and a backing loop, everyone takes an instrument, and whatever you play stays in key.',
		comment:
			'Voice activities: paragraph about jam (free play without a song) on its detail page in the activity picker.',
	}),
	minPlayers: 1,
	maxPlayers: 6,
	facts: BAND_FACTS,
	steps: [
		{
			title: msg({
				message: 'Pick a key',
				comment: 'Voice activities: first step of how a jam goes, on its detail page. The key is the musical key.',
			}),
			body: msg({
				message: 'The leader sets the key, scale and backing',
				comment:
					'Voice activities: explanation under the first step (picking a key) on the jam detail page. The backing is a drum and bass loop.',
			}),
		},
		{
			title: msg({
				message: 'Take your instrument',
				comment:
					'Voice activities: second step of how a jam goes, on its detail page. Each player picks an instrument.',
			}),
			body: msg({
				message: 'Lead or rhythm guitar, bass, keys, drums',
				comment: 'Voice activities: explanation under the second step (taking an instrument) on the jam detail page.',
			}),
		},
		{
			title: msg({
				message: 'Play together',
				comment: 'Voice activities: third step of how a jam goes, on its detail page.',
			}),
			body: msg({
				message: 'Every note stays in key',
				comment:
					'Voice activities: explanation under the third step (playing) on the jam detail page. The keys only play notes of the chosen scale.',
			}),
		},
	],
	startNote: msg({
		message: 'Everyone in the channel sees it as a tile. Whoever joins hears the jam; the others carry on talking.',
		comment:
			'Voice activities: note under the Start button on the jam detail page. Starting shows the jam as a tile in the call; only those who join play and hear it.',
	}),
	Cover: JamCover,
};

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
	facts: BAND_FACTS,
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
	entries: [JAM_ENTRY],
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
