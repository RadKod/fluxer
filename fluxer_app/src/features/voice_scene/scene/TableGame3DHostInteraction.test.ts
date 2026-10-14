// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {testDamaGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import {legalTargets, resolveTableDrop} from '@app/features/table_game/utils/TableDrop';
import {createRoomCameraRig, type RoomCameraRig} from '@app/features/voice_scene/scene/RoomCameraRig';
import {createBoardTableModel} from '@app/features/voice_scene/scene/table/BoardTableModel';
import {boardSquareSize, squarePosition} from '@app/features/voice_scene/scene/table/boardLayout';
import type {TableGame3DModel, TableParts} from '@app/features/voice_scene/scene/table/TableModelTypes';
import type {RoomLayout, TableDragSource, TableScene3DInput} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {damaSquareIndex} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {BoxGeometry, Group, MeshBasicMaterial, PerspectiveCamera, Vector3} from 'three';
import {afterEach, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.example'}}));
const {createTableGame3DHost} = await import('@app/features/voice_scene/scene/TableGame3DHost');

const hosts: Array<ReturnType<typeof createTableGame3DHost>> = [];
const rigs: Array<RoomCameraRig> = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.dispose();
	for (const rig of rigs.splice(0)) rig.dispose();
	vi.restoreAllMocks();
});

async function damaTable(withRig = false) {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
		() => ({fillRect() {}, fillStyle: ''}) as unknown as ReturnType<HTMLCanvasElement['getContext']>,
	);
	const geometry = new BoxGeometry(0.041, 0.012, 0.041).translate(0, 0.006, 0);
	const material = new MeshBasicMaterial();
	const parts: TableParts = {geometry: () => geometry, material: () => material, node: () => null};
	const layout = {
		tables: [{slot: 'T01', center: {x: 0, y: 0.8, z: 0}, topSize: 1.3}],
		seats: [
			{
				name: 'seat_T01_1',
				group: 'T01',
				table: {slot: 'T01', position: 1 as const},
				position: {x: 0, y: 1.1, z: 1.08},
				watch: null,
			},
		],
		stands: [],
		camTarget: {x: 0, y: 0.8, z: 0},
		camHome: {x: 0, y: 1.65, z: 1.5},
		camPan: {x: 0, z: 0},
		screen: null,
	} satisfies RoomLayout;
	const camera = new PerspectiveCamera(55, 1280 / 720, 0.05, 100);
	camera.position.set(0, 1.65, 1.5);
	camera.lookAt(0, 0.8, 0);
	camera.updateMatrixWorld();
	const dom = document.createElement('canvas');
	document.body.appendChild(dom);
	dom.getBoundingClientRect = () => ({left: 0, top: 0, width: 1280, height: 720}) as DOMRect;
	const rig = withRig ? createRoomCameraRig({camera, dom, layout}) : null;
	if (rig) rigs.push(rig);
	const cells = Array<string>(64).fill('.');
	for (const [square, piece] of Object.entries({c2: 'w', c3: 'b', c5: 'b', a2: 'w', a3: 'b'}))
		cells[damaSquareIndex(square)] = piece;
	let view = testView({game: 'dama', gameView: testDamaGameView({board: cells.join(''), legal_moves: ['c2-c4-c6']})});
	let sceneInput: TableScene3DInput = {
		view,
		perspective: 1,
		rack: [],
		stage: null,
		pendingTavla: [],
		selection: null,
		targets: [],
		interactive: true,
	};
	let model!: TableGame3DModel;
	const host = createTableGame3DHost({
		parent: new Group(),
		camera,
		dom,
		layout,
		slot: 'T01',
		game: 'dama',
		parts: Promise.resolve(parts),
		requestRender: vi.fn(),
		factoryFor: () => (options) => {
			model = createBoardTableModel(options);
			return model;
		},
	});
	hosts.push(host);
	const actions: Array<TableGameAction> = [];
	const dropInput = (source: TableDragSource) => ({
		view,
		source,
		me: 1 as const,
		rack: [],
		stage: null,
		tavlaSteps: [],
	});
	host.setDragHandler({
		canDrag: (source) => legalTargets(dropInput(source)).length > 0,
		onDragStart(source) {
			sceneInput = {...sceneInput, targets: legalTargets(dropInput(source))};
			host.update(sceneInput);
		},
		onDrop(source, target) {
			if (!target) return;
			const outcome = resolveTableDrop({...dropInput(source), target});
			if (outcome.kind === 'action') actions.push(outcome.action);
		},
		onSelect: vi.fn(),
	});
	host.update(sceneInput);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const at = (square: string, y = 0.01) => {
		const {x, z} = squarePosition(square, boardSquareSize(1.3));
		const point = new Vector3(x, 0.8 + y, z).project(camera);
		return {clientX: ((point.x + 1) / 2) * 1280, clientY: ((1 - point.y) / 2) * 720};
	};
	const pointer = (type: string, square: string) =>
		dom.dispatchEvent(new PointerEvent(type, {...at(square), button: 0, pointerId: 1, bubbles: true}));
	return {
		host,
		rig,
		dom,
		model,
		actions,
		pointer,
		at,
		presenceUpdate() {
			view = {...view, summary: {...view.summary, version: view.summary.version + 1}};
			host.update({...sceneInput, view});
		},
		changePosition() {
			view = {...view, game_view: testDamaGameView({board: '.'.repeat(64), turn: 3, legal_moves: null})};
			host.update({...sceneInput, view});
		},
	};
}

it('the real camera rig leaves target-only presses uncaptured during a seated tween; outside release still permits the next dama drag', async () => {
	const t = await damaTable(true);
	const capture = vi.spyOn(t.dom, 'setPointerCapture');
	t.rig!.enterSeat({eye: {x: 0, y: 1.65, z: 1.5}, target: {x: 0, y: 0.8, z: 0}, fovDeg: 55});
	expect(t.rig!.tweening()).toBe(true);
	t.pointer('pointerdown', 'f4');
	expect(capture).not.toHaveBeenCalled();
	window.dispatchEvent(new PointerEvent('pointerup', {...t.at('f4'), pointerId: 1, bubbles: true}));
	t.rig!.update(0);
	t.rig!.update(1000);
	t.pointer('pointerdown', 'c2');
	t.pointer('pointermove', 'c6');
	t.pointer('pointerup', 'c6');
	expect(t.actions).toEqual([{type: 'dama_move', path: ['c2', 'c4', 'c6']}]);
	t.dom.remove();
});

it('real dama proxies recover after a target-only release outside the canvas and submit one complete forced capture', async () => {
	const t = await damaTable();
	t.pointer('pointerdown', 'f4');
	window.dispatchEvent(new PointerEvent('pointerup', {...t.at('f4'), pointerId: 1, bubbles: true}));
	t.pointer('pointerdown', 'c2');
	t.pointer('pointermove', 'c6');
	t.host.beforeDraw();
	t.model.animating();
	expect(t.model.pickables().find((piece) => piece.userData.source.square === 'c2')?.visible).toBe(true);
	t.presenceUpdate();
	t.pointer('pointerup', 'c6');
	t.pointer('pointerup', 'c6');
	expect(t.actions).toEqual([{type: 'dama_move', path: ['c2', 'c4', 'c6']}]);
	t.model.animating();
	expect(t.model.pickables().find((piece) => piece.userData.source.square === 'c2')?.visible).toBe(false);
	t.dom.remove();
});

it('a server position update while a real dama proxy is dragged cancels before the proxy is removed', async () => {
	const t = await damaTable();
	const proxy = t.model.pickables().find((piece) => piece.userData.source.square === 'c2')!;
	const home = proxy.position.clone();
	t.pointer('pointerdown', 'c2');
	t.pointer('pointermove', 'c6');
	t.host.beforeDraw();
	expect(proxy.position.equals(home)).toBe(false);
	t.changePosition();
	expect(proxy.parent).toBeNull();
	expect(proxy.position.equals(home)).toBe(true);
	t.pointer('pointerup', 'c6');
	expect(t.actions).toEqual([]);
	t.dom.remove();
});
