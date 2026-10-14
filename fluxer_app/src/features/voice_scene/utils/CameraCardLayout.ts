// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout, RoomSeat, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';

export interface CameraCard {
	mode: 'room' | 'seat';
	table: RoomLayout['tables'][number];
	lane?: number;
}

export interface CameraCardViewport {
	width: number;
	height: number;
	avoid?: {left: number; right: number; top: number; bottom: number};
	occupied?: ReadonlyArray<{left: number; right: number; top: number; bottom: number}>;
}

export function isTableCameraSeat(seat: RoomSeat | undefined): boolean {
	return !!seat?.table && /^seat_T\d{2}_[1-4]$/.test(seat.name);
}

// Screen-sized cards share this placement with the subscription planner. Keep faces at their projected seats;
// only an overlap or an off-screen point moves a card away from the table's pieces/rack.
export function cameraCardPlacement(
	handle: VoiceSceneHandle,
	projected: ReturnType<VoiceSceneHandle['project']>,
	card: CameraCard,
	viewport: CameraCardViewport,
) {
	const seated = card.mode === 'seat';
	const width = Math.min(viewport.width - 16, (viewport.width * (seated ? 205 : 66)) / 1440);
	const height = width * (seated ? 9 / 16 : 3 / 4);
	const clampX = (x: number) => Math.max(width / 2 + 8, Math.min(viewport.width - width / 2 - 8, x));
	const clampY = (y: number) => Math.max(height / 2 + 8, Math.min(viewport.height - height / 2 - 8, y));
	let x = clampX(projected.x);
	let y = clampY(projected.y);
	if (seated && (projected.y < 0 || projected.y > viewport.height)) {
		x = viewport.width / 2 + (card.lane ?? 0) * (width + 16);
		y = height / 2 + 8;
	}
	{
		const {center, topSize} = card.table;
		const corners = [-1, 1].flatMap((dx) =>
			[-1, 1].map((dz) =>
				handle.project({
					x: center.x + (dx * topSize) / 2,
					y: center.y,
					z: center.z + (dz * topSize) / 2,
				}),
			),
		);
		const obstacles = [
			{
				left: Math.min(...corners.map((p) => p.x)) - 8,
				right: Math.max(...corners.map((p) => p.x)) + 8,
				top: Math.min(...corners.map((p) => p.y)) - 8,
				bottom: Math.max(...corners.map((p) => p.y)) + 8,
			},
			...(viewport.avoid
				? [
						{
							left: viewport.avoid.left - 8,
							right: viewport.avoid.right + 8,
							top: viewport.avoid.top - 8,
							bottom: viewport.avoid.bottom + 8,
						},
					]
				: []),
			...(viewport.occupied ?? []).map((rect) => ({
				left: rect.left - 8,
				right: rect.right + 8,
				top: rect.top - 8,
				bottom: rect.bottom + 8,
			})),
		];
		const overlaps = (p: {x: number; y: number}) =>
			obstacles.some(
				(rect) =>
					p.x + width / 2 > rect.left &&
					p.x - width / 2 < rect.right &&
					p.y + height / 2 > rect.top &&
					p.y - height / 2 < rect.bottom,
			);
		if (overlaps({x, y})) {
			const xs = [x, ...obstacles.flatMap(({left, right}) => [left - width / 2, right + width / 2])];
			const ys = [y, ...obstacles.flatMap(({top, bottom}) => [top - height / 2, bottom + height / 2])];
			const options = xs
				.flatMap((x) => ys.map((y) => ({x, y})))
				.filter(
					(p) =>
						p.x >= width / 2 + 8 &&
						p.x <= viewport.width - width / 2 - 8 &&
						p.y >= height / 2 + 8 &&
						p.y <= viewport.height - height / 2 - 8 &&
						!overlaps(p),
				);
			options.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
			if (options[0]) ({x, y} = options[0]);
			else if (seated) {
				x = viewport.width / 2 + (card.lane ?? 0) * (width + 16);
				y = height / 2 + 8;
			}
		}
	}
	return {
		x: clampX(x),
		y: clampY(y),
		width,
		height,
		visible: seated ? Number.isFinite(projected.x) && Number.isFinite(projected.y) : projected.visible,
	};
}
