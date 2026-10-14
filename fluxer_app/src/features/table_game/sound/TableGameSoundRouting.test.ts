// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

// The real Fluxer player (notification/utils/SoundUtils) on a fake Web Audio graph: which file each table game sound
// loads, and where its gain node is connected.
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/notification/utils/CustomSoundDB', () => ({getCustomSound: vi.fn(async () => null)}));

class FakeNode {
	readonly targets: Array<unknown> = [];
	readonly gain = {value: 1};
	constructor(readonly context: FakeAudioContext) {}
	connect(target: unknown): void {
		this.targets.push(target);
	}
	disconnect(): void {}
}

class FakeAudioContext {
	state = 'running';
	readonly destination = {name: 'destination'};
	readonly gains: Array<FakeNode> = [];
	createGain(): FakeNode {
		const node = new FakeNode(this);
		this.gains.push(node);
		return node;
	}
	createMediaElementSource(): FakeNode {
		return new FakeNode(this);
	}
	async resume(): Promise<void> {}
}

class FakeAudio {
	static created: Array<FakeAudio> = [];
	src = '';
	crossOrigin: string | null = null;
	preload = '';
	currentTime = 0;
	loop = false;
	volume = 1;
	constructor() {
		FakeAudio.created.push(this);
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	removeAttribute(): void {}
	load(): void {}
	pause(): void {}
	async play(): Promise<void> {}
}

const realAudio = (globalThis as {Audio?: unknown}).Audio;
const realAudioContext = (globalThis as {AudioContext?: unknown}).AudioContext;
let context: FakeAudioContext;

beforeAll(() => {
	(globalThis as {Audio?: unknown}).Audio = FakeAudio;
	(globalThis as {AudioContext?: unknown}).AudioContext = class extends FakeAudioContext {
		constructor() {
			super();
			context = this;
		}
	};
});

afterAll(() => {
	(globalThis as {Audio?: unknown}).Audio = realAudio;
	(globalThis as {AudioContext?: unknown}).AudioContext = realAudioContext;
});

const SoundUtils = await import('@app/features/notification/utils/SoundUtils');
const {SoundType} = SoundUtils;
const {TABLE_GAME_SOUND_TYPES} = await import('@app/features/table_game/sound/TableGameSoundFiles');

const FILE_OF: Record<string, string> = {
	[SoundType.TableGameTilePick]: 'okey-tas-al',
	[SoundType.TableGameTilePlace]: 'okey-tas-yerlestir',
	[SoundType.TableGameTileDrag]: 'okey-tas-surukle',
	[SoundType.TableGameTileDraw]: 'okey-tas-cek',
	[SoundType.TableGameTileDiscard]: 'okey-tas-at',
	[SoundType.TableGameShuffle]: 'okey-karistir',
	[SoundType.TableGameMeldOpen]: 'okey-per-ac',
	[SoundType.TableGameOkeyFinish]: 'okey-bitir',
	[SoundType.TableGameChessMove]: 'satranc-hamle',
	[SoundType.TableGameChessCapture]: 'satranc-al',
	[SoundType.TableGameChessCheck]: 'satranc-sah',
	[SoundType.TableGameDamaMove]: 'dama-hamle',
	[SoundType.TableGameDamaCapture]: 'dama-al',
	[SoundType.TableGameTavlaDice]: 'tavla-zar',
	[SoundType.TableGameTavlaChecker]: 'tavla-pul',
	[SoundType.TableGameTavlaHit]: 'tavla-kir',
	[SoundType.TableGameTavlaBearOff]: 'tavla-topla',
	[SoundType.TableGameYourTurn]: 'sira-sende',
	[SoundType.TableGameTimeLow]: 'sure-azaldi',
	[SoundType.TableGameWon]: 'oyun-kazandin',
	[SoundType.TableGameEnded]: 'oyun-bitti',
};

describe('table game sounds in the Fluxer player', () => {
	it('every TableGame* sound type has a file', async () => {
		expect(Object.keys(FILE_OF).sort()).toEqual([...TABLE_GAME_SOUND_TYPES].sort());
		for (const type of TABLE_GAME_SOUND_TYPES) {
			FakeAudio.created.length = 0;
			await SoundUtils.playSound(type, false, 0.4);
			expect(FakeAudio.created).toHaveLength(1);
			expect(FakeAudio.created[0]?.src).toMatch(new RegExp(`table-game/${FILE_OF[type]}\\.mp3`));
		}
	});

	it('table sounds stay off the capture bus', async () => {
		const master = SoundUtils.getSoundCaptureMasterGainNode();
		await SoundUtils.playSound(SoundType.Message, false, 0.4);
		const messageGain = context.gains.at(-1);
		// The control: a message sound goes through the master gain that streams capture.
		expect(messageGain?.targets).toEqual([master]);
		for (const type of TABLE_GAME_SOUND_TYPES) {
			await SoundUtils.playSound(type, false, 0.4);
			expect(context.gains.at(-1)?.targets).toEqual([context.destination]);
		}
	});
});
