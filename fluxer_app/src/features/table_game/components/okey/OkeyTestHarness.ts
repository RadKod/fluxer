// SPDX-License-Identifier: AGPL-3.0-or-later

// Test-only: renders the okey board inside a react-dnd provider whose backend is driven by hand, so a drag is
// begin → hover → drop through dnd-core exactly as the app's HTML5 backend would report it.
import type {Okey101View} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {act, createElement, type ReactNode} from 'react';
import {DndProvider} from 'react-dnd';
import {createRoot, type Root} from 'react-dom/client';

// Would parse with the strict Okey101View schema.
export function testOkey101GameView(overrides: Partial<Okey101View> = {}): Okey101View {
	return {
		game: 'okey101',
		indicator: 't5',
		pile_count: 20,
		discards: [[], [], [], []],
		rack_counts: [21, 21, 21, 21],
		turn: 1,
		phase: 'play',
		deadline_at: null,
		rack: null,
		melds: [],
		opened: ['none', 'none', 'none', 'none'],
		penalties: [0, 0, 0, 0],
		scores: null,
		...overrides,
	};
}

// The slice of dnd-core this harness drives (dnd-core is react-dnd's own dependency, not the app's).
type Identifier = string | symbol;
interface DragDropActions {
	beginDrag(sourceIds: Array<Identifier>): unknown;
	publishDragSource(): unknown;
	hover(targetIds: Array<Identifier>): unknown;
	drop(): unknown;
	endDrag(): unknown;
}
interface DragDropManager {
	getActions(): DragDropActions;
}

export interface OkeyTestHarness {
	host: HTMLDivElement;
	render(children: ReactNode): Promise<void>;
	unmount(): void;
	drag(from: Element, to: Element): void;
}

export function createOkeyTestHarness(): OkeyTestHarness {
	const sources = new Map<Element, Identifier>();
	const targets = new Map<Element, Identifier>();
	let manager: DragDropManager | null = null;
	let root: Root | null = null;
	const host = document.createElement('div');
	const backend = (dragDropManager: DragDropManager) => {
		manager = dragDropManager;
		return {
			setup: () => {},
			teardown: () => {},
			profile: () => ({}),
			connectDragPreview: () => () => {},
			connectDragSource: (id: Identifier, node: Element) => {
				sources.set(node, id);
				return () => sources.delete(node);
			},
			connectDropTarget: (id: Identifier, node: Element) => {
				targets.set(node, id);
				return () => targets.delete(node);
			},
		};
	};
	return {
		host,
		async render(children) {
			document.body.append(host);
			root = createRoot(host);
			await act(async () => root!.render(createElement(DndProvider, {backend: backend as never}, children)));
		},
		unmount() {
			act(() => root?.unmount());
			root = null;
			host.remove();
		},
		drag(from, to) {
			const source = sources.get(from);
			const target = targets.get(to);
			if (source === undefined || target === undefined || !manager) throw new Error('not a drag source/target');
			const actions = manager.getActions();
			act(() => {
				actions.beginDrag([source]);
				actions.publishDragSource();
				actions.hover([target]);
				actions.drop();
				actions.endDrag();
			});
		},
	};
}
