// SPDX-License-Identifier: AGPL-3.0-or-later

import {tableDraftKey} from '@app/features/table_game/utils/TableDraftKey';
import type {
	TableGame3DModel,
	TableGame3DModelFactory,
	TableParts,
} from '@app/features/voice_scene/scene/table/TableModelTypes';
import {loadTableParts} from '@app/features/voice_scene/scene/table/TableParts';
import type {
	RoomLayout,
	TableDragHandler,
	TableDragSource,
	TableDropTarget,
	TableGame3D,
	TableScene3DInput,
} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {type Camera, Group, type Object3D, Plane, Raycaster, Vector2, Vector3} from 'three';

// Below this many CSS px of travel a press is a click (tıkla-tıkla), above it a drag.
const DRAG_THRESHOLD_PX = 4;
// A dragged piece floats this high over the table top.
const DRAG_LIFT_M = 0.03;

export interface TableGame3DHost extends TableGame3D {
	// The draw loop keeps going while this is true (animations only, ≤ 400 ms).
	animating(): boolean;
	// Called once per drawn frame: moves the dragged piece to the latest pointer (one move per frame, ≤ 30 fps).
	beforeDraw(): void;
	// whether a piece lies under this point (CSS px, client space): a press there is the piece's.
	hits(clientX: number, clientY: number): boolean;
}

export interface TableGame3DHostOptions {
	parent: Object3D;
	camera: Camera;
	dom: HTMLElement;
	layout: RoomLayout;
	slot: string;
	game: TableGameKind;
	// Model registry: okey/101 → Okey, chess/dama/dama_normal → Board, tavla → Tavla.
	factoryFor(game: TableGameKind): TableGame3DModelFactory | undefined;
	parts: Promise<TableParts>;
	requestRender(): void;
	// True once a model is on the table (the renderer hides the 2D table top), false once none is (a kind with no
	// model, dispose).
	onModelMounted?(mounted: boolean): void;
}

interface Press {
	pointerId: number;
	x: number;
	y: number;
	source: TableDragSource | null;
	target: TableDropTarget | null;
	object: Object3D | null;
	dragging: boolean;
}

function findUserData<K extends 'source' | 'target'>(
	object: Object3D | null,
	key: K,
): {object: Object3D; value: K extends 'source' ? TableDragSource : TableDropTarget} | null {
	for (let current = object; current; current = current.parent) {
		const value = current.userData[key];
		if (value) return {object: current, value};
	}
	return null;
}

// The host places and turns model.root: position = table centre, +Z towards the perspective edge (the seat at that
// position). Models lay out in root-local space and leave root's own transform alone.
export function createTableGame3DHost(options: TableGame3DHostOptions): TableGame3DHost {
	const {parent, camera, dom, layout, slot, factoryFor, requestRender, onModelMounted} = options;
	const table = layout.tables.find((entry) => entry.slot === slot);
	if (!table) throw new Error(`No table ${slot} in this room`);
	const anchor = new Group();
	anchor.position.set(table.center.x, table.center.y, table.center.z);
	parent.add(anchor);

	let parts: TableParts | null = null;
	let game = options.game;
	let model: TableGame3DModel | null = null;
	let input: TableScene3DInput | null = null;
	let handler: TableDragHandler | null = null;
	let press: Press | null = null;
	let pointer: {x: number; y: number} | null = null;
	let frameAsked = false;
	let disposed = false;
	// What onModelMounted last said: it follows the model itself, so a kind with no model keeps the 2D table top.
	let reported = false;
	const reportMounted = (): void => {
		const mounted = model !== null && !disposed;
		if (mounted === reported) return;
		reported = mounted;
		onModelMounted?.(mounted);
	};
	const raycaster = new Raycaster();
	const dragPlane = new Plane(new Vector3(0, 1, 0), -(table.center.y + DRAG_LIFT_M));
	const restoreAt = new Vector3();

	const turnTo = (perspective: 1 | 2 | 3 | 4): void => {
		const seat = layout.seats.find((entry) => entry.table?.slot === slot && entry.table.position === perspective);
		anchor.rotation.y = seat ? Math.atan2(seat.position.x - table.center.x, seat.position.z - table.center.z) : 0;
	};

	const rayAt = (clientX: number, clientY: number): Raycaster => {
		const rect = dom.getBoundingClientRect();
		const ndc = new Vector2(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-((clientY - rect.top) / rect.height) * 2 + 1,
		);
		anchor.updateMatrixWorld(true);
		raycaster.setFromCamera(ndc, camera);
		return raycaster;
	};
	const hit = (objects: ReadonlyArray<Object3D>, clientX: number, clientY: number): Object3D | null =>
		rayAt(clientX, clientY).intersectObjects([...objects], true)[0]?.object ?? null;

	const endPress = (): void => {
		if (!press) return;
		const current = press;
		press = null;
		pointer = null;
		if (current.object && current.dragging) current.object.position.copy(restoreAt);
		if (dom.hasPointerCapture(current.pointerId)) dom.releasePointerCapture(current.pointerId);
		requestRender();
	};
	const cancelPress = (): void => {
		const current = press;
		endPress();
		if (current?.dragging && current.source) handler?.onDrop(current.source, null);
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0 || press || !model || !input?.interactive || !handler) return;
		const picked = findUserData(hit(model.pickables(), event.clientX, event.clientY), 'source');
		if (picked && handler.canDrag(picked.value)) {
			// Capture phase on the canvas runs before the camera's own listener there: the camera never sees this
			// press, so it does not turn while a piece is dragged.
			event.stopImmediatePropagation();
			event.preventDefault();
			dom.setPointerCapture(event.pointerId);
			press = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				source: picked.value,
				target: null,
				object: picked.object,
				dragging: false,
			};
			return;
		}
		const zone = findUserData(hit(model.dropZones(), event.clientX, event.clientY), 'target');
		// A press on a target only selects on release; a drag from it still turns the camera.
		if (zone)
			press = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				source: null,
				target: zone.value,
				object: null,
				dragging: false,
			};
	};

	const onPointerMove = (event: PointerEvent): void => {
		if (!press || event.pointerId !== press.pointerId) return;
		if (!press.dragging) {
			if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX) return;
			if (!press.source || !press.object) {
				press = null; // a drag that began on a target is the camera's
				return;
			}
			press.dragging = true;
			restoreAt.copy(press.object.position);
			handler?.onDragStart(press.source);
		}
		pointer = {x: event.clientX, y: event.clientY};
		if (!frameAsked) {
			frameAsked = true;
			requestRender();
		}
	};

	const onPointerUp = (event: PointerEvent): void => {
		if (!press || event.pointerId !== press.pointerId) return;
		const current = press;
		if (current.dragging && current.source && model) {
			const zone = findUserData(hit(model.dropZones(), event.clientX, event.clientY), 'target');
			endPress();
			handler?.onDrop(current.source, zone?.value ?? null);
			return;
		}
		endPress();
		const item = current.source ?? current.target;
		if (item) handler?.onSelect(item);
	};

	const onPointerCancel = (event: PointerEvent): void => {
		if (!press || event.pointerId !== press.pointerId) return;
		cancelPress();
	};
	// Target-only presses belong to the camera too and are not captured by this host. A release over the HUD or
	// outside the canvas must still clear them; it must not select a square or finish a gameplay move.
	const onOutsideRelease = (event: PointerEvent): void => {
		if (!event.composedPath().includes(dom)) onPointerCancel(event);
	};
	const doc = dom.ownerDocument;
	const win = doc.defaultView;

	dom.addEventListener('pointerdown', onPointerDown, {capture: true});
	dom.addEventListener('pointermove', onPointerMove);
	dom.addEventListener('pointerup', onPointerUp);
	dom.addEventListener('pointercancel', onPointerCancel);
	dom.addEventListener('lostpointercapture', onPointerCancel);
	dom.addEventListener('contextmenu', cancelPress);
	win?.addEventListener('pointerup', onOutsideRelease, {capture: true});
	win?.addEventListener('pointercancel', onOutsideRelease, {capture: true});
	win?.addEventListener('blur', cancelPress);
	doc.addEventListener('visibilitychange', cancelPress);

	const unmountModel = (): void => {
		if (!model) return;
		endPress();
		anchor.remove(model.root);
		model.dispose();
		model = null;
	};
	// A fresh model for the current kind; in the lobby (game_view null) it is an empty board of that kind.
	const mountModel = (): void => {
		const factory = factoryFor(game);
		if (!parts || !factory) return;
		model = factory({parts, table: {center: table.center, topSize: table.topSize}, game, requestRender});
		anchor.add(model.root);
		if (input) {
			turnTo(input.perspective);
			model.update(input);
		}
	};

	options.parts.then(
		(loaded) => {
			if (disposed) return;
			parts = loaded;
			mountModel();
			reportMounted();
			requestRender();
		},
		() => {
			// loadTableParts already logged it; the 2D table top stays.
		},
	);

	return {
		update(next) {
			const changed =
				input &&
				(input.perspective !== next.perspective ||
					input.view.viewer_position !== next.view.viewer_position ||
					tableDraftKey(input.view) !== tableDraftKey(next.view));
			input = next;
			// A server move can remove the dragged proxy. Restore and cancel before the model changes; local marks
			// and presence-only writes keep the same draft key and leave the drag intact.
			if (press && (!next.interactive || changed)) cancelPress();
			// The table was set up again with another game: that kind's model replaces the old one.
			if (next.view.summary.game !== game) {
				game = next.view.summary.game;
				unmountModel();
				mountModel();
				reportMounted();
				requestRender();
				return;
			}
			if (!model) return;
			turnTo(next.perspective);
			model.update(next);
			requestRender();
		},
		setDragHandler(next) {
			handler = next;
			if (!next) endPress();
		},
		animating: () => model?.animating() ?? false,
		hits: (clientX, clientY) => model !== null && hit(model.pickables(), clientX, clientY) !== null,
		beforeDraw() {
			frameAsked = false;
			if (!press?.dragging || !press.object?.parent || !pointer) return;
			const point = rayAt(pointer.x, pointer.y).ray.intersectPlane(dragPlane, new Vector3());
			if (point) press.object.position.copy(press.object.parent.worldToLocal(point));
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			endPress();
			dom.removeEventListener('pointerdown', onPointerDown, {capture: true});
			dom.removeEventListener('pointermove', onPointerMove);
			dom.removeEventListener('pointerup', onPointerUp);
			dom.removeEventListener('pointercancel', onPointerCancel);
			dom.removeEventListener('lostpointercapture', onPointerCancel);
			dom.removeEventListener('contextmenu', cancelPress);
			win?.removeEventListener('pointerup', onOutsideRelease, {capture: true});
			win?.removeEventListener('pointercancel', onOutsideRelease, {capture: true});
			win?.removeEventListener('blur', cancelPress);
			doc.removeEventListener('visibilitychange', cancelPress);
			unmountModel();
			reportMounted();
			parent.remove(anchor);
			requestRender();
		},
	};
}

// VoiceSceneHandle.mountTableGame: null when there is no parts file or it failed to load before (2D table top stays).
export function mountTableGame3D(options: Omit<TableGame3DHostOptions, 'parts'>): TableGame3DHost | null {
	const parts = loadTableParts();
	return parts ? createTableGame3DHost({...options, parts}) : null;
}
