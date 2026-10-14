// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/voice_scene/commands/VoiceSeatCommands', () => ({
	takeVoiceSeat: vi.fn(() => Promise.resolve()),
}));

const {takeVoiceSeat} = await import('@app/features/voice_scene/commands/VoiceSeatCommands');
const {SEAT_FALLBACK_DELAYS_MS, useSeatFallback} = await import('@app/features/voice_scene/hooks/useSeatFallback');

interface Props {
	channelId: string;
	connectionId: string | null;
	seated: boolean;
	hasFreeSeat: boolean;
}

function Probe(props: Props): null {
	useSeatFallback(props);
	return null;
}

let root: Root;
const base: Props = {channelId: '500', connectionId: 'conn-a', seated: false, hasFreeSeat: true};

function render(props: Partial<Props> = {}): void {
	act(() => root.render(createElement(Probe, {...base, ...props})));
}

function advance(ms: number): void {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.mocked(takeVoiceSeat).mockClear();
	root = createRoot(document.createElement('div'));
});

afterEach(() => {
	act(() => root.unmount());
	vi.useRealTimers();
});

describe('useSeatFallback', () => {
	it('uses 3 s, 10 s and 30 s', () => {
		expect(SEAT_FALLBACK_DELAYS_MS).toEqual([3000, 10000, 30000]);
	});

	it('retries at 3/10/30 s while none of my identities is seated, stops when seated or full', () => {
		render();
		advance(2999);
		expect(takeVoiceSeat).not.toHaveBeenCalled();
		advance(1);
		expect(takeVoiceSeat).toHaveBeenCalledTimes(1);
		expect(takeVoiceSeat).toHaveBeenLastCalledWith('500', null);
		advance(7000);
		expect(takeVoiceSeat).toHaveBeenCalledTimes(2);
		advance(20000);
		expect(takeVoiceSeat).toHaveBeenCalledTimes(3);
		advance(120000);
		expect(takeVoiceSeat).toHaveBeenCalledTimes(3);
	});

	it('stops once a seat arrives', () => {
		render();
		advance(3000);
		expect(takeVoiceSeat).toHaveBeenCalledTimes(1);
		render({seated: true});
		advance(60000);
		expect(takeVoiceSeat).toHaveBeenCalledTimes(1);
	});

	it('attribute arrives in time → no PUT', () => {
		render();
		advance(1500);
		render({seated: true});
		advance(60000);
		expect(takeVoiceSeat).not.toHaveBeenCalled();
	});

	it('full room → no fallback PUT', () => {
		render({hasFreeSeat: false});
		advance(60000);
		expect(takeVoiceSeat).not.toHaveBeenCalled();
	});

	it('not connected to this channel → nothing is scheduled', () => {
		render({connectionId: null});
		advance(60000);
		expect(takeVoiceSeat).not.toHaveBeenCalled();
	});

	it('unmount cancels the pending tries', () => {
		render();
		act(() => root.unmount());
		root = createRoot(document.createElement('div'));
		advance(60000);
		expect(takeVoiceSeat).not.toHaveBeenCalled();
	});
});
