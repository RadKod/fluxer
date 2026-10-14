// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout, RoomSeat, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameKind} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// GLB contract rev 3 seat view with rev 4: the room files are checked against the same
// numbers (dogrula.py).
// The seated camera keeps watchers/no-game at 0.14 m; The game camera raises valid game players to 0.18 m (4 cm higher).
// Chess uses a centered 0.54 m eye: board width >= 55.47% at 1280x646 across all rooms; 0.55 m falls below 55%.
// The straight view removes the former 0.20 m lateral eye. Existing GLB opening silhouettes then reach >= 47.54%, versus
// >= 54.68% sideways; Piece silhouettes are measured separately. Framing, readability thresholds and watcher poses stay intact.
// Okey keeps rev 3's distance: from nearer, my upright rack hides my own discard and drop zones (OkeyTableModel tests).
export const SEAT_EYE_LIFT_M = 0.14;
export const SEAT_EYE_LIFT_PLAYER_M = 0.18;
export const SEAT_EYE_LIFT_CHESS_M = 0.54;
export const SEAT_EYE_BACK_M = 0.15;
export const SEAT_EYE_BACK_BOARD_M = 0.05;
export const SEAT_TARGET_SHIFT = 0.12; // × top_size towards the seat; 0 on a watch seat
const SEAT_TARGET_LIFT_M = 0.02;
// seated, the eye stays put and a drag turns the look around it, from the pose's own look this far across and up/down,
// so the players beside me and the TV come into view; the wheel (or two fingers) narrows the view to this share.
export const SEAT_LOOK_YAW = (100 * Math.PI) / 180;
export const SEAT_LOOK_UP = Math.PI / 6;
export const SEAT_LOOK_DOWN = (25 * Math.PI) / 180;
export const SEAT_ZOOM_MIN = 0.4;
export const SEAT_VIEW_REFERENCE_M = 1.0;
export const SEAT_FOV_MIN_DEG = 35;
// 62° left the Oyun Odası near table corners (top 1.4, seats 1.14 m out) inside only 3.6% of the frame.
export const SEAT_FOV_MAX_DEG = 64;
// Kept clear of every frame edge, as a share of the frame's half width/height.
export const SEAT_FRAME_MARGIN = 0.04;
// Height of the game objects above the corners (the corners themselves are framed at this lift).
const SEAT_CORNER_LIFT_M = 0.06;
// the vertical range is hard (no fovFor widening on narrow screens); the horizontal angle never
// exceeds this, so on a wide screen the vertical narrows instead. dogrula.py checks the seat poses at 64° / 100°.
export const SEAT_HFOV_MAX_DEG = 100;

// world sizes the 3D table models normalise their part meshes to (metres). With the seat fov
// near 60° the farthest spots draw at ~300–330 px/m, so these are what make the readability pixel floors hold.
export const SEAT_PIECE_SIZE_M = {
	okeyFace: 0.082, // tile face height; width ×(0.034/0.048); the digit is ≥ 55% of it
	chessKing: 0.095,
	chessPawn: 0.048,
	damaPiece: 0.05, // diameter
	tavlaChecker: 0.04, // diameter
	tavlaDie: 0.04, // edge
} as const;
// chess and dama pieces grow with the board's square (king height, dama piece diameter, × square);
// SEAT_PIECE_SIZE_M stays their floor.
export const SEAT_PIECE_PER_SQUARE = {
	chessKing: 1, // was 1.4; the king then rests on its 0.095 m floor (SEAT_PIECE_SIZE_M)
	damaPiece: 0.85,
} as const;
export const OKEY_DIGIT_SHARE = 0.55;
// the farthest spot each kind of object may take, table-local metres (origin the table-top centre,
// +Z towards the viewer's edge, h = top_size / 2; tablePoint puts +X on the viewer's left, the mirror of the model
// frame, which is harmless as every probe is used at ±x or is symmetric). Models stay inside these.
export const SEAT_READABILITY_PROBES = {
	okeyRackInset: 0.1, // my rack: tiles up to |x| ≤ okeyRackHalfLength, z = h − inset, upright
	okeyRackHalfLength: 0.45,
	okeyRackHeight: 0.19,
	// The two far discard piles sit at their corner, this far in from both edges; the two at my edge lie in the corners
	// past my rack's end caps, nearer my eye than any probe spot (okeyTableLayout NEAR_DISCARD).
	okeyDiscardInset: 0.15,
	okeyMeldInset: 0.2, // the far owner's melds: z ≥ −(h − inset), |x| ≤ okeyMeldHalfWidth
	okeyMeldHalfWidth: 0.3,
	// my own melds lie across the middle at this z (from the centre, not h), tile edges within inner ≤ |x| ≤
	// halfWidth. From the lowest seat eye (Gece Lounge, 0.38 m over the top) my rack's 0.16 m back wall hides the felt
	// in front of that z; the indicator and the 101 pile (three towers at most) take |x| < inner.
	okeyMyMeldZ: -0.07,
	okeyMyMeldInner: 0.096,
	okeyMyMeldHalfWidth: 0.34,
	// my second row lies this far out, where the sight line from my eye clears the first row's tiles
	// (0.06 m behind it, only their tops showed); the far player's own two rows start at h − 0.2. −0.27, not the
	// −0.25 edge (−0.24 fails at the Gece Lounge's eye), so it still reads from an eye 2 cm lower. It is also the outer
	// limit: a third row (−0.33) clears the far player's second row at a 1.3 m table by 6 mm, and from −0.28 out it
	// lands on it (okeyTableLayout.test, my strip three rows deep).
	okeyMySecondRowZ: -0.27,
	// the boards come near and fill the seat view (were 0.045 and 0.62 × 0.46 m).
	boardSquareShare: 0.065, // chess and dama square = share × top_size, board centred
	boardOuterHalfSquares: 32 / 7, // with its frame (4/7 of a square a side) the board reaches this far, in squares
	tavlaBoard: {x: 0.8, z: 0.5867}, // the tavla board's outline, centred, long side along X (the parts' 0.6 × 0.44)
	tavlaRim: 0.035, // its rim over the table (the parts' 0.026 m, scaled with it)
	tavlaFarPoint: {x: 0.33, z: -0.23}, // inside tavlaBoard
	tavlaDie: {x: 0.2, z: 0}, // dice land on the board's centre line, either half
} as const;
// Okey tiles lying on the table lean towards the viewer's eye, at most this far from flat.
const OKEY_MAX_TILT = (70 * Math.PI) / 180;

export const READABILITY_MIN_PX = {
	okeyDigit: 14,
	chessKing: 28,
	chessPawn: 16,
	damaPiece: 18,
	tavlaChecker: 14,
	tavlaDie: 16,
} as const;
export type ReadabilityItem = keyof typeof READABILITY_MIN_PX;
// CSS px, the smallest over the probed spots; only the items of the measured game are present.
export type ReadabilityReport = Partial<Record<ReadabilityItem, number>>;

export interface SeatPose {
	eye: Vec3;
	target: Vec3;
	// Before the aspect's 100° horizontal cap (RoomCameraRig).
	fovDeg: number;
}

type Table = RoomLayout['tables'][number];

const add = (a: Vec3, b: Vec3): Vec3 => ({x: a.x + b.x, y: a.y + b.y, z: a.z + b.z});
const sub = (a: Vec3, b: Vec3): Vec3 => ({x: a.x - b.x, y: a.y - b.y, z: a.z - b.z});
const scale = (a: Vec3, s: number): Vec3 => ({x: a.x * s, y: a.y * s, z: a.z * s});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a.x, a.y, a.z));
const cross = (a: Vec3, b: Vec3): Vec3 => ({
	x: a.y * b.z - a.z * b.y,
	y: a.z * b.x - a.x * b.z,
	z: a.x * b.y - a.y * b.x,
});
const UP: Vec3 = {x: 0, y: 1, z: 0};

function tableOf(layout: RoomLayout, slot: string): Table {
	const table = layout.tables.find((entry) => entry.slot === slot);
	if (!table) throw new Error(`No table ${slot} in this room`);
	return table;
}

// Horizontal unit vector from the table centre out to `point`.
function outwards(table: Table, point: Vec3): Vec3 {
	return normalize({x: point.x - table.center.x, y: 0, z: point.z - table.center.z});
}

function playerSeats(layout: RoomLayout, slot: string, game: TableGameKind | null): Array<RoomSeat> {
	// A kind a newer build set up  has no entry here: framed like a table without a game.
	const positions: ReadonlyArray<number> = (game && TABLE_GAME_POSITIONS[game]) ?? [1, 2, 3, 4];
	return layout.seats.filter((seat) => seat.table?.slot === slot && positions.includes(seat.table.position));
}

interface CameraFrame {
	eye: Vec3;
	forward: Vec3;
	right: Vec3;
	up: Vec3;
}

function cameraFrame(eye: Vec3, target: Vec3): CameraFrame {
	const forward = normalize(sub(target, eye));
	const right = normalize(cross(forward, UP));
	return {eye, forward, right, up: cross(right, forward)};
}

// Camera space: x right, y up, z depth along the view axis.
function toCamera(frame: CameraFrame, point: Vec3): Vec3 {
	const d = sub(point, frame.eye);
	return {x: dot(d, frame.right), y: dot(d, frame.up), z: dot(d, frame.forward)};
}

// Table-local (+Z towards `edge`, +X on the left of someone sitting at that edge, facing the centre) → world.
function tablePoint(table: Table, edge: Vec3, x: number, y: number, z: number): Vec3 {
	const right = {x: -edge.z, y: 0, z: edge.x};
	return add(add(add(table.center, {x: 0, y, z: 0}), scale(edge, z)), scale(right, x));
}

const verticalFor = (horizontalDeg: number, aspect: number): number =>
	(Math.atan(Math.tan((horizontalDeg * Math.PI) / 360) / aspect) * 360) / Math.PI;

// The edge the table models face: a player's own, a watcher's nearest (TableScene3DInput.perspective).
function viewerEdge(layout: RoomLayout, table: Table, slot: string, eye: Vec3): Vec3 {
	const away = outwards(table, eye);
	return layout.seats
		.filter((seat) => seat.table?.slot === slot)
		.map((seat) => outwards(table, seat.position))
		.reduce((best, candidate) => (dot(candidate, away) > dot(best, away) ? candidate : best), away);
}

// a board game's board, half sizes across (x) and along (z) the viewer's edge, its top face over the
// table and how high its pieces rise over the far edge; null for every other game.
function boardHalf(
	game: TableGameKind | null,
	topSize: number,
): {x: number; z: number; face: number; lift: number} | null {
	const probes = SEAT_READABILITY_PROBES;
	if (game === 'tavla')
		return {x: probes.tavlaBoard.x / 2, z: probes.tavlaBoard.z / 2, face: probes.tavlaRim, lift: SEAT_CORNER_LIFT_M};
	if (game !== 'chess' && game !== 'dama' && game !== 'dama_normal') return null;
	const square = probes.boardSquareShare * topSize;
	const half = probes.boardOuterHalfSquares * square;
	return {x: half, z: half, face: 0, lift: game === 'chess' ? chessKingHeight(square) : SEAT_CORNER_LIFT_M};
}

// The drawn sizes on a board of this square (BoardTableModel normalises its parts to them).
export const chessKingHeight = (square: number): number =>
	Math.max(SEAT_PIECE_SIZE_M.chessKing, SEAT_PIECE_PER_SQUARE.chessKing * square);
export const damaPieceSize = (square: number): number =>
	Math.max(SEAT_PIECE_SIZE_M.damaPiece, SEAT_PIECE_PER_SQUARE.damaPiece * square);

// the same eye, yaw and distance; the view tilts until the framed points sit evenly above and below its
// centre. Each step moves the tilt by the imbalance left, which shrinks quickly as the points lie near the centre
// column.
function tilted(eye: Vec3, target: Vec3, framed: ReadonlyArray<Vec3>): Vec3 {
	const offset = sub(target, eye);
	const distance = Math.hypot(offset.x, offset.y, offset.z);
	const level = normalize({x: offset.x, y: 0, z: offset.z});
	let pitch = Math.asin(offset.y / distance);
	const ahead = (): Vec3 => add(scale(level, Math.cos(pitch)), {x: 0, y: Math.sin(pitch), z: 0});
	for (let step = 0; step < 8; step++) {
		const frame = cameraFrame(eye, add(eye, ahead()));
		let top = -Math.PI;
		let bottom = Math.PI;
		for (const point of framed) {
			const c = toCamera(frame, point);
			const angle = Math.atan2(c.y, c.z);
			top = Math.max(top, angle);
			bottom = Math.min(bottom, angle);
		}
		pitch += (top + bottom) / 2;
	}
	return add(eye, scale(ahead(), distance));
}

export function seatedPose(p: {
	layout: RoomLayout;
	seat: RoomSeat;
	slot: string;
	game: TableGameKind | null;
	aspect: number;
}): SeatPose {
	const {layout, seat, slot, game, aspect} = p;
	const table = tableOf(layout, slot);
	const isPlayer = seat.table !== null;
	const away = outwards(table, seat.position);
	const positions: ReadonlyArray<number> = (game && TABLE_GAME_POSITIONS[game]) ?? [];
	const gamePlayer = seat.table?.slot === slot && positions.includes(seat.table.position);
	const board = boardHalf(game, table.topSize);
	const back = board ? SEAT_EYE_BACK_BOARD_M : SEAT_EYE_BACK_M;
	const lift = gamePlayer ? (game === 'chess' ? SEAT_EYE_LIFT_CHESS_M : SEAT_EYE_LIFT_PLAYER_M) : SEAT_EYE_LIFT_M;
	const eye = add(add(seat.position, {x: 0, y: lift, z: 0}), scale(away, back));
	const formulaTarget = add(
		add(table.center, {x: 0, y: SEAT_TARGET_LIFT_M, z: 0}),
		scale(away, isPlayer ? SEAT_TARGET_SHIFT * table.topSize : 0),
	);

	const h = table.topSize / 2;
	const framed: Array<Vec3> = [];
	if (board) {
		// A board game frames its board, not the whole table top, so the board comes near.
		const edge = viewerEdge(layout, table, slot, eye);
		for (const [x, z] of [
			[1, 1],
			[-1, 1],
			[1, -1],
			[-1, -1],
		] as const)
			framed.push(tablePoint(table, edge, x * board.x, z > 0 ? board.face : board.lift, z * board.z));
	} else
		for (const [x, z] of [
			[h, h],
			[-h, h],
			[h, -h],
			[-h, -h],
		] as const)
			framed.push(tablePoint(table, away, x, SEAT_CORNER_LIFT_M, z));
	for (const other of playerSeats(layout, slot, game)) if (other.name !== seat.name) framed.push(other.position);
	if (isPlayer && (game === 'okey' || game === 'okey101')) {
		const {okeyRackInset, okeyRackHalfLength, okeyRackHeight} = SEAT_READABILITY_PROBES;
		for (const x of [okeyRackHalfLength, -okeyRackHalfLength])
			framed.push(tablePoint(table, away, x, okeyRackHeight, h - okeyRackInset));
	}

	// Smallest tan(fov/2) that keeps every framed point SEAT_FRAME_MARGIN inside both frame edges.
	const target = board ? tilted(eye, formulaTarget, framed) : formulaTarget;
	const frame = cameraFrame(eye, target);
	let halfTan = 0;
	for (const point of framed) {
		const c = toCamera(frame, point);
		halfTan = Math.max(halfTan, Math.abs(c.y / c.z), Math.abs(c.x / c.z) / aspect);
	}
	const needed = (Math.atan(halfTan / (1 - SEAT_FRAME_MARGIN)) * 360) / Math.PI;
	const fovDeg = Math.min(SEAT_FOV_MAX_DEG, verticalFor(SEAT_HFOV_MAX_DEG, aspect), Math.max(SEAT_FOV_MIN_DEG, needed));
	// The look points from the seat over the table centre (eye and target both lie on that line, seen from above), so
	// the listener, which turns with the look, starts out facing the table.
	return {eye, target, fovDeg};
}

export function readability(p: {
	pose: SeatPose;
	viewport: {width: number; height: number};
	layout: RoomLayout;
	slot: string;
	game: TableGameKind;
}): ReadabilityReport {
	const {pose, viewport, layout, slot, game} = p;
	const table = tableOf(layout, slot);
	const frame = cameraFrame(pose.eye, pose.target);
	const focalPx = viewport.height / 2 / Math.tan((pose.fovDeg * Math.PI) / 360);
	const screen = (point: Vec3): {x: number; y: number} => {
		const c = toCamera(frame, point);
		return {x: (c.x / c.z) * focalPx, y: (c.y / c.z) * focalPx};
	};
	const segmentPx = (a: Vec3, b: Vec3): number => {
		const sa = screen(a);
		const sb = screen(b);
		return Math.hypot(sa.x - sb.x, sa.y - sb.y);
	};
	const edge = viewerEdge(layout, table, slot, pose.eye);
	const at = (x: number, z: number, y = 0): Vec3 => tablePoint(table, edge, x, y, z);
	const lateral = normalize({x: frame.right.x, y: 0, z: frame.right.z});
	const widthPx = (center: Vec3, size: number): number =>
		segmentPx(add(center, scale(lateral, -size / 2)), add(center, scale(lateral, size / 2)));
	const heightPx = (base: Vec3, size: number): number => segmentPx(base, add(base, {x: 0, y: size, z: 0}));
	const h = table.topSize / 2;
	const probes = SEAT_READABILITY_PROBES;
	const sizes = SEAT_PIECE_SIZE_M;

	if (game === 'okey' || game === 'okey101') {
		const digit = sizes.okeyFace * OKEY_DIGIT_SHARE;
		// A lying tile leans towards the eye until it faces it, but never past OKEY_MAX_TILT from flat.
		const lyingDigitPx = (center: Vec3): number => {
			const toEye = sub(pose.eye, center);
			const horizontal = Math.hypot(toEye.x, toEye.z);
			const tilt = Math.min(OKEY_MAX_TILT, Math.PI / 2 - Math.atan2(toEye.y, horizontal));
			const towards = {x: toEye.x / horizontal, y: 0, z: toEye.z / horizontal};
			const upAxis = add(scale(towards, -Math.cos(tilt)), {x: 0, y: Math.sin(tilt), z: 0});
			return segmentPx(add(center, scale(upAxis, -digit / 2)), add(center, scale(upAxis, digit / 2)));
		};
		const spots: Array<number> = [lyingDigitPx(at(0, 0))];
		const corner = h - probes.okeyDiscardInset;
		for (const [x, z] of [
			[corner, corner],
			[-corner, corner],
			[corner, -corner],
			[-corner, -corner],
		] as const)
			spots.push(lyingDigitPx(at(x, z)));
		for (const x of [probes.okeyMeldHalfWidth, -probes.okeyMeldHalfWidth]) {
			spots.push(lyingDigitPx(at(x, -(h - probes.okeyMeldInset))));
			spots.push(lyingDigitPx(at(probes.okeyMyMeldHalfWidth * Math.sign(x), probes.okeyMyMeldZ)));
		}
		// A player's eye is 0.18 m from their seat; a watch seat keeps ≥ 0.45 m from every table seat (rev 3).
		const seated = layout.seats.some((seat) => {
			const d = sub(seat.position, pose.eye);
			return seat.table?.slot === slot && dot(d, d) < 0.3 ** 2;
		});
		if (seated) {
			// My rack stands upright; its digits sit in the lower tier.
			for (const x of [probes.okeyRackHalfLength, -probes.okeyRackHalfLength]) {
				const base = at(x, h - probes.okeyRackInset, (sizes.okeyFace - digit) / 2);
				spots.push(heightPx(base, digit));
			}
		}
		return {okeyDigit: Math.min(...spots)};
	}
	if (game === 'tavla') {
		const far = probes.tavlaFarPoint;
		const die = probes.tavlaDie;
		return {
			tavlaChecker: Math.min(
				widthPx(at(far.x, far.z), sizes.tavlaChecker),
				widthPx(at(-far.x, far.z), sizes.tavlaChecker),
			),
			tavlaDie: Math.min(widthPx(at(die.x, die.z), sizes.tavlaDie), widthPx(at(-die.x, die.z), sizes.tavlaDie)),
		};
	}
	// Chess and both dama kinds: the far rank's corner squares are the farthest a piece can stand. Pieces at their drawn
	// sizes; the pawn at the least the grown set gives it (the floors' pawn: king, which the parts' own exceeds).
	const square = probes.boardSquareShare * table.topSize;
	const half = 3.5 * square;
	const farSquares = [at(half, -half), at(-half, -half)];
	if (game === 'chess') {
		const pawn = Math.max(sizes.chessPawn, (chessKingHeight(square) * sizes.chessPawn) / sizes.chessKing);
		return {
			chessKing: Math.min(...farSquares.map((spot) => heightPx(spot, chessKingHeight(square)))),
			chessPawn: Math.min(...farSquares.map((spot) => heightPx(spot, pawn))),
		};
	}
	return {damaPiece: Math.min(...farSquares.map((spot) => widthPx(spot, damaPieceSize(square))))};
}
