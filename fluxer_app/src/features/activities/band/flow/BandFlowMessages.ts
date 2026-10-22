// SPDX-License-Identifier: AGPL-3.0-or-later

import {PART_DESCRIPTORS} from '@app/features/activities/band/BandPartNames';
import type {BandCheerKind, BandGenreGroup, BandSongSummary} from '@app/features/activities/band/BandProtocol';
import {type BandDifficulty, type BandPart, isLeadPart} from '@app/features/activities/band/engine/ChartModel';
import type {BandSingerOutput} from '@app/features/activities/band/flow/BandSingerVoice';
import type {BandDecade} from '@app/features/activities/band/flow/BandSongFilters';
import type {BandLibraryFailure} from '@app/features/activities/band/flow/BandSongLibrary';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const STEP_DESCRIPTORS = {
	pick: msg({
		message: 'Song',
		context: 'band-step',
		comment: 'Band game: step indicator over the game, the first step where someone picks the next song.',
	}),
	select: msg({
		message: 'Pick',
		context: 'band-step',
		comment: 'Band game: step indicator, the step where players pick an instrument part and a difficulty.',
	}),
	play: msg({
		message: 'Play',
		context: 'band-step',
		comment: 'Band game: step indicator, the step where the band plays the song.',
	}),
	results: msg({
		message: 'Results',
		context: 'band-step',
		comment: 'Band game: step indicator, the last step showing scores and crowd ratings.',
	}),
} as const;

const LEAD_PART_DESCRIPTORS: Readonly<Partial<Record<BandPart, MessageDescriptor>>> = {
	guitar: msg({
		message: 'Lead guitar',
		comment: 'Band game: the guitar part of a song that also has a rhythm guitar part; the melodies and solos.',
	}),
};

// "Lead guitar" only when the song also has a rhythm guitar to tell it from; plain "Guitar" otherwise.
export function partDescriptor(part: BandPart, song: BandSongSummary | undefined): MessageDescriptor {
	const lead = LEAD_PART_DESCRIPTORS[part];
	return lead && song && isLeadPart(part, song.parts) ? lead : PART_DESCRIPTORS[part];
}

export const DIFFICULTY_DESCRIPTORS: Readonly<Record<BandDifficulty, MessageDescriptor>> = {
	easy: msg({message: 'Easy', context: 'band-difficulty', comment: 'Band game: the easiest chart difficulty.'}),
	medium: msg({message: 'Medium', context: 'band-difficulty', comment: 'Band game: the second chart difficulty.'}),
	hard: msg({message: 'Hard', context: 'band-difficulty', comment: 'Band game: the third chart difficulty.'}),
	expert: msg({message: 'Expert', context: 'band-difficulty', comment: 'Band game: the hardest chart difficulty.'}),
};

export const CHEER_DESCRIPTORS: Readonly<Record<BandCheerKind, MessageDescriptor>> = {
	clap: msg({message: 'Clap', comment: 'Band game: spectator button that sends applause to the band.'}),
	fire: msg({message: 'On fire', comment: 'Band game: spectator button that tells the band they are on fire.'}),
	horns: msg({message: 'Rock on', comment: 'Band game: spectator button that sends the rock hand sign.'}),
	wow: msg({message: 'Wow', comment: 'Band game: spectator button that sends an amazed reaction.'}),
};

export const LIBRARY_FAILURE_DESCRIPTORS: Readonly<Record<BandLibraryFailure, MessageDescriptor>> = {
	unreachable: msg({
		message: 'The song server did not answer. Check your connection and try again.',
		comment: 'Band game: the song list or a song file could not be fetched (offline, or the server blocks this app).',
	}),
	http: msg({
		message: 'The song server returned an error. Try again in a bit.',
		comment: 'Band game: the song server answered with an error status.',
	}),
	invalid: msg({
		message: 'The song list could not be read.',
		comment: 'Band game: the song list file was downloaded but is broken.',
	}),
	unknownSong: msg({
		message: 'This song is no longer in the library.',
		comment: 'Band game: the chosen song was removed from the song list.',
	}),
	corrupt: msg({
		message: 'The song file is damaged. Try again to download it fresh.',
		comment: 'Band game: a downloaded song package could not be opened.',
	}),
};

export const SECONDS_DESCRIPTOR = msg({
	message: '{seconds} s',
	comment: 'Band game: seconds left on a phase timer, short form. {seconds} is a whole number.',
});
export const YOU_TAG_DESCRIPTOR = msg({
	message: 'You',
	context: 'band-self',
	comment: 'Band game: small tag next to my own name on a card.',
});
export const LEADER_TAG_DESCRIPTOR = msg({
	message: 'Leader',
	context: 'band-leader',
	comment: 'Band game: label under the name of the person who runs the room (skips, group difficulty).',
});
export const RETRY_DESCRIPTOR = msg({
	message: 'Try again',
	context: 'band-retry',
	comment: 'Band game: button that retries loading the song list or a song file.',
});
export const ROOM_LOADING_DESCRIPTOR = msg({
	message: 'Setting up the room...',
	comment: 'Band game: shown until the leader shares the first game state.',
});
export const LIBRARY_LOADING_DESCRIPTOR = msg({
	message: 'Loading songs...',
	comment: 'Band game: shown while the song list downloads.',
});
export const LIBRARY_FAILED_TITLE_DESCRIPTOR = msg({
	message: 'Could not reach the song library',
	comment: 'Band game: heading of the error shown when the song list did not load.',
});
export const SONG_DOWNLOADING_DESCRIPTOR = msg({
	message: 'Downloading the song: {percent}%',
	comment: 'Band game: progress of the song file download before playing. {percent} is 0 to 100.',
});
export const SONG_PREPARING_DESCRIPTOR = msg({
	message: 'Getting the song ready...',
	comment: 'Band game: the song file is on this device and is being opened.',
});
export const SONG_FAILED_DESCRIPTOR = msg({
	message: 'Could not get the song',
	comment: 'Band game: heading of the error shown when the song file did not download or open.',
});

export const PICK_TITLE_DESCRIPTOR = msg({
	message: 'Next song',
	context: 'band-pick',
	comment: 'Band game: heading of the screen where anyone in the room browses the library and votes for the next song.',
});
export const PICK_SEARCH_DESCRIPTOR = msg({
	message: 'Search songs or artists',
	comment: 'Band game: placeholder of the search field in the song list.',
});
export const PICK_RANDOM_DESCRIPTOR = msg({
	message: 'Random',
	context: 'band-pick',
	comment: 'Band game: button on the song picking screen that votes for a random song from the songs shown.',
});
export const PICK_RANDOM_HINT_DESCRIPTOR = msg({
	message: 'Vote for a random song from this list',
	comment: 'Band game: tooltip of the Random button; the random song comes from the genre and era filters in use.',
});
export const PICK_GENRES_DESCRIPTOR = msg({
	message: 'Genres',
	context: 'band-pick',
	comment: 'Band game: accessible name of the list of genre filters on the left of the song picking screen.',
});
export const PICK_ERA_DESCRIPTOR = msg({
	message: 'Era',
	context: 'band-pick',
	comment: 'Band game: small heading over the decade filters (70s, 80s...) on the song picking screen.',
});
export const PICK_SONG_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# song} other {# songs}}',
	comment: 'Band game: how many songs the chosen genre and filters show, next to the genre heading.',
});
export const PICK_PREVIEW_HINT_DESCRIPTOR = msg({
	message: 'hover to preview',
	comment:
		'Band game: lowercase hint after the song count on the song picking screen; pointing at a song plays a short preview for you only.',
});
export const PICK_SONGS_DESCRIPTOR = msg({
	message: 'Songs',
	context: 'band-pick',
	comment: 'Band game: accessible name of the grid of song covers on the song picking screen.',
});
export const PICK_NO_MATCH_DESCRIPTOR = msg({
	message: 'No songs match.',
	comment: 'Band game: the song list search found nothing.',
});
export const PICK_LIBRARY_EMPTY_DESCRIPTOR = msg({
	message: 'The song library is empty.',
	comment: 'Band game: shown on the song picking screen when the library has no songs.',
});
export const PICK_SELECTED_DESCRIPTOR = msg({
	message: 'Selected song',
	comment:
		'Band game: accessible name of the panel on the right of the song picking screen describing the chosen song.',
});
export const PREVIEW_PLAYING_DESCRIPTOR = msg({
	message: 'Preview playing',
	comment: 'Band game: small label under the chosen song while a short preview of it plays for you only.',
});
export const PREVIEW_DOWNLOADING_DESCRIPTOR = msg({
	message: 'Downloading for preview',
	comment:
		'Band game: small label under the chosen song while its file downloads (someone voted for it); the preview plays once it is here.',
});
export const PART_TIER_DESCRIPTOR = msg({
	message: '{part} difficulty: {tier} of 6',
	comment:
		'Band game: accessible text of the seven-step difficulty bar of one part of a song, from 0 (warm-up) to 6. {part} is Guitar, Drums...',
});
export const PART_UNRATED_DESCRIPTOR = msg({
	message: '{part} difficulty: not rated',
	comment: 'Band game: accessible text of the difficulty bar of a part the song file gives no difficulty for.',
});
export const VOTE_DESCRIPTOR = msg({
	message: 'Vote',
	context: 'band-pick',
	comment: 'Band game: main button on the song picking screen that votes for the chosen song.',
});
export const UNVOTE_DESCRIPTOR = msg({
	message: 'Take back my vote',
	comment: 'Band game: replaces the Vote button when the chosen song already has my vote.',
});
export const VOTES_DESCRIPTOR = msg({
	message: 'Votes',
	context: 'band-pick',
	comment: 'Band game: heading of the list of songs that have votes, with a countdown ring next to it.',
});
export const VOTE_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# vote} other {# votes}}',
	comment: 'Band game: number of votes on a song.',
});
export const PICK_COUNTDOWN_DESCRIPTOR = msg({
	message: '{seconds} s until the most voted song opens',
	comment:
		'Band game: countdown on the song picking screen; it starts with the first vote. {seconds} is a whole number.',
});
export const PICK_WAITING_DESCRIPTOR = msg({
	message: 'No votes yet. The first vote starts a {seconds} s countdown.',
	comment: 'Band game: under the Votes heading before anyone voted. {seconds} is a whole number.',
});
export const PLAY_LEADING_NOW_DESCRIPTOR = msg({
	message: 'Play the leading song now',
	comment: 'Band game: leader-only button under the votes that skips the countdown and opens the most voted song.',
});

export const GENRE_GROUP_DESCRIPTORS: Readonly<Record<BandGenreGroup | 'all', MessageDescriptor>> = {
	all: msg({
		message: 'All',
		context: 'band-genre',
		comment: 'Band game: first genre filter on the song picking screen, showing every song.',
	}),
	turkce: msg({
		message: 'Turkish',
		context: 'band-genre',
		comment: 'Band game: genre filter for songs in Turkish or by Turkish artists.',
	}),
	rock: msg({message: 'Rock', context: 'band-genre', comment: 'Band game: genre filter for rock songs.'}),
	metal: msg({message: 'Metal', context: 'band-genre', comment: 'Band game: genre filter for metal songs.'}),
	alternatif: msg({
		message: 'Alternative',
		context: 'band-genre',
		comment: 'Band game: genre filter for alternative and indie rock songs.',
	}),
	pop: msg({message: 'Pop', context: 'band-genre', comment: 'Band game: genre filter for pop songs.'}),
	country: msg({message: 'Country', context: 'band-genre', comment: 'Band game: genre filter for country songs.'}),
	klasik: msg({
		message: 'Classical',
		context: 'band-genre',
		comment: 'Band game: genre filter for classical pieces (Bach, Mozart, Beethoven), often played as rock covers.',
	}),
};

export const DECADE_DESCRIPTORS: Readonly<Record<BandDecade, MessageDescriptor>> = {
	1970: msg({message: '70s', context: 'band-era', comment: 'Band game: era filter for songs from 1970 to 1979.'}),
	1980: msg({message: '80s', context: 'band-era', comment: 'Band game: era filter for songs from 1980 to 1989.'}),
	1990: msg({message: '90s', context: 'band-era', comment: 'Band game: era filter for songs from 1990 to 1999.'}),
	2000: msg({message: '2000s', context: 'band-era', comment: 'Band game: era filter for songs from 2000 to 2009.'}),
	2010: msg({message: '2010+', context: 'band-era', comment: 'Band game: era filter for songs from 2010 on.'}),
};

export const VOCALS_HINT_DESCRIPTOR = msg({
	message: 'Optional, pitch is measured from your mic',
	comment: 'Band game: note on the vocals card; singing is optional and scored by pitch from the microphone.',
});
export const SINGER_OUTPUT_LABEL_DESCRIPTOR = msg({
	message: 'What you hear the song on',
	context: 'band-singer-output',
	comment:
		'Band game: accessible name of the Headphones / Speakers choice on my vocals card; it sets how my mic is processed while I sing.',
});
export const SINGER_OUTPUT_DESCRIPTORS: Readonly<Record<BandSingerOutput, MessageDescriptor>> = {
	headphones: msg({
		message: 'Headphones',
		context: 'band-singer-output',
		comment: 'Band game: option on my vocals card; I hear the song on headphones, so my mic picks up only my voice.',
	}),
	speakers: msg({
		message: 'Speakers',
		context: 'band-singer-output',
		comment: 'Band game: option on my vocals card; I hear the song on speakers, so my mic keeps echo cancellation.',
	}),
};
export const SINGER_OUTPUT_HINT_DESCRIPTOR = msg({
	message: 'Headphones give the cleanest voice',
	context: 'band-singer-output',
	comment: 'Band game: short tip under the Headphones / Speakers choice on my vocals card.',
});
export const KEY_GUIDE_TITLE_DESCRIPTOR = msg({
	message: 'Your keys',
	context: 'band-key-guide',
	comment: 'Band game: title of the small keyboard drawing that shows which keys play my part.',
});
export const KEY_GUIDE_TRY_DESCRIPTOR = msg({
	message: 'Press them to try',
	context: 'band-key-guide',
	comment: 'Band game: invites me to press the shown keys before the song; pressing lights them up, nothing is sent.',
});
export const KEY_GUIDE_HOLD_TIP_DESCRIPTOR = msg({
	message: 'Hold the key through long notes.',
	context: 'band-key-guide',
	comment: 'Band game: tip for guitar, bass and keys; a long note is scored while its key stays pressed.',
});
export const KEY_GUIDE_STAR_POWER_TIP_DESCRIPTOR = msg({
	message: 'Enter turns on star power.',
	context: 'band-key-guide',
	comment: 'Band game: tip; the Enter key deploys star power, the saved-up bonus that doubles the score for a while.',
});
export const KEY_GUIDE_KICK_TIP_DESCRIPTOR = msg({
	message: 'The orange bar across the lane is the kick: Space.',
	context: 'band-key-guide',
	comment: 'Band game: drums tip; kick drum notes are drawn as an orange bar across the whole lane, played with Space.',
});
export const KEY_GUIDE_VOCALS_TIP_DESCRIPTOR = msg({
	message: 'Sing into your mic; pitch is scored.',
	context: 'band-key-guide',
	comment: 'Band game: vocals tip; there are no keys, the score comes from the pitch of my voice on the microphone.',
});
export const KEY_GUIDE_CHORD_DESCRIPTOR = msg({
	message: '{count} keys at once',
	context: 'band-key-guide',
	comment:
		'Band game: shown while I hold two or more of my keys together, so I can check chords register. {count} is 2 or more.',
});
export const MULTIPLIER_DESCRIPTOR = msg({
	message: '×{multiplier}',
	comment: 'Band game: score multiplier of a difficulty, for example ×1.5. {multiplier} is a formatted number.',
});
export const READY_DESCRIPTOR = msg({
	message: 'Ready',
	context: 'band-ready',
	comment: 'Band game: a player has said they are ready to start.',
});
export const I_AM_READY_DESCRIPTOR = msg({
	message: 'I’m ready',
	comment: 'Band game: button on my own part card that tells everyone I am ready to start.',
});
export const NOT_READY_DESCRIPTOR = msg({
	message: 'Not ready yet',
	comment: 'Band game: a seated player has not said they are ready.',
});
export const WATCH_DESCRIPTOR = msg({
	message: 'Watch',
	context: 'band-watch',
	comment: 'Band game: button that gives up my part and lets me watch the song instead.',
});
export const PICKING_DESCRIPTOR = msg({
	message: 'Picking',
	comment: 'Band game: the player is still choosing a difficulty.',
});
export const SEAT_DOWNLOADING_DESCRIPTOR = msg({
	message: 'Downloading',
	context: 'band-seat-download',
	comment: 'Band game: a seated player is still downloading the song file and cannot be ready yet.',
});
export const SEAT_DOWNLOAD_PROGRESS_DESCRIPTOR = msg({
	message: 'Downloading {percent}%',
	comment: 'Band game: my own song file download on my part card, before I can say I am ready. {percent} is 0 to 100.',
});
export const WAITING_FOR_DOWNLOADS_DESCRIPTOR = msg({
	message: 'Waiting for the song to download',
	comment:
		'Band game: the pick timer ran out but some players are still downloading the song; it starts when they finish, or without them when this extra wait runs out.',
});
export const TAKE_PART_DESCRIPTOR = msg({
	message: 'Play this part',
	comment: 'Band game: button on a free part card that seats me on that part.',
});
export const FREE_PART_DESCRIPTOR = msg({
	message: 'Free',
	context: 'band-part-free',
	comment: 'Band game: nobody has taken this part yet.',
});
export const GROUP_DIFFICULTY_DESCRIPTOR = msg({
	message: 'Group difficulty',
	comment: 'Band game: label of the difficulty everyone starts from; the leader sets it.',
});
export const GROUP_DIFFICULTY_LEADER_HINT_DESCRIPTOR = msg({
	message: 'You are the leader. Everyone can still change their own card.',
	comment: 'Band game: note under the group difficulty for the leader.',
});
export const GROUP_DIFFICULTY_HINT_DESCRIPTOR = msg({
	message: '{name} sets it. You can change your own card.',
	comment: 'Band game: note under the group difficulty for everyone but the leader. {name} is the leader.',
});
export const BIG_ROCK_ENDING_DESCRIPTOR = msg({
	message: 'Big finale',
	comment:
		'Band game: the Big Rock Ending, free play at the end of a song closed by one final hit together. Label of the leader’s on/off setting on the part picking screen.',
});
export const BIG_ROCK_ENDING_HINT_DESCRIPTOR = msg({
	message: 'At the end of the song every key plays freely. Land the last hit together for a bonus.',
	comment:
		'Band game: tooltip of the Big finale setting on the part picking screen. When it is off, the notes written for the ending are played instead.',
});
export const SETTING_ON_DESCRIPTOR = msg({
	message: 'On',
	comment: 'Band game: the Big finale setting is on.',
});
export const SETTING_OFF_DESCRIPTOR = msg({
	message: 'Off',
	comment: 'Band game: the Big finale setting is off.',
});
export const READY_TALLY_DESCRIPTOR = msg({
	message: '{ready} of {seated} ready',
	comment:
		'Band game: how many people in the room are ready to start, either ready on a part or watching. {ready} and {seated} are numbers; {seated} is everyone in the room.',
});
export const PICK_A_PART_DESCRIPTOR = msg({
	message: 'Pick a part to play',
	comment: 'Band game: shown on the selection screen while nobody has taken a part.',
});
export const SONG_SUBTITLE_DESCRIPTOR = msg({
	message: '{artist}, {length}',
	comment: 'Band game: artist and song length, for example "Duman, 4:12".',
});
export const WILL_WATCH_DESCRIPTOR = msg({
	message: '{count, plural, one {Watching, # person} other {Watching, # people}}',
	comment: 'Band game: heading over the people who will watch the song instead of playing.',
});
export const SPECTATOR_NOTE_DESCRIPTOR = msg({
	message: 'Anyone without a part watches. They cheer during the song and rate the players 1 to 5 at the end.',
	comment: 'Band game: explanation in the spectator column.',
});
export const MIC_PUSH_TO_TALK_NOTE_DESCRIPTOR = msg({
	message:
		'While you play an instrument, your mic switches to push-to-talk and goes back when the song ends. On vocals it stays open.',
	comment: 'Band game: note about what happens to my microphone while I play, when I have a push-to-talk key.',
});
export const MIC_MUTE_NOTE_DESCRIPTOR = msg({
	message:
		'While you play an instrument, your mic is muted and comes back when the song ends. On vocals it stays open.',
	comment: 'Band game: note about what happens to my microphone while I play, when I have no push-to-talk key.',
});

export const SPECTATORS_DESCRIPTOR = msg({
	message: '{count, plural, one {Watching now, # person} other {Watching now, # people}}',
	comment: 'Band game: heading over the people watching the song being played.',
});
export const CHEERING_DESCRIPTOR = msg({
	message: 'cheering',
	comment: 'Band game: status under a spectator who cheered in the last few seconds.',
});
export const WATCHING_DESCRIPTOR = msg({
	message: 'watching',
	comment: 'Band game: status under a spectator who is just watching.',
});
export const HYPE_DESCRIPTOR = msg({
	message: 'Hype',
	comment: 'Band game: meter of how much the spectators are cheering right now.',
});
export const CHEER_GROUP_DESCRIPTOR = msg({
	message: 'Cheer the band',
	comment: 'Band game: accessible name of the row of cheer buttons for spectators.',
});

export const RESULTS_SUMMARY_DESCRIPTOR = msg({
	message:
		'Group difficulty {difficulty}. {players, plural, one {# person played} other {# people played}}, {spectators, plural, one {# watched} other {# watched}}.',
	comment: 'Band game: line under the song on the results screen. {difficulty} is Easy, Medium, Hard or Expert.',
});
export const PART_AND_DIFFICULTY_DESCRIPTOR = msg({
	message: '{part}, {difficulty}',
	comment: 'Band game: what a player played, for example "Guitar, Hard".',
});
export const ACCURACY_DESCRIPTOR = msg({
	message: 'accuracy',
	comment: 'Band game: label after the group hit percentage on the results screen.',
});
export const STARS_LABEL_DESCRIPTOR = msg({
	message: '{stars} of 5 stars',
	comment: 'Band game: accessible label of a star rating.',
});
export const LONGEST_STREAK_DESCRIPTOR = msg({
	message: 'Longest streak',
	comment: 'Band game: results row, the most notes a player hit in a row.',
});
export const STAR_POWER_DESCRIPTOR = msg({
	message: 'Star power',
	comment: 'Band game: results row, how many times the player used star power (the score boost).',
});
export const TIMES_DESCRIPTOR = msg({
	message: '{count, plural, one {# time} other {# times}}',
	comment: 'Band game: how many times something happened, for the star power row.',
});
export const FINALE_BONUS_DESCRIPTOR = msg({
	message: 'Finale bonus',
	comment:
		'Band game: results row, the bonus the player banked by landing the final hit of the Big Rock Ending, shown as +points.',
});
export const NOTES_MISSED_DESCRIPTOR = msg({
	message: 'Notes missed',
	comment: 'Band game: results row, how many notes the player missed.',
});
export const AWAITING_RESULT_DESCRIPTOR = msg({
	message: 'Waiting for the score',
	comment: 'Band game: a player whose score has not arrived yet.',
});
export const NO_RESULT_DESCRIPTOR = msg({
	message: 'No score',
	comment: 'Band game: a player whose score never arrived (they closed the game or the song did not load for them).',
});
export const CROWD_TITLE_DESCRIPTOR = msg({
	message: 'Crowd ratings',
	comment: 'Band game: heading of the section where everyone rates the players 1 to 5.',
});
export const CROWD_HINT_DESCRIPTOR = msg({
	message: 'Difficulty does not count here. Everyone can see who gave what.',
	comment: 'Band game: note next to the crowd ratings heading; ratings are public.',
});
export const RATINGS_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# rating} other {# ratings}}',
	comment: 'Band game: how many ratings a player received.',
});
export const RATING_PENDING_DESCRIPTOR = msg({
	message: 'rating',
	comment: 'Band game: a spectator has not rated this player yet, shown with animated dots.',
});
export const MY_RATING_DESCRIPTOR = msg({
	message: 'Your rating',
	comment: 'Band game: label of my own star input for a player.',
});
export const RATE_PLAYER_DESCRIPTOR = msg({
	message: 'Give {name} {stars, plural, one {# star} other {# stars}}',
	comment: 'Band game: accessible name of one star button. {name} is the player.',
});
export const NEXT_PICK_DESCRIPTOR = msg({
	message: 'Song picking opens in {seconds} s',
	comment: 'Band game: countdown at the bottom of the results screen. {seconds} is a whole number.',
});
export const STOP_SONG_DESCRIPTOR = msg({
	message: 'End the song',
	comment: 'Band game: leader-only button during the song that stops it and shows the results with the scores so far.',
});
export const PICK_ANOTHER_DESCRIPTOR = msg({
	message: 'Pick another song',
	comment:
		'Band game: leader-only button on the part picking screen that drops this song and goes back to song picking.',
});
export const GO_TO_PICK_DESCRIPTOR = msg({
	message: 'Pick a song',
	comment: 'Band game: leader-only button that ends the results screen and opens song picking.',
});
export const STOP_SONG_HINT_DESCRIPTOR = msg({
	message: 'The leader can end the song',
	comment: 'Band game: shown during the song to everyone but the leader, in place of the leader’s end-the-song button.',
});
