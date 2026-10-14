// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BOARD_SQUARES,
	type BoardMark,
	type BoardMarkKind,
	type BoardPiece,
	type BoardPieceKind,
	boardMarks,
	boardOuterSize,
	boardPieces,
	boardSquareSize,
	boardTurn,
	isBoardGameView,
	movePath,
	pieceYaw,
	squarePosition,
} from '@app/features/voice_scene/scene/table/boardLayout';
import type {TableGame3DModelFactory, TablePartName} from '@app/features/voice_scene/scene/table/TableModelTypes';
import {chessKingHeight, damaPieceSize, SEAT_PIECE_SIZE_M} from '@app/features/voice_scene/utils/SeatedView';
import type {TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {
	CanvasTexture,
	Color,
	Group,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Quaternion,
	SRGBColorSpace,
	Vector3,
} from 'three';

// Chess, Türk daması and Normal dama on one procedural board. Pieces come from masa-parcalari.glb, unlit,
// one InstancedMesh per piece type × colour. Layout is root-local; the host places and turns root.

export const BOARD_MOVE_MS = 400; // animations ≤ 400 ms
const BOARD_Y = 0.002; // the board's face over the felt
const MARK_Y = BOARD_Y + 0.0008;
const HOP_M = 0.02; // a moving piece lifts this much mid-leg
const TEXTURE_PX = 512;
const FRAME_PX = 32; // wooden frame around the 8 × 56 px squares
const MARK_CAPACITY = 128; // ≥ 64 targets + a 17-square dama path + selection + check
const SIDE_CAPACITY = 16; // a side never has more pieces

// both squares in mid tones so ivory stands off the light one and black off the dark one (≥ 2.5:1); the
// squares part at ~1.8:1. The dark frame parts the board from the green felt.
export const BOARD_PALETTE = {
	light: '#a07a4e',
	dark: '#77502f',
	frame: '#3a2416',
	whitePiece: '#faf6ec',
	blackPiece: '#161210',
} as const;
// The parts' `piece` material is a grey baked light map (median sRGB 167/255, measured on masa-parcalari rev2) that
// the side colour multiplies; alone it would sink ivory into the light squares. One gain per side :
// ivory is read on its chess body, in the bake's shade, so it takes more; black is read on its dama top face, where
// the bake is near white, so it takes less. Calibration knobs for a rebake.
export const PIECE_BAKE_GAIN = {white: 2, black: 1} as const;
const MARK_COLORS: Record<BoardMarkKind, string> = {
	last: '#f2d34b',
	check: '#e0443e',
	selected: '#8fd3ff',
	target: '#2f8fd8',
};
const MARK_OPACITY = 0.5;
const TARGET_MARK_SHARE = 0.5; // a smaller square, so the last-move tint under a target stays visible

const PART: Record<BoardPieceKind, TablePartName> = {
	k: 'piece_k',
	q: 'piece_q',
	r: 'piece_r',
	b: 'piece_b',
	n: 'piece_n',
	p: 'piece_p',
	dm: 'piece_dm',
	dk: 'piece_dk',
};
const CHESS_KINDS: ReadonlyArray<BoardPieceKind> = ['k', 'q', 'r', 'b', 'n', 'p'];
const DAMA_KINDS: ReadonlyArray<BoardPieceKind> = ['dm', 'dk'];

const meshKey = (kind: BoardPieceKind, white: boolean) => `${kind}${white ? 'w' : 'b'}`;

export function drawBoardTexture(canvas: HTMLCanvasElement): void {
	canvas.width = TEXTURE_PX;
	canvas.height = TEXTURE_PX;
	const context = canvas.getContext('2d')!;
	context.fillStyle = BOARD_PALETTE.frame;
	context.fillRect(0, 0, TEXTURE_PX, TEXTURE_PX);
	const square = (TEXTURE_PX - 2 * FRAME_PX) / 8;
	// Top-left is a8 (the plane's far edge in the board frame), so a1 comes out dark.
	for (let row = 0; row < 8; row++)
		for (let file = 0; file < 8; file++) {
			context.fillStyle = (row + file) % 2 === 0 ? BOARD_PALETTE.light : BOARD_PALETTE.dark;
			context.fillRect(FRAME_PX + file * square, FRAME_PX + row * square, square, square);
		}
}

export const createBoardTableModel: TableGame3DModelFactory = ({parts, table, game, requestRender}) => {
	const root = new Group();
	const board = new Group(); // turned so white's side faces the white player's seat
	root.add(board);
	const squareSize = boardSquareSize(table.topSize);
	const kinds = game === 'chess' ? CHESS_KINDS : DAMA_KINDS;

	const canvas = document.createElement('canvas');
	drawBoardTexture(canvas);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.anisotropy = 8; // the far ranks are seen at a grazing angle
	const boardSize = boardOuterSize(table.topSize); // the texture's frame is the same 4/7 of a square a side
	const boardGeometry = new PlaneGeometry(boardSize, boardSize).rotateX(-Math.PI / 2);
	const boardMaterial = new MeshBasicMaterial({map: texture});
	const boardMesh = new Mesh(boardGeometry, boardMaterial);
	boardMesh.position.y = BOARD_Y;
	board.add(boardMesh);

	const baked = parts.material('piece');
	const sideMaterial = (hex: string, gain: number) =>
		new MeshBasicMaterial({
			map: baked instanceof MeshBasicMaterial ? baked.map : null,
			color: new Color(hex).multiplyScalar(gain),
		});
	const whiteMaterial = sideMaterial(BOARD_PALETTE.whitePiece, PIECE_BAKE_GAIN.white);
	const blackMaterial = sideMaterial(BOARD_PALETTE.blackPiece, PIECE_BAKE_GAIN.black);

	// sizes from the parts' bounding boxes. One scale for the whole chess set keeps its proportions and lifts
	// both the king and the pawn to at least their readable sizes; the set grows with the square.
	const box = (kind: BoardPieceKind) => {
		const geometry = parts.geometry(PART[kind]);
		if (!geometry.boundingBox) geometry.computeBoundingBox();
		return geometry.boundingBox!;
	};
	const setScale =
		game === 'chess'
			? Math.max(
					chessKingHeight(squareSize) / (box('k').max.y - box('k').min.y),
					SEAT_PIECE_SIZE_M.chessPawn / (box('p').max.y - box('p').min.y),
				)
			: damaPieceSize(squareSize) / (box('dm').max.x - box('dm').min.x);
	const scale = new Vector3().setScalar(setScale);

	const pieceMeshes = new Map<string, InstancedMesh>();
	for (const kind of kinds)
		for (const white of [true, false]) {
			const mesh = new InstancedMesh(parts.geometry(PART[kind]), white ? whiteMaterial : blackMaterial, SIDE_CAPACITY);
			mesh.frustumCulled = false; // instances move; the board is always in view
			mesh.count = 0;
			pieceMeshes.set(meshKey(kind, white), mesh);
			board.add(mesh);
		}

	const markGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
	const markMaterial = new MeshBasicMaterial({transparent: true, opacity: MARK_OPACITY, depthWrite: false});
	const marks = new InstancedMesh(markGeometry, markMaterial, MARK_CAPACITY);
	marks.frustumCulled = false;
	marks.count = 0;
	marks.setColorAt(0, new Color()); // instanceColor exists from the first frame (no program switch later)
	board.add(marks);

	// flat and invisible; the ray still hits them.
	const zoneGeometry = new PlaneGeometry(squareSize, squareSize).rotateX(-Math.PI / 2);
	const zoneMaterial = new MeshBasicMaterial({visible: false});
	const zones = BOARD_SQUARES.map((square) => {
		const zone = new Mesh(zoneGeometry, zoneMaterial);
		const {x, z} = squarePosition(square, squareSize);
		zone.position.set(x, BOARD_Y, z);
		zone.userData.target = {kind: 'square', square};
		board.add(zone);
		return zone;
	});

	// the host drags a pickable, and instances cannot move one by one. Every piece has a hidden proxy (same
	// part and material) for the host to move; while it is off its home it shows and its instance is left out.
	const proxies = new Map<string, {mesh: Mesh; key: string; home: Vector3}>();

	let pieces: Array<BoardPiece> = [];
	let previous: TableGameView['game_view'] = null;
	let move: {path: Array<string>; square: string; startMs: number} | null = null;

	const point = new Vector3();
	const turn = new Quaternion();
	const size = new Vector3();
	const matrix = new Matrix4();
	const color = new Color();
	const up = new Vector3(0, 1, 0);
	const restAt = (piece: BoardPiece, x: number, z: number, lift = 0) =>
		point.set(x, BOARD_Y - box(piece.kind).min.y * setScale + lift, z);

	const syncProxies = (): void => {
		const occupied = new Set<string>();
		for (const piece of pieces) {
			occupied.add(piece.square);
			const key = meshKey(piece.kind, piece.white);
			const old = proxies.get(piece.square);
			if (old?.key === key) continue;
			if (old) board.remove(old.mesh);
			const mesh = new Mesh(parts.geometry(PART[piece.kind]), piece.white ? whiteMaterial : blackMaterial);
			const {x, z} = squarePosition(piece.square, squareSize);
			mesh.position.copy(restAt(piece, x, z));
			mesh.quaternion.setFromAxisAngle(up, pieceYaw(piece.white));
			mesh.scale.copy(scale);
			mesh.visible = false;
			mesh.userData.source = {kind: 'square', square: piece.square};
			if (game === 'chess') {
				// Select the square on the board plane: a nearer king/queen must not steal a pawn's press.
				// Keep the hit object as this movable proxy, so the host can still drag and restore the piece.
				const zone = zones[BOARD_SQUARES.indexOf(piece.square)]!;
				mesh.raycast = (raycaster, hits) => {
					const start = hits.length;
					zone.raycast(raycaster, hits);
					for (let index = start; index < hits.length; index++) hits[index]!.object = mesh;
				};
			}
			board.add(mesh);
			proxies.set(piece.square, {mesh, key, home: mesh.position.clone()});
		}
		for (const [square, proxy] of proxies)
			if (!occupied.has(square)) {
				board.remove(proxy.mesh);
				proxies.delete(square);
			}
	};

	const writePieces = (nowMs: number): void => {
		const counts = new Map<string, number>();
		for (const piece of pieces) {
			if (proxies.get(piece.square)?.mesh.visible) continue; // being dragged: its proxy draws it
			const key = meshKey(piece.kind, piece.white);
			const mesh = pieceMeshes.get(key);
			if (!mesh) continue;
			let {x, z} = squarePosition(piece.square, squareSize);
			let lift = 0;
			if (move?.square === piece.square) {
				// Leg by leg along the path (a dama capture chain), a small hop on each leg.
				const legs = move.path.length - 1;
				const progress = Math.min(1, (nowMs - move.startMs) / BOARD_MOVE_MS) * legs;
				const leg = Math.min(legs - 1, Math.floor(progress));
				const t = progress - leg;
				const from = squarePosition(move.path[leg]!, squareSize);
				const to = squarePosition(move.path[leg + 1]!, squareSize);
				x = from.x + (to.x - from.x) * t;
				z = from.z + (to.z - from.z) * t;
				lift = Math.sin(Math.PI * t) * HOP_M;
			}
			const index = counts.get(key) ?? 0;
			counts.set(key, index + 1);
			mesh.setMatrixAt(
				index,
				matrix.compose(restAt(piece, x, z, lift), turn.setFromAxisAngle(up, pieceYaw(piece.white)), scale),
			);
		}
		for (const [key, mesh] of pieceMeshes) {
			mesh.count = counts.get(key) ?? 0;
			mesh.visible = mesh.count > 0;
			mesh.instanceMatrix.needsUpdate = true;
		}
	};

	const writeMarks = (list: ReadonlyArray<BoardMark>): void => {
		const shown = list.slice(0, MARK_CAPACITY);
		shown.forEach((mark, index) => {
			const {x, z} = squarePosition(mark.square, squareSize);
			const side = squareSize * (mark.kind === 'target' ? TARGET_MARK_SHARE : 1);
			marks.setMatrixAt(index, matrix.compose(point.set(x, MARK_Y, z), turn.identity(), size.set(side, 1, side)));
			marks.setColorAt(index, color.set(MARK_COLORS[mark.kind]));
		});
		marks.count = shown.length;
		marks.visible = shown.length > 0;
		marks.instanceMatrix.needsUpdate = true;
		marks.instanceColor!.needsUpdate = true;
	};

	return {
		root,
		update(input) {
			const view = isBoardGameView(input.view.game_view) ? input.view.game_view : null;
			// Lobby: an empty board, turned as if position 1 played white.
			board.rotation.y = boardTurn(view?.white ?? 1, input.perspective);
			const nowMs = performance.now();
			pieces = boardPieces(view).filter((piece) => kinds.includes(piece.kind));
			const path = movePath(previous, view);
			const landing = path?.at(-1);
			if (path && pieces.some((piece) => piece.square === landing)) move = {path, square: landing!, startMs: nowMs};
			previous = view;
			syncProxies();
			writePieces(nowMs);
			writeMarks(boardMarks(input));
		},
		pickables: () => [...proxies.values()].map((proxy) => proxy.mesh),
		dropZones: () => zones,
		// The draw loop asks once per drawn frame, after drawing: a change made here shows in the next frame, so the
		// last change asks for that frame itself.
		animating() {
			const nowMs = performance.now();
			let changed = false;
			for (const proxy of proxies.values()) {
				const lifted = !proxy.mesh.position.equals(proxy.home);
				if (lifted !== proxy.mesh.visible) {
					proxy.mesh.visible = lifted;
					changed = true;
				}
			}
			const finished = move !== null && nowMs - move.startMs >= BOARD_MOVE_MS;
			if (move || changed) writePieces(nowMs);
			if (finished) move = null;
			if (changed || finished) requestRender();
			return move !== null;
		},
		dispose() {
			for (const mesh of [...pieceMeshes.values(), marks]) mesh.dispose();
			for (const owned of [
				texture,
				boardGeometry,
				boardMaterial,
				whiteMaterial,
				blackMaterial,
				markGeometry,
				markMaterial,
				zoneGeometry,
				zoneMaterial,
			])
				owned.dispose();
		},
	};
};
