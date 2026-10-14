// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomCutaway, RoomLayout, Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';

// GLB contract rev 4: every room's wall groups and ceiling cut away whatever
// stands between the camera and the room, so the orbit goes all the way round, looks down 0°–85° and comes to
// 0.08 × |cam_home − cam_target| (or the room's zoom_min). dogrula.py checks the rooms against these numbers; changing
// one needs a contract rev.
export const CAMERA_POLAR_MIN = Math.PI / 36; // 5° from straight down: looking down 85°
export const CAMERA_POLAR_MAX = Math.PI / 2; // level; cam_target is ≥ 2 m up, so the floor's underside never shows
export const CAMERA_MIN_DISTANCE_FACTOR = 0.08;
export const CAMERA_MAX_DISTANCE_FACTOR = 1;
// OrbitControls scales the distance by 0.95^zoomSpeed per 100 px wheel notch: 1.0 → 0.08 in 20 notches.
export const CAMERA_ZOOM_SPEED = Math.log(CAMERA_MIN_DISTANCE_FACTOR) / (20 * Math.log(0.95));
// a wall or the ceiling group hides once the camera comes this near its plane from inside (what hangs on it reaches
// 0.6 m in, plus the near plane and 0.1 m), so the camera never enters it.
export const CUTAWAY_BAND_M = 0.75;
// the TV layer (DOM above the canvas) shows and takes clicks only inside this cone around the screen's normal:
// ±TV_VIEW_DEG across (a room may narrow it with screen tv_view_deg) and −10°…+45° up; seated, down to −40° (
// a seat's eye sits low under a wall TV).
export const TV_VIEW_DEG = 55;
const TV_ELEVATION_MIN = (-10 * Math.PI) / 180;
const TV_ELEVATION_MIN_SEATED = (-40 * Math.PI) / 180;
const TV_ELEVATION_MAX = Math.PI / 4;
// a wheel notch towards the TV focuses it once the camera is within this many focus distances of the screen.
export const TV_WHEEL_FOCUS_FACTOR = 2;
// TV focus: d = (width / 2) / tan(horizontal view / 2) × 1.08.
export const SCREEN_FOCUS_MARGIN = 1.08;
// camera tweens (TV focus, seat view, back to orbit) end within this.
export const CAMERA_TWEEN_MS = 450;
// No free pan: the target only slides inside the cam_target pan box while zooming towards the cursor.

// Vertical field of view at 16:9: from cam_home (26–32 m away) the whole room fits, near furniture included.
export const REFERENCE_FOV_DEG = 28;
const REFERENCE_ASPECT = 16 / 9;

// Keeps the 16:9 home framing whole: narrower boxes widen the vertical angle instead of cropping the sides.
export function fovFor(aspect: number): number {
	if (aspect >= REFERENCE_ASPECT) return REFERENCE_FOV_DEG;
	const halfTan = Math.tan((REFERENCE_FOV_DEG * Math.PI) / 360) * (REFERENCE_ASPECT / aspect);
	return (Math.atan(halfTan) * 360) / Math.PI;
}

// Angles in OrbitControls spherical terms: azimuth = atan2(x, z) of camera − target, polar from +Y.
export interface CameraLimits {
	homeAzimuth: number;
	minAzimuth: number;
	maxAzimuth: number;
	minPolar: number;
	maxPolar: number;
	minDistance: number;
	maxDistance: number;
}

export function cameraLimits(camHome: Vec3, camTarget: Vec3, zoomMin = CAMERA_MIN_DISTANCE_FACTOR): CameraLimits {
	const dx = camHome.x - camTarget.x;
	const dz = camHome.z - camTarget.z;
	const distance = Math.hypot(dx, camHome.y - camTarget.y, dz);
	return {
		homeAzimuth: Math.atan2(dx, dz),
		minAzimuth: -Infinity,
		maxAzimuth: Infinity,
		minPolar: CAMERA_POLAR_MIN,
		maxPolar: CAMERA_POLAR_MAX,
		minDistance: distance * zoomMin,
		maxDistance: distance * CAMERA_MAX_DISTANCE_FACTOR,
	};
}

// VoiceSceneHandle.getCameraAzimuth: 0 at cam_home, same sign as OrbitControls (counter-clockwise seen from +Y), (−π, π].
export function azimuthFromHome(azimuth: number, homeAzimuth: number): number {
	const delta = (azimuth - homeAzimuth) % (2 * Math.PI);
	if (delta > Math.PI) return delta - 2 * Math.PI;
	if (delta <= -Math.PI) return delta + 2 * Math.PI;
	return delta;
}

// Horizontal only (no vertical slide), x within camTarget ± pan.x and z within camTarget ± pan.z; pan 0 = target fixed.
export function clampTargetToPanBox(target: Vec3, camTarget: Vec3, pan: {x: number; z: number}): Vec3 {
	const clamp = (value: number, centre: number, half: number) =>
		Math.min(centre + half, Math.max(centre - half, value));
	return {x: clamp(target.x, camTarget.x, pan.x), y: camTarget.y, z: clamp(target.z, camTarget.z, pan.z)};
}

// In front of the screen along its normal, far enough that the whole quad fits the view at this aspect with the margin.
// For the contract's 16:9 screen this is the rev 3 d at every aspect (fovFor keeps the 16:9 frame whole).
export function screenFocusPose(
	screen: NonNullable<RoomLayout['screen']>,
	aspect: number,
): {position: Vec3; target: Vec3} {
	const verticalHalfTan = Math.tan((fovFor(aspect) * Math.PI) / 360);
	const d =
		Math.max(screen.width / 2 / (verticalHalfTan * aspect), screen.height / 2 / verticalHalfTan) * SCREEN_FOCUS_MARGIN;
	const {center, normal} = screen;
	return {
		position: {x: center.x + normal.x * d, y: center.y + normal.y * d, z: center.z + normal.z * d},
		target: center,
	};
}

// Near shrinks with the distance so a deep zoom, the TV focus and the seat view do not clip; far covers the room from cam_home.
export function nearFarFor(distanceToTarget: number, homeDistance: number): {near: number; far: number} {
	return {near: Math.min(1, Math.max(0.05, 0.04 * distanceToTarget)), far: 3 * homeDistance};
}

// WebGL geometry cannot cover the TV's DOM layer, so it shows only from inside the TV cone, where the
// room keeps the screen in sight. Screens hang upright: the normal is level.
export function screenInView(screen: NonNullable<RoomLayout['screen']>, camera: Vec3, seated = false): boolean {
	const {center, normal} = screen;
	const dx = camera.x - center.x;
	const dz = camera.z - center.z;
	const across = Math.hypot(dx, dz);
	if (!(across > 0)) return false;
	const facing = (dx * normal.x + dz * normal.z) / (across * Math.hypot(normal.x, normal.z));
	const elevation = Math.atan2(camera.y - center.y, across);
	return (
		facing > 0 &&
		facing >= Math.cos(((screen.viewDeg ?? TV_VIEW_DEG) * Math.PI) / 180) &&
		elevation >= (seated ? TV_ELEVATION_MIN_SEATED : TV_ELEVATION_MIN) &&
		elevation <= TV_ELEVATION_MAX
	);
}

// whether a ray (the cursor's) meets the screen quad from its front.
export function rayHitsScreen(screen: NonNullable<RoomLayout['screen']>, origin: Vec3, direction: Vec3): boolean {
	const {center, normal, width, height} = screen;
	const towards = direction.x * normal.x + direction.y * normal.y + direction.z * normal.z;
	if (!(towards < 0)) return false;
	const t =
		((center.x - origin.x) * normal.x + (center.y - origin.y) * normal.y + (center.z - origin.z) * normal.z) / towards;
	if (!(t > 0)) return false;
	const x = origin.x + direction.x * t - center.x;
	const z = origin.z + direction.z * t - center.z;
	// Along the quad's right (world up × the level normal).
	const across = (x * normal.z - z * normal.x) / Math.hypot(normal.x, normal.z);
	return Math.abs(across) <= width / 2 && Math.abs(origin.y + direction.y * t - center.y) <= height / 2;
}

// Contract rev 4, orbit only: a wall group hides once the camera is within CUTAWAY_BAND_M of its plane or
// beyond it, the ceiling likewise of ceiling_y (pendant lamps hang into the room; dogrula rev 4.1 uses the same band).
export function cutawayHidden(cutaway: RoomCutaway, camera: Vec3): {walls: Array<boolean>; ceiling: boolean} {
	return {
		walls: cutaway.walls.map(
			({point, normal}) => (camera.x - point.x) * normal.x + (camera.z - point.z) * normal.z > -CUTAWAY_BAND_M,
		),
		ceiling: camera.y - cutaway.ceiling.y > -CUTAWAY_BAND_M,
	};
}
