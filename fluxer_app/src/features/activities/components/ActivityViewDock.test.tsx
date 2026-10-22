// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import ActivityViewDock, {type ActivityViewPlacement} from '@app/features/activities/components/ActivityViewDock';
import {ActivityViewSlot} from '@app/features/activities/components/ActivityViewSlot';
import {act, useEffect} from 'react';
import {createPortal} from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// Stands in for the activity's View: counts its mounts the way a game's canvas and audio graph would be rebuilt.
const lifecycle = {mounts: 0, unmounts: 0};

function ProbeView() {
	useEffect(() => {
		lifecycle.mounts += 1;
		return () => {
			lifecycle.unmounts += 1;
		};
	}, []);
	return <input aria-label="game" data-probe="true" data-flx="activities.activity-view-dock-test.probe-view.game" />;
}

function App({places}: {places: ReadonlyArray<ActivityViewPlacement>}) {
	return (
		<>
			{createPortal(<ProbeView data-flx="activities.activity-view-dock-test.app.probe-view" />, ActivityViewDock.host)}
			{places.map((placement) => (
				<div key={placement} data-place={placement} data-flx="activities.activity-view-dock-test.app.div">
					<ActivityViewSlot
						placement={placement}
						data-flx="activities.activity-view-dock-test.app.activity-view-slot"
					/>
				</div>
			))}
		</>
	);
}

let container: HTMLDivElement;
let root: Root;

function render(places: ReadonlyArray<ActivityViewPlacement>): void {
	act(() => root.render(<App places={places} data-flx="activities.activity-view-dock-test.app" />));
}

function hostPlace(): string | null {
	return ActivityViewDock.host.parentElement?.closest<HTMLElement>('[data-place]')?.dataset.place ?? null;
}

function probe(): HTMLInputElement {
	const input = ActivityViewDock.host.querySelector<HTMLInputElement>('[data-probe]');
	if (!input) throw new Error('The View is not mounted');
	return input;
}

beforeEach(() => {
	Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
	lifecycle.mounts = 0;
	lifecycle.unmounts = 0;
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe('ActivityViewDock', () => {
	it('moves the View between the tile, the stage and the mini window without remounting it', () => {
		render(['tile']);
		const view = probe();
		expect(hostPlace()).toBe('tile');
		expect(ActivityViewDock.placement).toBe('tile');

		render(['stage']);
		expect(hostPlace()).toBe('stage');
		render(['mini']);
		expect(hostPlace()).toBe('mini');
		expect(ActivityViewDock.placement).toBe('mini');
		render(['tile']);
		expect(hostPlace()).toBe('tile');

		expect(probe()).toBe(view);
		expect(lifecycle).toEqual({mounts: 1, unmounts: 0});
	});

	it('parks the View out of sight, still mounted, when no place is on screen', () => {
		render(['tile']);
		const view = probe();
		render([]);
		expect(hostPlace()).toBeNull();
		expect(ActivityViewDock.placement).toBeNull();
		const parking = ActivityViewDock.host.parentElement;
		expect(parking?.inert).toBe(true);
		expect(parking?.getAttribute('aria-hidden')).toBe('true');
		render(['mini']);
		expect(hostPlace()).toBe('mini');
		expect(probe()).toBe(view);
		expect(lifecycle).toEqual({mounts: 1, unmounts: 0});
	});

	it('prefers the bigger place while two are mounted and falls back when it goes', () => {
		render(['tile', 'stage']);
		expect(hostPlace()).toBe('stage');
		render(['tile']);
		expect(hostPlace()).toBe('tile');
		render(['mini', 'tile']);
		expect(hostPlace()).toBe('tile');
		expect(lifecycle).toEqual({mounts: 1, unmounts: 0});
	});

	it('keeps keyboard focus in the game across a move', () => {
		render(['tile']);
		act(() => probe().focus());
		expect(document.activeElement).toBe(probe());
		render(['stage']);
		expect(hostPlace()).toBe('stage');
		expect(document.activeElement).toBe(probe());
	});
});
