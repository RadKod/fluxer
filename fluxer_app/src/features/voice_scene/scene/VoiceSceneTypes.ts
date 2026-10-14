// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type {OkeyStage} from '@app/features/table_game/components/okey/Okey101Staging';
import type {RackSlot} from '@app/features/table_game/state/TableGames';
import type {TavlaStep} from '@app/features/table_game/utils/TavlaSteps';
import type {TableGameKind, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

export interface RoomSeat {
	name: string;
	// For a watch seat: its table's slot ('T01').
	group: string;
	position: Vec3;
	table: {slot: string; position: 1 | 2 | 3 | 4} | null;
	watch: {slot: string; index: 1 | 2 | 3 | 4} | null;
}

export interface RoomLayout {
	seats: ReadonlyArray<RoomSeat>;
	stands: ReadonlyArray<Vec3>;
	tables: ReadonlyArray<{slot: string; center: Vec3; topSize: number}>;
	camTarget: Vec3;
	camHome: Vec3;
	// viewDeg: the TV cone's half width (screen tv_view_deg); parseRoomLayout always sets it.
	screen: {center: Vec3; width: number; height: number; normal: Vec3; viewDeg?: number} | null;
	// cam_target pan_x / pan_z: half extents of the box the orbit target may pan inside; 0 when absent.
	camPan: {x: number; z: number};
	// GLB contract rev 4: parseRoomLayout always sets both (a room without them does not load);
	// a layout built by hand may leave them out: nothing is cut away and the closest orbit is the contract's 0.08.
	cutaway?: RoomCutaway;
	// cam_target zoom_min: the room's closest orbit distance, × |cam_home − cam_target|.
	camZoomMin?: number;
}

// The four wall groups and the ceiling group the orbit camera cuts away, read by their extras; `id` (the node's uuid)
// finds the node again, `name` is only a label.
export interface RoomCutaway {
	// wall_plane: a point on the wall's inner face and its outward unit normal, world x/z.
	walls: ReadonlyArray<{name: string; id?: string; point: {x: number; z: number}; normal: {x: number; z: number}}>;
	// ceiling_y: the ceiling's inner face height.
	ceiling: {name: string; id?: string; y: number};
}

export type SceneCameraMode = 'orbit' | 'focus' | 'seat';

export interface SeatViewTarget {
	seat: RoomSeat;
	slot: string;
	game: TableGameKind | null;
	role: 'player' | 'watch';
}

export interface VoiceSceneHandle {
	readonly layout: RoomLayout;
	// CSS pixels inside the canvas box. scale = the mode's reference distance / distance
	// (orbit/focus: |cam_home − cam_target|; seat: SEAT_VIEW_REFERENCE_M, × the seat zoom).
	project(p: Vec3): {x: number; y: number; visible: boolean; scale: number};
	// Fires on every frame drawn after a camera or size change.
	onViewChange(cb: () => void): () => void;
	// Radians; the cam_home direction is 0. Seated, it turns with the look like a turning head (from
	// the seat over the table centre at the pose's own look).
	getCameraAzimuth(): number;
	requestRender(): void;
	// CanvasTexture; calling again marks it dirty.
	setTableTop(slot: string, canvas: HTMLCanvasElement | null): void;
	// Placed on the screen quad.
	attachScreenElement(el: HTMLElement | null): void;
	// whether the camera is inside the TV cone, where the TV's DOM (picture, poster, bar) shows.
	screenInView(): boolean;
	// a wheel over DOM drawn on the canvas (an avatar, the TV poster) handed on to the camera.
	wheel(event: WheelEvent): void;
	// a tester for whether visible room geometry stands between the camera and a point (the DOM cannot be
	// covered by it), over the meshes visible now: one per rest check, never per frame (each call is a raycast).
	occluder(): (point: Vec3) => boolean;
	getCameraMode(): SceneCameraMode;
	onCameraModeChange(cb: (mode: SceneCameraMode) => void): () => void;
	// No effect without layout.screen; tween ≤ 450 ms.
	focusScreen(): void;
	enterSeatView(target: SeatViewTarget): void;
	// focus or seat → the previous orbit pose (tween).
	exitToOrbit(): void;
	// null while there is no parts file or it failed to load.
	mountTableGame(slot: string, game: TableGameKind): TableGame3D | null;
}

export interface TableGame3D {
	update(input: TableScene3DInput): void;
	setDragHandler(handler: TableDragHandler | null): void;
	dispose(): void;
}

export interface TableScene3DInput {
	// Only my own rack plus public state.
	view: TableGameView;
	// "My" table edge; a watcher gets the nearest edge.
	perspective: 1 | 2 | 3 | 4;
	// Okey/101 local rack order; [] for the other games.
	rack: ReadonlyArray<RackSlot>;
	// 101 pending open / add / take from the discard.
	stage: OkeyStage | null;
	// Tavla steps not sent yet.
	pendingTavla: ReadonlyArray<TavlaStep>;
	// Click-click selection.
	selection: TableDragSource | null;
	// Legal targets to highlight.
	targets: ReadonlyArray<TableDropTarget>;
	// Watchers and spectators: false.
	interactive: boolean;
}

export type TableDragSource =
	| {kind: 'rack_tile'; tile: string; cell: number}
	| {kind: 'pile'}
	| {kind: 'discard_top'; position: 1 | 2 | 3 | 4}
	| {kind: 'square'; square: string}
	| {kind: 'tavla_point'; point: number | 'bar'};

export type TableDropTarget =
	| {kind: 'rack_cell'; cell: number}
	| {kind: 'discard_zone'}
	| {kind: 'finish_zone'}
	| {kind: 'meld_zone'}
	| {kind: 'meld_end'; meldId: number; at: 'start' | 'end'}
	| {kind: 'square'; square: string}
	| {kind: 'tavla_point'; point: number}
	| {kind: 'tavla_off'};

export interface TableDragHandler {
	canDrag(source: TableDragSource): boolean;
	// Local sound and legal target highlight.
	onDragStart(source: TableDragSource): void;
	// target null = cancelled (the piece goes back).
	onDrop(source: TableDragSource, target: TableDropTarget | null): void;
	// Click-click (keyboard and screen readers use the 2D panel).
	onSelect(item: TableDragSource | TableDropTarget): void;
}

export interface VoiceSceneOverlayProps {
	handle: VoiceSceneHandle;
	channel: Channel;
}
