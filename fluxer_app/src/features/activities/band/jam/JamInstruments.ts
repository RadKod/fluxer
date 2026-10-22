// SPDX-License-Identifier: AGPL-3.0-or-later

// The jam instruments on Web Audio: samplers for bass, keys, drums and the guitar's clean tone and power chords,
// and the lead guitar (DI samples through one live amp chain per player, with bend, vibrato, pinch harmonic and
// sustain with feedback). Every player gets their own instrument; the decoded samples and the room are shared.
// Times are AudioContext seconds: a local note passes context.currentTime, a remote one its scheduled time.

import {
	type JamSampleBank,
	type JamSampleGroup,
	type LeadSample,
	leadPinchBuffer,
} from '@app/features/activities/band/jam/JamAssets';
import {driveCurve, SECOND_STAGE_INPUT_RANGE, secondStageCurve} from '@app/features/activities/band/jam/JamBake';
import {
	butterworthSectionQs,
	firstOrderHighpass,
	lowHighPassQToDecibels,
} from '@app/features/activities/band/jam/JamDsp';
import {ParamTimeline} from '@app/features/activities/band/jam/JamParamTimeline';
import {drumPiece, type JamDrumPiece, type JamInstrument} from '@app/features/activities/band/jam/JamScales';
import {
	AMP,
	BEND_RELEASE_RISE_S,
	BEND_RELEASE_ZETA,
	BEND_SHAPES,
	BEND_VIBRATO,
	BEND_ZETA,
	type BendSemitones,
	bendPoints,
	FEEDBACK,
	HOLD_VIBRATO,
	holdVibratoDepthAt,
	LEAD_CHOKE_S,
	LEAD_RELEASE_S,
	midiToHz,
	PINCH_VIBRATO,
	PINCH_VOICE_GAIN,
	VIBRATO_RELEASE_S,
	type VibratoShape,
	vibratoOnsetPoints,
} from '@app/features/activities/band/jam/JamTechniques';
import {nearestSample, VoiceAllocator, type VoicePolicy} from '@app/features/activities/band/jam/JamVoices';

// Mix levels relative to the drums, from the band demo's balance (drums 0.30, bass 0.24, guitar 0.21, keys 0.15 of
// RMS) over the samples' own loudness. Starting points; tune by ear in the dev harness.
export const JAM_LEVELS = {
	drums: 1,
	bass: 0.63,
	keys: 0.17,
	guitarClean: 0.28,
	powerChord: 0.19,
	lead: 0.16,
} as const;
// The demo's left/right placement.
const PAN: Readonly<Record<JamInstrument, number>> = {guitar: -0.3, bass: 0, keys: 0.35, drums: 0};
// The kit was normalised per piece when packaged; these are the prototype's relative peaks (DAVUL_SEVIYE).
const DRUM_LEVELS: Readonly<Record<JamDrumPiece, number>> = {
	kick: 0.95,
	snare: 0.85,
	hh_kapali: 0.32,
	hh_acik: 0.38,
	tom_ince: 0.7,
	tom_kalin: 0.75,
	crash: 0.5,
	ride: 0.38,
};
const JAM_MASTER_GAIN = 0.5;
const REVERB_WET = 0.12;
// Releases follow the prototype's cos² tail.
const RELEASE_STEPS = 8;
const STOP_MARGIN_S = 0.02;

export interface JamNoteOptions {
	// 0..1
	readonly velocity?: number;
	// Pinch harmonic to bring out (lead guitar); 0 or absent for a plain note.
	readonly pinchHarmonic?: number;
	// `note` is the chord's root.
	readonly powerChord?: boolean;
	readonly clean?: boolean;
}

export interface JamPlayable {
	readonly instrument: JamInstrument;
	noteOn(note: number, time: number, options?: JamNoteOptions): void;
	noteOff(note: number, time: number): void;
	bendOn(semitones: BendSemitones, time: number): void;
	bendOff(time: number): void;
	allNotesOff(time: number): void;
	dispose(): void;
}

export const JAM_DEFAULT_VELOCITY = 0.9;

export interface JamMixerOptions {
	// Every pitched instrument plays this many cents off concert pitch, to sit in tune with a recording (a freestyle
	// solo over a song); the drums are unaffected.
	readonly tuningCents?: number;
}

// Master bus and room, one per AudioContext; every instrument connects to `input`.
export class JamMixer {
	readonly input: GainNode;
	readonly tuningCents: number;
	private readonly master: GainNode;
	private readonly compressor: DynamicsCompressorNode;
	private readonly reverb: ConvolverNode;
	private readonly reverbSend: GainNode;

	constructor(
		readonly context: BaseAudioContext,
		readonly bank: JamSampleBank,
		destination: AudioNode,
		{tuningCents = 0}: JamMixerOptions = {},
	) {
		this.tuningCents = tuningCents;
		this.input = context.createGain();
		this.reverbSend = context.createGain();
		this.reverbSend.gain.value = REVERB_WET;
		this.reverb = context.createConvolver();
		this.reverb.normalize = false;
		this.reverb.buffer = bank.reverb;
		// The demo's mix bus: a gentle 2.5:1 over the loud parts.
		this.compressor = new DynamicsCompressorNode(context, {
			threshold: -18,
			ratio: 2.5,
			knee: 6,
			attack: 0.01,
			release: 0.2,
		});
		this.master = context.createGain();
		this.master.gain.value = JAM_MASTER_GAIN;
		this.input.connect(this.compressor);
		this.input.connect(this.reverbSend);
		this.reverbSend.connect(this.reverb);
		this.reverb.connect(this.compressor);
		this.compressor.connect(this.master);
		this.master.connect(destination);
	}

	create(instrument: JamInstrument): JamPlayable {
		switch (instrument) {
			case 'guitar':
				return new JamGuitar(this);
			case 'bass':
				return new JamMelodicSampler(this, 'bass', 'bas', {maxVoices: 2, chokeSameNote: true}, 0.06, JAM_LEVELS.bass);
			case 'keys':
				return new JamMelodicSampler(
					this,
					'keys',
					'klavye',
					{maxVoices: 16, chokeSameNote: true},
					0.35,
					JAM_LEVELS.keys,
				);
			case 'drums':
				return new JamDrums(this);
		}
	}

	dispose(): void {
		this.input.disconnect();
		this.reverb.disconnect();
		this.compressor.disconnect();
		this.master.disconnect();
	}
}

function connectPanned(context: BaseAudioContext, destination: AudioNode, pan: number): StereoPannerNode {
	const panner = context.createStereoPanner();
	panner.pan.value = pan;
	panner.connect(destination);
	return panner;
}

function scheduleRelease(gain: ParamTimeline, time: number, releaseS: number): void {
	const from = gain.hold(time);
	for (let i = 1; i <= RELEASE_STEPS; i++) {
		gain.rampTo(time + (releaseS * i) / RELEASE_STEPS, from * Math.cos((Math.PI / 2) * (i / RELEASE_STEPS)) ** 2);
	}
}

// One buffer playing through its own gain; pitch moves by detune in cents.
class SampleVoice {
	readonly gain: ParamTimeline;
	readonly pitch: ParamTimeline;
	private readonly source: AudioBufferSourceNode;
	private readonly gainNode: GainNode;
	private stopped = false;

	constructor(
		context: BaseAudioContext,
		buffer: AudioBuffer,
		destination: AudioNode,
		readonly baseCents: number,
		level: number,
		time: number,
		onEnded: () => void,
	) {
		this.source = context.createBufferSource();
		this.source.buffer = buffer;
		this.gainNode = context.createGain();
		this.gain = new ParamTimeline(level, this.gainNode.gain);
		this.gain.set(time, level);
		this.pitch = new ParamTimeline(baseCents, this.source.detune);
		this.pitch.set(time, baseCents);
		this.source.connect(this.gainNode);
		this.gainNode.connect(destination);
		this.source.onended = () => {
			this.gainNode.disconnect();
			onEnded();
		};
		this.source.start(time);
	}

	release(time: number, releaseS: number): void {
		if (this.stopped) return;
		this.stopped = true;
		scheduleRelease(this.gain, time, releaseS);
		this.source.stop(time + releaseS + STOP_MARGIN_S);
	}
}

// Bend on whichever sample voice is the newest held one.
function bendVoice(voice: SampleVoice, semitones: BendSemitones, time: number): void {
	const from = voice.pitch.hold(time);
	const shape = BEND_SHAPES[semitones];
	for (const point of bendPoints(time, from, voice.baseCents + shape.cents, shape.riseS, BEND_ZETA)) {
		voice.pitch.rampTo(point.time, point.cents);
	}
}

function unbendVoice(voice: SampleVoice, time: number): void {
	const from = voice.pitch.hold(time);
	for (const point of bendPoints(time, from, voice.baseCents, BEND_RELEASE_RISE_S, BEND_RELEASE_ZETA)) {
		voice.pitch.rampTo(point.time, point.cents);
	}
}

// Pitched sampler over one sample group: nearest sample, detuned to the note.
class SampleSet {
	private readonly voices = new Map<number, SampleVoice>();
	private readonly allocator: VoiceAllocator;
	private readonly keys: ReadonlyArray<number>;

	constructor(
		private readonly context: BaseAudioContext,
		private readonly buffers: ReadonlyMap<number | string, AudioBuffer>,
		private readonly output: AudioNode,
		policy: VoicePolicy,
		private readonly releaseS: number,
		private readonly level: number,
		private readonly tuningCents: number,
	) {
		this.allocator = new VoiceAllocator(policy);
		this.keys = [...buffers.keys()].filter((key): key is number => typeof key === 'number');
	}

	play(note: number, time: number, velocity: number): void {
		const {key, detune} = nearestSample(this.keys, note);
		const buffer = this.buffers.get(key);
		if (!buffer) return;
		const {id, cut} = this.allocator.start(note, null, time);
		for (const voice of cut) this.voices.get(voice.id)?.release(time, LEAD_CHOKE_S);
		const cents = detune * 100 + this.tuningCents;
		const voice = new SampleVoice(this.context, buffer, this.output, cents, velocity * this.level, time, () => {
			this.voices.delete(id);
			this.allocator.end(id);
		});
		this.voices.set(id, voice);
	}

	release(note: number, time: number): void {
		for (const tracked of this.allocator.held(note)) {
			this.allocator.release(tracked.id);
			this.voices.get(tracked.id)?.release(time, this.releaseS);
		}
	}

	newestHeld(): SampleVoice | null {
		const tracked = this.allocator.newestHeld();
		return tracked ? (this.voices.get(tracked.id) ?? null) : null;
	}

	releaseAll(time: number): void {
		for (const tracked of this.allocator.active) this.allocator.release(tracked.id);
		for (const voice of this.voices.values()) voice.release(time, this.releaseS);
	}
}

class JamMelodicSampler implements JamPlayable {
	private readonly panner: StereoPannerNode;
	private readonly samples: SampleSet;
	private bent: SampleVoice | null = null;

	constructor(
		mixer: JamMixer,
		readonly instrument: Exclude<JamInstrument, 'guitar' | 'drums'>,
		group: Exclude<JamSampleGroup, 'davul'>,
		policy: VoicePolicy,
		releaseS: number,
		level: number,
	) {
		this.panner = connectPanned(mixer.context, mixer.input, PAN[instrument]);
		this.samples = new SampleSet(
			mixer.context,
			mixer.bank.buffers.get(group) ?? new Map(),
			this.panner,
			policy,
			releaseS,
			level,
			mixer.tuningCents,
		);
	}

	noteOn(note: number, time: number, options: JamNoteOptions = {}): void {
		this.samples.play(note, time, options.velocity ?? JAM_DEFAULT_VELOCITY);
	}

	noteOff(note: number, time: number): void {
		this.samples.release(note, time);
	}

	bendOn(semitones: BendSemitones, time: number): void {
		this.bent = this.samples.newestHeld();
		if (this.bent) bendVoice(this.bent, semitones, time);
	}

	bendOff(time: number): void {
		if (this.bent) unbendVoice(this.bent, time);
		this.bent = null;
	}

	allNotesOff(time: number): void {
		this.samples.releaseAll(time);
	}

	dispose(): void {
		this.allNotesOff(0);
		this.panner.disconnect();
	}
}

const DRUM_POLICY: VoicePolicy = {
	maxVoices: 24,
	chokeSameNote: false,
	maxPerNote: 3,
	chokes: {hh_kapali: ['hh_acik'], hh_acik: ['hh_acik']},
};
const DRUM_CHOKE_S = 0.03;

// One-shots: a note off does nothing, a closed hi-hat cuts the open one.
class JamDrums implements JamPlayable {
	readonly instrument = 'drums';
	private readonly bus: DynamicsCompressorNode;
	private readonly buffers: ReadonlyMap<number | string, AudioBuffer>;
	private readonly allocator = new VoiceAllocator(DRUM_POLICY);
	private readonly voices = new Map<number, SampleVoice>();

	constructor(private readonly mixer: JamMixer) {
		// The demo compressed the kit on its own bus, 4:1 with a fast attack.
		this.bus = new DynamicsCompressorNode(mixer.context, {
			threshold: -24,
			ratio: 4,
			knee: 6,
			attack: 0.003,
			release: 0.1,
		});
		this.bus.connect(mixer.input);
		this.buffers = mixer.bank.buffers.get('davul') ?? new Map();
	}

	noteOn(note: number, time: number, options: JamNoteOptions = {}): void {
		const piece = drumPiece(note);
		const buffer = piece ? this.buffers.get(piece) : undefined;
		if (!piece || !buffer) return;
		const {id, cut} = this.allocator.start(note, piece, time);
		for (const voice of cut) this.voices.get(voice.id)?.release(time, DRUM_CHOKE_S);
		const level = (options.velocity ?? JAM_DEFAULT_VELOCITY) * DRUM_LEVELS[piece] * JAM_LEVELS.drums;
		this.voices.set(
			id,
			new SampleVoice(this.mixer.context, buffer, this.bus, 0, level, time, () => {
				this.voices.delete(id);
				this.allocator.end(id);
			}),
		);
	}

	noteOff(): void {}

	bendOn(): void {}

	bendOff(): void {}

	allNotesOff(time: number): void {
		for (const voice of this.voices.values()) voice.release(time, DRUM_CHOKE_S);
	}

	dispose(): void {
		this.allNotesOff(0);
		this.bus.disconnect();
	}
}

// kutuphane.amfi() as live nodes, then the lead's slap echo. One per guitar player.
class GuitarAmp {
	readonly input: GainNode;
	private readonly nodes: Array<AudioNode> = [];

	constructor(context: BaseAudioContext, destination: AudioNode) {
		const rate = context.sampleRate;
		const butterQ = lowHighPassQToDecibels(Math.SQRT1_2);
		const chain: Array<AudioNode> = [];
		this.input = context.createGain();
		chain.push(this.input);
		chain.push(new BiquadFilterNode(context, {type: 'highpass', frequency: AMP.inputHighpassHz, Q: butterQ}));
		chain.push(
			new BiquadFilterNode(context, {
				type: 'peaking',
				frequency: AMP.midBoost.hz,
				gain: AMP.midBoost.gainDb,
				Q: AMP.midBoost.q,
			}),
		);
		chain.push(new WaveShaperNode(context, {curve: driveCurve(AMP.leadGain, AMP.bias), oversample: '4x'}));
		const dc = firstOrderHighpass(AMP.dcHighpassHz, rate);
		chain.push(new IIRFilterNode(context, {feedforward: dc.feedforward, feedback: dc.feedback}));
		chain.push(new GainNode(context, {gain: 1 / SECOND_STAGE_INPUT_RANGE}));
		chain.push(new WaveShaperNode(context, {curve: secondStageCurve(AMP.secondStageGain), oversample: '4x'}));
		for (const q of butterworthSectionQs(4)) {
			chain.push(
				new BiquadFilterNode(context, {type: 'lowpass', frequency: AMP.cabLowpassHz, Q: lowHighPassQToDecibels(q)}),
			);
		}
		chain.push(new BiquadFilterNode(context, {type: 'highpass', frequency: AMP.cabHighpassHz, Q: butterQ}));
		for (const peak of AMP.cabPeaks) {
			chain.push(new BiquadFilterNode(context, {type: 'peaking', frequency: peak.hz, gain: peak.gainDb, Q: peak.q}));
		}
		const out = new GainNode(context, {gain: JAM_LEVELS.lead});
		chain.push(out);
		for (let i = 1; i < chain.length; i++) chain[i - 1].connect(chain[i]);

		const {echo} = AMP;
		const delay = new DelayNode(context, {delayTime: echo.delayS, maxDelayTime: 1});
		const feedback = new GainNode(context, {gain: echo.feedback});
		const tone = new BiquadFilterNode(context, {type: 'lowpass', frequency: echo.lowpassHz, Q: butterQ});
		const wet = new GainNode(context, {gain: echo.wet});
		const right = new DelayNode(context, {delayTime: echo.rightOffsetS, maxDelayTime: 0.1});
		const merger = new ChannelMergerNode(context, {numberOfInputs: 2});
		out.connect(delay);
		delay.connect(feedback);
		feedback.connect(delay);
		delay.connect(tone);
		tone.connect(wet);
		wet.connect(merger, 0, 0);
		wet.connect(right);
		right.connect(merger, 0, 1);
		out.connect(destination);
		merger.connect(destination);
		this.nodes.push(...chain, delay, feedback, tone, wet, right, merger);
	}

	dispose(): void {
		for (const node of this.nodes) node.disconnect();
	}
}

// Pitch for a lead voice: one constant source carries the note offset and the bend, a second the vibrato centre,
// an LFO the vibrato. All three feed the source's detune and, for feedback, the band-passes' detune, so the
// filters follow the note through bends and vibrato.
class LeadVoice {
	private readonly pitch: ParamTimeline;
	private readonly centre: ParamTimeline;
	private readonly depth: ParamTimeline;
	private readonly main: ParamTimeline;
	private readonly feedbackGain: ParamTimeline | null = null;
	private readonly voiceGain: ParamTimeline;
	private readonly sources: Array<AudioScheduledSourceNode> = [];
	private readonly nodes: Array<AudioNode> = [];
	private readonly pinch: boolean;
	private released = false;
	private bent = false;

	constructor(
		context: BaseAudioContext,
		sample: LeadSample,
		sampleKey: number,
		private readonly baseCents: number,
		private readonly noteOnTime: number,
		velocity: number,
		pinchBuffer: AudioBuffer | null,
		destination: AudioNode,
	) {
		const time = noteOnTime;
		const pinch = pinchBuffer !== null;
		this.pinch = pinch;
		const source = context.createBufferSource();
		if (pinchBuffer) {
			source.buffer = pinchBuffer;
		} else {
			source.buffer = sample.sustain;
			source.loop = true;
			source.loopStart = sample.loopStart;
			source.loopEnd = sample.loopEnd;
		}
		const pitchSource = new ConstantSourceNode(context, {offset: baseCents});
		const centreSource = new ConstantSourceNode(context, {offset: 0});
		const vibrato: VibratoShape = pinch ? PINCH_VIBRATO : HOLD_VIBRATO;
		const lfo = new OscillatorNode(context, {type: 'sine', frequency: vibrato.rateHz});
		const lfoDepth = new GainNode(context, {gain: 0});
		const mainGain = new GainNode(context, {gain: 1});
		const voiceGainNode = new GainNode(context, {gain: 0});
		lfo.connect(lfoDepth);
		const pitchTargets: Array<AudioParam> = [source.detune];
		source.connect(mainGain);
		mainGain.connect(voiceGainNode);
		this.nodes.push(source, pitchSource, centreSource, lfo, lfoDepth, mainGain, voiceGainNode);

		if (!pinch && sample.feedbackNorm > 0) {
			// Tuned to the recorded note's harmonic; the detune inputs carry it to the played pitch.
			const frequency = FEEDBACK.harmonic * midiToHz(sampleKey);
			const bandpasses = [0, 1].map(() => new BiquadFilterNode(context, {type: 'bandpass', frequency, Q: FEEDBACK.q}));
			const fbGainNode = new GainNode(context, {gain: 0});
			source.connect(bandpasses[0]);
			bandpasses[0].connect(bandpasses[1]);
			bandpasses[1].connect(fbGainNode);
			fbGainNode.connect(voiceGainNode);
			for (const filter of bandpasses) pitchTargets.push(filter.detune);
			this.nodes.push(...bandpasses, fbGainNode);
			this.feedbackGain = new ParamTimeline(0, fbGainNode.gain);
		}
		for (const param of pitchTargets) {
			pitchSource.connect(param);
			centreSource.connect(param);
			lfoDepth.connect(param);
		}
		voiceGainNode.connect(destination);

		this.pitch = new ParamTimeline(baseCents, pitchSource.offset);
		this.centre = new ParamTimeline(0, centreSource.offset);
		this.depth = new ParamTimeline(0, lfoDepth.gain);
		this.main = new ParamTimeline(1, mainGain.gain);
		this.voiceGain = new ParamTimeline(0, voiceGainNode.gain);
		const level = velocity * (pinch ? PINCH_VOICE_GAIN : 1);
		this.voiceGain.set(time, level);
		for (const point of vibratoOnsetPoints(time, vibrato)) this.depth.rampTo(point.time, point.value);
		if (this.feedbackGain) {
			const bloom = time + FEEDBACK.bloomAfterS;
			this.main.target(bloom, FEEDBACK.mainGainTarget, FEEDBACK.timeConstantS);
			this.feedbackGain.target(bloom, FEEDBACK.level * sample.feedbackNorm, FEEDBACK.timeConstantS);
		}
		this.sources.push(source, pitchSource, centreSource, lfo);
		for (const node of this.sources) node.start(time);
		source.onended = () => {
			for (const node of this.sources) {
				if (node !== source) node.stop();
			}
			for (const node of this.nodes) node.disconnect();
		};
	}

	bendOn(semitones: BendSemitones, time: number): void {
		if (this.released) return;
		const shape = BEND_SHAPES[semitones];
		const from = this.pitch.hold(time);
		for (const point of bendPoints(time, from, this.baseCents + shape.cents, shape.riseS, BEND_ZETA)) {
			this.pitch.rampTo(point.time, point.cents);
		}
		this.bent = true;
		const vibratoAt = time + BEND_VIBRATO.delayS;
		const depth = this.depth.hold(time);
		this.depth.set(vibratoAt, depth);
		this.depth.rampTo(vibratoAt + BEND_VIBRATO.fadeInS, BEND_VIBRATO.depthCents);
		const centre = this.centre.hold(time);
		this.centre.set(vibratoAt, centre);
		this.centre.rampTo(vibratoAt + BEND_VIBRATO.fadeInS, BEND_VIBRATO.centreCents);
	}

	bendOff(time: number): void {
		if (this.released || !this.bent) return;
		this.bent = false;
		const from = this.pitch.hold(time);
		for (const point of bendPoints(time, from, this.baseCents, BEND_RELEASE_RISE_S, BEND_RELEASE_ZETA)) {
			this.pitch.rampTo(point.time, point.cents);
		}
		const settled = time + VIBRATO_RELEASE_S;
		this.depth.hold(time);
		if (this.pinch) {
			this.depth.rampTo(settled, PINCH_VIBRATO.depthCents);
		} else {
			this.depth.rampTo(settled, holdVibratoDepthAt(this.noteOnTime, settled));
			const onset = vibratoOnsetPoints(this.noteOnTime, HOLD_VIBRATO);
			for (const point of onset) {
				if (point.time > settled) this.depth.rampTo(point.time, point.value);
			}
		}
		this.centre.hold(time);
		this.centre.rampTo(settled, 0);
	}

	release(time: number, fadeS: number): void {
		if (this.released) return;
		this.released = true;
		for (const timeline of [this.pitch, this.centre, this.depth, this.main]) timeline.hold(time);
		this.feedbackGain?.hold(time);
		this.voiceGain.hold(time);
		this.voiceGain.rampTo(time + fadeS, 0);
		this.sources[0]?.stop(time + fadeS + STOP_MARGIN_S);
	}
}

// Clean tone: the clean samples, polyphonic like six strings. Power chords: the pre-rendered distorted chords, one
// at a time. Lead (neither): the DI samples through this player's amp, monophonic, with the techniques.
class JamGuitar implements JamPlayable {
	readonly instrument = 'guitar';
	private readonly panner: StereoPannerNode;
	private readonly amp: GuitarAmp;
	private readonly clean: SampleSet;
	private readonly power: SampleSet;
	private readonly leadKeys: ReadonlyArray<number>;
	private lead: {readonly voice: LeadVoice; readonly note: number} | null = null;
	private bentSample: SampleVoice | null = null;

	constructor(private readonly mixer: JamMixer) {
		const {context, bank} = mixer;
		this.panner = connectPanned(context, mixer.input, PAN.guitar);
		this.amp = new GuitarAmp(context, this.panner);
		this.clean = new SampleSet(
			context,
			bank.buffers.get('gitar_temiz') ?? new Map(),
			this.panner,
			{maxVoices: 6, chokeSameNote: true},
			0.08,
			JAM_LEVELS.guitarClean,
			mixer.tuningCents,
		);
		this.power = new SampleSet(
			context,
			bank.buffers.get('gitar_guc') ?? new Map(),
			this.panner,
			{maxVoices: 1, chokeSameNote: true},
			0.08,
			JAM_LEVELS.powerChord,
			mixer.tuningCents,
		);
		this.leadKeys = [...bank.lead.keys()];
	}

	noteOn(note: number, time: number, options: JamNoteOptions = {}): void {
		const velocity = options.velocity ?? JAM_DEFAULT_VELOCITY;
		if (options.powerChord) {
			this.power.play(note, time, velocity);
			return;
		}
		if (options.clean) {
			this.clean.play(note, time, velocity);
			return;
		}
		if (this.leadKeys.length === 0) return;
		this.lead?.voice.release(time, LEAD_CHOKE_S);
		const {key, detune} = nearestSample(this.leadKeys, note);
		const sample = this.mixer.bank.lead.get(key);
		if (!sample) return;
		const harmonic = options.pinchHarmonic ?? 0;
		const pinch = harmonic > 1 ? leadPinchBuffer(this.mixer.context, this.mixer.bank, key, harmonic) : null;
		const cents = detune * 100 + this.mixer.tuningCents;
		const voice = new LeadVoice(this.mixer.context, sample, key, cents, time, velocity, pinch, this.amp.input);
		this.lead = {voice, note};
	}

	noteOff(note: number, time: number): void {
		this.clean.release(note, time);
		this.power.release(note, time);
		if (this.lead?.note === note) {
			this.lead.voice.release(time, LEAD_RELEASE_S);
			this.lead = null;
		}
	}

	bendOn(semitones: BendSemitones, time: number): void {
		if (this.lead) {
			this.lead.voice.bendOn(semitones, time);
			return;
		}
		this.bentSample = this.clean.newestHeld() ?? this.power.newestHeld();
		if (this.bentSample) bendVoice(this.bentSample, semitones, time);
	}

	bendOff(time: number): void {
		this.lead?.voice.bendOff(time);
		if (this.bentSample) unbendVoice(this.bentSample, time);
		this.bentSample = null;
	}

	allNotesOff(time: number): void {
		this.clean.releaseAll(time);
		this.power.releaseAll(time);
		this.lead?.voice.release(time, LEAD_RELEASE_S);
		this.lead = null;
	}

	dispose(): void {
		this.allNotesOff(0);
		this.amp.dispose();
		this.panner.disconnect();
	}
}
