// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandJamState} from '@app/features/activities/band/flow/BandJamMachine';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/activities/band/jam/JamSettings', () => ({
	default: {rhythmTone: 'power', infoCollapsed: false},
}));
vi.mock('@app/features/activities/band/jam/JamKeyboard', () => ({
	JamKeyboard: class {
		keyDown = () => false;
		keyUp = () => false;
		releaseAll = () => {};
	},
}));
vi.mock('@app/features/activities/band/jam/JamRuntime', () => ({
	JamRuntime: class {
		status = 'ready';
		start = () => {};
		dispose = () => {};
	},
}));
vi.mock('@app/features/activities/band/jam/components/JamBand', () => ({JamBand: () => null}));
vi.mock('@app/features/activities/band/jam/components/JamInfoBox', () => ({JamInfoBox: () => null}));
vi.mock('@app/features/activities/band/jam/components/JamPads', () => ({JamPads: () => null}));
vi.mock('@app/features/activities/band/jam/components/JamTopBar', () => ({JamTopBar: () => null}));
vi.mock('@app/features/activities/band/jam/components/JamInstrumentBar', () => ({
	JamInstrumentBar: () => null,
	JamInstrumentPrompt: () => null,
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));

const {JamScreen} = await import('@app/features/activities/band/jam/components/JamScreen');

const ROOM = {myJamSeat: undefined, session: {keyboardCaptured: true}} as unknown as BandRoom;
const STATE = {phase: 'jam'} as unknown as BandJamState;

let container: HTMLDivElement;
let root: Root;

function mount(): HTMLElement {
	act(() =>
		root.render(<JamScreen room={ROOM} state={STATE} data-flx="activities.band.jam.jam-screen-test.jam-screen" />),
	);
	return container.querySelector<HTMLElement>('[role="application"]')!;
}

beforeEach(() => {
	Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	document.body.replaceChildren();
});

describe('JamScreen', () => {
	it('takes focus when nobody holds it', () => {
		const screen = mount();
		expect(document.activeElement).toBe(screen);
	});

	it('leaves focus in the message box', () => {
		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		textarea.focus();
		mount();
		expect(document.activeElement).toBe(textarea);
	});
});
