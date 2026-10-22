// SPDX-License-Identifier: AGPL-3.0-or-later

// Jam mode's words: the mode switch on the song picker, the jam screen's bar, pads, band and key box.

import type {BandJamInstrument} from '@app/features/activities/band/BandProtocol';
import type {JamBackingStyle} from '@app/features/activities/band/jam/JamBacking';
import type {JamScale} from '@app/features/activities/band/jam/JamScales';
import type {JamRhythmTone} from '@app/features/activities/band/jam/JamSettings';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const MODE_LABEL_DESCRIPTOR = msg({
	message: 'Mode',
	context: 'band-mode',
	comment: 'Band game: accessible name of the switch between playing songs and jamming, at the top of the song picker.',
});
export const MODE_SONGS_DESCRIPTOR = msg({
	message: 'Songs',
	context: 'band-mode',
	comment: 'Band game: first side of the mode switch on the song picker; the band votes on a song and plays it.',
});
export const MODE_JAM_DESCRIPTOR = msg({
	message: 'Jam',
	context: 'band-mode',
	comment:
		'Band game: second side of the mode switch; free play without a song or a score, every key in the room key. In Turkish "Doğaçlama".',
});
export const MODE_LEADER_ONLY_DESCRIPTOR = msg({
	message: '{name} switches between songs and jam',
	comment:
		'Band game: tooltip on the mode switch for everyone but the room leader, who alone can change it. {name} is the leader.',
});
export const MODE_END_JAM_DESCRIPTOR = msg({
	message: 'End the jam and go back to picking a song',
	comment: 'Band game: tooltip on the Songs side of the mode switch while the room jams; only the leader sees it.',
});

export const SCALE_DESCRIPTORS: Readonly<Record<JamScale, MessageDescriptor>> = {
	minorPentatonic: msg({
		message: 'Minor pentatonic',
		context: 'band-jam',
		comment: 'Band game jam mode: a scale, the five-note minor one most rock solos use.',
	}),
	majorPentatonic: msg({
		message: 'Major pentatonic',
		context: 'band-jam',
		comment: 'Band game jam mode: a scale, the five-note major one.',
	}),
	blues: msg({message: 'Blues', context: 'band-jam', comment: 'Band game jam mode: the six-note blues scale.'}),
	naturalMinor: msg({
		message: 'Natural minor',
		context: 'band-jam',
		comment: 'Band game jam mode: a scale, the seven-note natural minor (Aeolian).',
	}),
};

export const KEY_SCALE_DESCRIPTOR = msg({
	message: '{key} {scale}',
	comment:
		'Band game jam mode: the room key and scale, e.g. "A Minor pentatonic". {key} is a note letter (C, F#, A), {scale} a scale name.',
});
export const KEY_LABEL_DESCRIPTOR = msg({
	message: 'Key',
	context: 'band-jam',
	comment: 'Band game jam mode: label of the room key picker (the root note, C to B) in the top bar.',
});
export const SCALE_LABEL_DESCRIPTOR = msg({
	message: 'Scale',
	context: 'band-jam',
	comment: 'Band game jam mode: label of the scale picker in the top bar.',
});
export const TEMPO_LABEL_DESCRIPTOR = msg({
	message: 'Tempo',
	context: 'band-jam',
	comment: 'Band game jam mode: label of the backing loop tempo in the top bar.',
});
export const BPM_DESCRIPTOR = msg({
	message: '{bpm} BPM',
	comment: 'Band game jam mode: the backing loop tempo in beats per minute, e.g. "110 BPM".',
});
export const TEMPO_DOWN_DESCRIPTOR = msg({
	message: 'Slower',
	context: 'band-jam',
	comment: 'Band game jam mode: button that lowers the backing loop tempo by five beats per minute.',
});
export const TEMPO_UP_DESCRIPTOR = msg({
	message: 'Faster',
	context: 'band-jam',
	comment: 'Band game jam mode: button that raises the backing loop tempo by five beats per minute.',
});
export const BACKING_LABEL_DESCRIPTOR = msg({
	message: 'Backing',
	context: 'band-jam',
	comment: 'Band game jam mode: label of the backing loop (drums and bass the game plays) settings in the top bar.',
});
export const BACKING_STYLE_DESCRIPTORS: Readonly<Record<JamBackingStyle, MessageDescriptor>> = {
	rock: msg({message: 'Rock', context: 'band-jam', comment: 'Band game jam mode: backing loop style, a rock beat.'}),
	slowBlues: msg({
		message: 'Slow blues',
		context: 'band-jam',
		comment: 'Band game jam mode: backing loop style, a slow 12/8 blues shuffle.',
	}),
	punk: msg({
		message: 'Punk',
		context: 'band-jam',
		comment: 'Band game jam mode: backing loop style, a fast punk beat.',
	}),
};
export const BACKING_ON_DESCRIPTOR = msg({
	message: 'Loop on',
	context: 'band-jam',
	comment: 'Band game jam mode: toggle in the top bar; pressed while the backing loop plays.',
});
export const BACKING_PARTS_DESCRIPTORS = {
	drumsAndBass: msg({
		message: 'The loop plays drums and bass',
		comment: 'Band game jam mode: tooltip of the backing loop toggle while nobody in the room plays drums or bass.',
	}),
	drums: msg({
		message: 'The loop plays drums; a bandmate has the bass',
		comment: 'Band game jam mode: tooltip of the backing loop toggle while someone plays bass, so the loop drops it.',
	}),
	bass: msg({
		message: 'The loop plays bass; a bandmate has the drums',
		comment:
			'Band game jam mode: tooltip of the backing loop toggle while someone plays drums, so the loop drops them.',
	}),
	none: msg({
		message: 'Bandmates play the drums and the bass, so the loop stays quiet',
		comment:
			'Band game jam mode: tooltip of the backing loop toggle while people in the room play both drums and bass.',
	}),
} as const;
export const LEADER_SETS_DESCRIPTOR = msg({
	message: '{name} sets the key, scale and backing',
	comment: 'Band game jam mode: tooltip over the room settings for everyone but the leader. {name} is the leader.',
});
export const VOLUME_DESCRIPTOR = msg({
	message: 'Volume',
	context: 'band-jam',
	comment: 'Band game jam mode: label of the volume slider for the jam (instruments and backing loop).',
});

export const JAM_INSTRUMENT_DESCRIPTORS: Readonly<Record<BandJamInstrument, MessageDescriptor>> = {
	guitar: msg({
		message: 'Lead guitar',
		context: 'band-jam',
		comment:
			'Band game jam mode: instrument choice, the distorted solo guitar with bends, pinch harmonics and feedback.',
	}),
	rhythm: msg({
		message: 'Rhythm guitar',
		context: 'band-jam',
		comment: 'Band game jam mode: instrument choice, the second guitar playing power chords or a clean tone.',
	}),
	bass: msg({message: 'Bass', context: 'band-jam', comment: 'Band game jam mode: instrument choice, bass guitar.'}),
	keys: msg({message: 'Keys', context: 'band-jam', comment: 'Band game jam mode: instrument choice, piano.'}),
	drums: msg({message: 'Drums', context: 'band-jam', comment: 'Band game jam mode: instrument choice, drum kit.'}),
};
export const INSTRUMENT_LABEL_DESCRIPTOR = msg({
	message: 'Your instrument',
	context: 'band-jam',
	comment: 'Band game jam mode: label before the row of instruments I can pick.',
});
export const LISTEN_DESCRIPTOR = msg({
	message: 'Listen',
	context: 'band-jam',
	comment: 'Band game jam mode: the choice next to the instruments for not playing, only listening to the band.',
});
export const RHYTHM_TONE_DESCRIPTORS: Readonly<Record<JamRhythmTone, MessageDescriptor>> = {
	power: msg({
		message: 'Power chords',
		context: 'band-jam',
		comment: 'Band game jam mode: rhythm guitar sound, distorted two-note chords.',
	}),
	clean: msg({
		message: 'Clean',
		context: 'band-jam',
		comment: 'Band game jam mode: rhythm guitar sound, the clean tone.',
	}),
};
export const PICK_PROMPT_TITLE_DESCRIPTOR = msg({
	message: 'Pick an instrument to play',
	comment: 'Band game jam mode: heading in the middle of the jam screen while I have no instrument.',
});
export const PICK_PROMPT_BODY_DESCRIPTOR = msg({
	message: 'Whatever you play stays in key. Without an instrument you listen to the band.',
	comment: 'Band game jam mode: text under the heading asking me to pick an instrument.',
});

export const OCTAVE_DESCRIPTOR = msg({
	message: 'Octave {octave}',
	comment: 'Band game jam mode: which octave my lanes play, relative to home: "Octave 0", "Octave +1", "Octave -1".',
});
export const BEND_DESCRIPTOR = msg({
	message: 'Bend',
	context: 'band-jam',
	comment: 'Band game jam mode: tag over my lanes while I bend the note. Guitar term; keep it in English if usual.',
});
export const PINCH_DESCRIPTOR = msg({
	message: 'Pinch',
	context: 'band-jam',
	comment: 'Band game jam mode: tag on a lane playing a pinch harmonic (the squealing guitar note). Guitar term.',
});
export const FEEDBACK_DESCRIPTOR = msg({
	message: 'Feedback',
	context: 'band-jam',
	comment: 'Band game jam mode: tag on a lead guitar lane held long enough to howl into amp feedback. Guitar term.',
});
export const DRUM_LANE_DESCRIPTORS: ReadonlyArray<{
	readonly piece: MessageDescriptor;
	readonly alternate: MessageDescriptor | null;
}> = [
	{
		piece: msg({message: 'Kick', context: 'band-jam', comment: 'Band game jam mode: drum pad, the bass drum.'}),
		alternate: null,
	},
	{
		piece: msg({message: 'Snare', context: 'band-jam', comment: 'Band game jam mode: drum pad, the snare drum.'}),
		alternate: null,
	},
	{
		piece: msg({message: 'Hi-hat', context: 'band-jam', comment: 'Band game jam mode: drum pad, the closed hi-hat.'}),
		alternate: msg({
			message: 'Open',
			context: 'band-jam',
			comment: 'Band game jam mode: under the hi-hat pad, what it plays with Shift held: the open hi-hat.',
		}),
	},
	{
		piece: msg({message: 'Tom', context: 'band-jam', comment: 'Band game jam mode: drum pad, the high tom.'}),
		alternate: msg({
			message: 'Floor tom',
			context: 'band-jam',
			comment: 'Band game jam mode: under the tom pad, what it plays with Shift held.',
		}),
	},
	{
		piece: msg({message: 'Crash', context: 'band-jam', comment: 'Band game jam mode: drum pad, the crash cymbal.'}),
		alternate: msg({
			message: 'Ride',
			context: 'band-jam',
			comment: 'Band game jam mode: under the crash pad, what it plays with Shift held: the ride cymbal.',
		}),
	},
];
export const LOADING_DESCRIPTOR = msg({
	message: 'Tuning the instruments… {percent}%',
	comment: 'Band game jam mode: while the instrument samples load at the start of a jam. {percent} is 0 to 100.',
});
export const LOAD_FAILED_DESCRIPTOR = msg({
	message: 'The jam instruments did not load. Check your connection and try again.',
	comment: 'Band game jam mode: when the instrument samples could not be downloaded.',
});
export const NO_AUDIO_DESCRIPTOR = msg({
	message: 'There is no audio output here to play the jam on.',
	comment: 'Band game jam mode: when this device has no audio output the jam could play through.',
});

export const LISTENING_DESCRIPTOR = msg({
	message: 'Listening',
	context: 'band-jam',
	comment: 'Band game jam mode: under the name of a bandmate who joined the jam without an instrument.',
});
export const ALONE_DESCRIPTOR = msg({
	message: 'Jamming alone. Whoever joins the activity shows up here.',
	comment: 'Band game jam mode: in place of the bandmates while nobody else has joined.',
});

export const INFO_TITLE_DESCRIPTOR = msg({
	message: 'Keys',
	context: 'band-jam-info',
	comment: 'Band game jam mode: title of the small box on the right listing which keyboard key does what.',
});
export const INFO_COLLAPSE_DESCRIPTOR = msg({
	message: 'Fold the key box',
	comment: 'Band game jam mode: button that folds the key box on the right down to its title.',
});
export const INFO_EXPAND_DESCRIPTOR = msg({
	message: 'Open the key box',
	comment: 'Band game jam mode: button that opens the folded key box on the right.',
});
export const INFO_LANES_DESCRIPTOR = msg({
	message: 'Five notes of the scale, low to high',
	comment: 'Band game jam mode, key box: what the five lane keys play on guitar, bass and keys.',
});
export const INFO_HOLD_DESCRIPTOR = msg({
	message: 'Hold for a long note',
	comment: 'Band game jam mode, key box: holding a lane key sustains the note.',
});
export const INFO_FEEDBACK_DESCRIPTOR = msg({
	message: 'Hold longer: the amp starts to feed back',
	comment: 'Band game jam mode, key box, lead guitar only: a note held for about two seconds howls into feedback.',
});
export const INFO_BEND_DESCRIPTOR = msg({
	message: 'Bend the note a whole step',
	comment: 'Band game jam mode, key box: what the bend key (Space by default) does while a note sounds.',
});
export const INFO_WIDE_BEND_DESCRIPTOR = msg({
	message: 'Bend a step and a half',
	comment: 'Band game jam mode, key box: Shift with the bend key bends further.',
});
export const INFO_PINCH_DESCRIPTOR = msg({
	message: 'Two neighbouring keys at once: pinch harmonic',
	comment:
		'Band game jam mode, key box, lead guitar only: striking two neighbouring lane keys together plays a squealing pinch harmonic of the lower note.',
});
export const INFO_OCTAVE_DESCRIPTOR = msg({
	message: 'Octave down, octave up',
	comment: 'Band game jam mode, key box: the two keys that move my lanes an octave down or up.',
});
export const INFO_DRUM_LANES_DESCRIPTOR = msg({
	message: 'Kick, snare, hi-hat, tom, crash',
	comment: 'Band game jam mode, key box, drums: what the five lane keys play, in order.',
});
export const INFO_DRUM_ALTERNATE_DESCRIPTOR = msg({
	message: 'With Shift: open hi-hat, floor tom, ride',
	comment: 'Band game jam mode, key box, drums: holding Shift turns three of the pads into other pieces.',
});
export const INFO_DRUM_KICK_DESCRIPTOR = msg({
	message: 'Kick as well',
	comment: 'Band game jam mode, key box, drums: the kick key of the game (Space by default) also plays the kick.',
});
export const INFO_NO_INSTRUMENT_DESCRIPTOR = msg({
	message: 'Pick an instrument and its keys show here.',
	comment: 'Band game jam mode, key box: while I have no instrument.',
});
