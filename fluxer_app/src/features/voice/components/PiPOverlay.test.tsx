// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {PiPOverlay} from '@app/features/voice/components/PiPOverlay';
import type {Room} from 'livekit-client';
import {act, createElement, useSyncExternalStore} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const engine = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	let version = 0;
	return {
		room: null as Room | null,
		bump() {
			version++;
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getVersion: () => version,
	};
});
const renderedRooms = vi.hoisted(() => [] as Array<Room | null>);

vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		get room() {
			return engine.room;
		},
	},
	useMediaEngineVersion: () => useSyncExternalStore(engine.subscribe, engine.getVersion),
}));
vi.mock('@app/features/ui/state/PiP', () => ({
	default: {getIsOpen: () => true, getContent: () => ({type: 'stream'})},
}));
vi.mock('@app/features/voice/components/pip_overlay/shared', () => ({pipOverlayLogger: {debug: vi.fn()}}));
vi.mock('@app/features/voice/components/pip_overlay/PiPOverlayInner', () => ({
	PiPOverlayInner: ({room}: {room: Room | null}) => {
		renderedRooms.push(room);
		return null;
	},
}));

let root: Root;

function fakeRoom(identity: string): Room {
	return {localParticipant: {identity}} as unknown as Room;
}

async function setRoom(room: Room | null): Promise<void> {
	await act(async () => {
		engine.room = room;
		engine.bump();
	});
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	engine.room = null;
	renderedRooms.length = 0;
	root = createRoot(document.createElement('div'));
});

afterEach(() => {
	act(() => root.unmount());
});

describe('PiPOverlay', () => {
	it('follows the current room and drops it when the call ends', async () => {
		const first = fakeRoom('first');
		const second = fakeRoom('second');
		await setRoom(first);
		await act(async () => {
			root.render(createElement(PiPOverlay));
		});
		expect(renderedRooms.at(-1)).toBe(first);

		await setRoom(null);
		expect(renderedRooms.at(-1)).toBeNull();

		await setRoom(second);
		expect(renderedRooms.at(-1)).toBe(second);
	});
});
