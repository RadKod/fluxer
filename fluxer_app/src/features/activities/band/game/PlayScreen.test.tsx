// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import type {BandPlayState} from '@app/features/activities/band/game/PlayRuntime';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/activities/band/game/BandSettings', () => ({
	default: {effectiveInputLatencyMs: 0, missSound: false, duckDepth: 0, volume: 1, highwayView: 'band'},
}));
vi.mock('@app/features/activities/band/game/BandInput', () => ({
	DEFAULT_BAND_KEY_MAP: {},
	BandKeyboard: class {
		keyDown = () => false;
		keyUp = () => false;
		releaseAll = () => {};
	},
}));
vi.mock('@app/features/activities/band/game/PlayStage', () => ({PlayStage: () => null}));
vi.mock('@app/features/activities/band/game/FocusStage', () => ({FocusStage: () => null}));
vi.mock('@app/features/activities/band/game/PlayStageParts', () => ({hasFocusPart: () => false}));

const runtime = vi.hoisted(() => ({
	controller: {myTrack: {part: 'guitar'}, finish: vi.fn(), deployStarPower: vi.fn()},
	audio: {setVolume: vi.fn()},
	dispose: vi.fn(),
	lane: vi.fn(),
	inputMs: vi.fn(),
	whammyKey: vi.fn(),
}));
vi.mock('@app/features/activities/band/game/PlayRuntime', () => ({
	BandAudioUnavailableError: class extends Error {},
	PlayRuntime: {start: vi.fn(async () => runtime)},
}));

const {PlayScreen} = await import('@app/features/activities/band/game/PlayScreen');

const PLAY: BandPlayState = {
	phase: 'play',
	songId: 'a',
	seats: [{part: 'guitar', userId: '1', difficulty: 'easy', ready: true}],
	startAt: 1_000,
};
const ENTRY = {id: 'a', name: 'A'} as BandSongSummary;
const SONG_PACKAGE = {chart: () => ({vocals: null})} as unknown as SongPackage;

let container: HTMLDivElement;
let root: Root;
let session: {state: unknown; isLeader: boolean; leader: null; channelId: string; keyboardCaptured: boolean};

async function mount(): Promise<HTMLElement> {
	await act(async () => {
		root.render(
			<PlayScreen
				session={session as unknown as ActivitySession}
				state={PLAY}
				entry={ENTRY}
				songPackage={SONG_PACKAGE}
				data-flx="activities.band.game.play-screen-test.play-screen"
			/>,
		);
	});
	return container.querySelector<HTMLElement>('[role="application"]')!;
}

beforeEach(() => {
	Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
	vi.clearAllMocks();
	session = {state: PLAY, isLeader: false, leader: null, channelId: '500', keyboardCaptured: true};
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
});

describe('PlayScreen', () => {
	it('reports nothing when the View goes while the room is still on the song', async () => {
		await mount();
		act(() => root.unmount());
		expect(runtime.controller.finish).not.toHaveBeenCalled();
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		root = createRoot(container);
	});

	it('reports what I scored once the room has left the song', async () => {
		await mount();
		session.state = {phase: 'results', songId: 'a', seats: PLAY.seats, results: [], ratings: {}, endsAt: 0};
		act(() => root.unmount());
		expect(runtime.controller.finish).toHaveBeenCalledWith({stopped: true});
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		root = createRoot(container);
	});

	it('takes focus when nobody holds it', async () => {
		const screen = await mount();
		expect(document.activeElement).toBe(screen);
	});

	it('leaves focus in the message box', async () => {
		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		textarea.focus();
		await mount();
		expect(document.activeElement).toBe(textarea);
	});
});
