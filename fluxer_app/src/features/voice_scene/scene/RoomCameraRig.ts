// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout, SceneCameraMode} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {
	CAMERA_TWEEN_MS,
	CAMERA_ZOOM_SPEED,
	cameraLimits,
	clampTargetToPanBox,
	fovFor,
	azimuthFromHome as fromHome,
	nearFarFor,
	rayHitsScreen,
	screenFocusPose,
	screenInView,
	TV_WHEEL_FOCUS_FACTOR,
} from '@app/features/voice_scene/utils/CameraLimits';
import {
	SEAT_FOV_MAX_DEG,
	SEAT_FOV_MIN_DEG,
	SEAT_LOOK_DOWN,
	SEAT_LOOK_UP,
	SEAT_LOOK_YAW,
	SEAT_ZOOM_MIN,
	type SeatPose,
} from '@app/features/voice_scene/utils/SeatedView';
import {type PerspectiveCamera, TOUCH, Vector3} from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

// The room camera: the orbit (contract rev 4: all the way round, looking down 0°–85°,
// zoom towards the cursor inside the cam_target pan box; a wheel on a near TV focuses it), the TV focus and the seat view
// (the eye stays put and a drag looks around it, the wheel or two fingers narrow the view towards the cursor, a double
// click or tap on empty space returns to the pose). It draws nothing itself; update() says whether another frame is due,
// onChange() whenever the view moved.
export interface RoomCameraRig {
	readonly camera: PerspectiveCamera;
	// true while damping or a tween is still running.
	update(nowMs: number): boolean;
	// Seat mode applies the seat angle limits to the pose's fov for the new aspect.
	setAspect(aspect: number): void;
	mode(): SceneCameraMode;
	// true while a tween runs (into or out of the TV focus or a seat, or back to the seat's own look).
	tweening(): boolean;
	focusScreen(): void;
	// keepLook: the same seat posed again (a resize, its game changing): the look and the zoom stay, the eye
	// glides to the new pose's; otherwise the seat's own look.
	enterSeat(pose: SeatPose, keepLook?: boolean): void;
	exitToOrbit(): void;
	// Radians, 0 at cam_home, from the way the camera looks; seated, the listener turns with the look.
	azimuthFromHome(): number;
	// seated, how much larger the narrowed view draws things than the pose's own angle; 1 otherwise.
	zoomScale(): number;
	onChange(cb: () => void): () => void;
	dispose(): void;
}

interface Pose {
	position: Vector3;
	target: Vector3;
	fov: (aspect: number) => number; // vertical degrees
}

// the seat view's own vertical angle stays within [35°, 64°] and its horizontal angle within 100° (wide boxes
// narrow the vertical); the seat zoom narrows it from there down to SEAT_ZOOM_MIN of it.
const SEAT_HORIZONTAL_FOV_MAX_DEG = 100;
const seatFov = (fovDeg: number, aspect: number): number =>
	Math.min(
		Math.min(SEAT_FOV_MAX_DEG, Math.max(SEAT_FOV_MIN_DEG, fovDeg)),
		(Math.atan(Math.tan((SEAT_HORIZONTAL_FOV_MAX_DEG * Math.PI) / 360) / aspect) * 360) / Math.PI,
	);
// The orbit default turns a 90° sweep in under 100 px of drag; half speed keeps it controllable.
const ORBIT_ROTATE_SPEED = 0.5;
// Seated presses: within this much travel a press is a tap; two taps this near in time and place are a double tap.
const TAP_SLOP_PX = 6;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const toVector = (p: {x: number; y: number; z: number}): Vector3 => new Vector3(p.x, p.y, p.z);
const halfTan = (fovDeg: number): number => Math.tan((fovDeg * Math.PI) / 360);

export function createRoomCameraRig({
	camera,
	dom,
	layout,
	pickedAt,
}: {
	camera: PerspectiveCamera;
	dom: HTMLElement;
	layout: RoomLayout;
	// whether a 3D table piece lies under this point (TableGame3DHost.hits); a double tap there is not the look's.
	pickedAt?: (clientX: number, clientY: number) => boolean;
}): RoomCameraRig {
	const {camHome, camTarget, camPan} = layout;
	const limits = cameraLimits(camHome, camTarget, layout.camZoomMin);
	const homeDistance = limits.maxDistance;
	const listeners = new Set<() => void>();
	const emit = (): void => {
		for (const listener of listeners) listener();
	};

	let mode: SceneCameraMode = 'orbit';
	let seatPose: SeatPose | null = null;
	// Seated: the view angle as a share of the pose's own (seat zoom), and the eye's distance to the look target.
	let zoom = 1;
	let seatDistance = 1;
	let orbitPose: Omit<Pose, 'fov'> | null = null;
	let tween: {from: Omit<Pose, 'fov'> & {fov: number}; to: Pose; start: number | null} | null = null;
	// Where the cursor ray meets the cam_target height at the wheel being handled; the dolly then scales about it.
	let cursor: Vector3 | null = null;
	let lastDistance = homeDistance;
	const shift = new Vector3();
	// The pose last reported through onChange, and whether the current update() reported a new one.
	const shownPosition = new Vector3(Number.NaN, 0, 0);
	const shownTarget = new Vector3();
	let moved = false;

	const viewFov = (aspect: number): number =>
		mode === 'seat' && seatPose ? seatFov(seatPose.fovDeg, aspect) * zoom : fovFor(aspect);
	const cursorRay = (clientX: number, clientY: number): Vector3 | null => {
		const rect = dom.getBoundingClientRect();
		if (!(rect.width > 0 && rect.height > 0)) return null;
		camera.updateMatrixWorld();
		return new Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5)
			.unproject(camera)
			.sub(camera.position)
			.normalize();
	};
	const cursorOnTargetPlane = (event: WheelEvent): Vector3 | null => {
		const direction = cursorRay(event.clientX, event.clientY);
		if (!direction) return null;
		const distance = (camTarget.y - camera.position.y) / direction.y;
		// Above the horizon the ray never meets the plane: plain dolly towards the target.
		return distance > 0 && Number.isFinite(distance)
			? camera.position.clone().addScaledVector(direction, distance)
			: null;
	};
	// a notch towards the TV, with the cursor on it and the camera near enough, goes into the TV focus.
	const towardsNearTv = (event: WheelEvent): boolean => {
		const screen = layout.screen;
		if (!screen || event.deltaY >= 0 || !screenInView(screen, camera.position)) return false;
		const ray = cursorRay(event.clientX, event.clientY);
		if (!ray || !rayHitsScreen(screen, camera.position, ray)) return false;
		const focusDistance = toVector(screenFocusPose(screen, camera.aspect).position).distanceTo(toVector(screen.center));
		return camera.position.distanceTo(toVector(screen.center)) <= TV_WHEEL_FOCUS_FACTOR * focusDistance;
	};
	// OrbitControls' own wheel step: × 0.95^zoomSpeed per 100 px notch (lines and pages as it counts them, a trackpad
	// pinch, a ctrl wheel, ×10).
	const wheelScale = (event: WheelEvent): number => {
		const delta =
			event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1) * (event.ctrlKey ? 10 : 1);
		return 0.95 ** (-CAMERA_ZOOM_SPEED * delta * 0.01);
	};
	// Added before OrbitControls connects, so it runs ahead of the controls' own wheel listener.
	// OrbitControls.zoomToCursor is not used: it slides the target only above a 20° camera tilt (two rooms sit at 17°).
	const onWheel = (event: WheelEvent): void => {
		// Every wheel on the canvas is the camera's, also in a tween or on the TV, where the controls are off and would
		// not stop the page scrolling or zooming with it.
		event.preventDefault();
		cursor = null;
		if (mode === 'focus') {
			if (event.deltaY > 0) exitToOrbit();
			return;
		}
		if (tween) return;
		if (mode === 'seat') {
			narrowSeatView(wheelScale(event), event.clientX, event.clientY);
			return;
		}
		// focusScreen turns the controls off, so their own wheel listener skips this notch.
		if (towardsNearTv(event)) {
			focusScreen();
			return;
		}
		// the wheel's step (the two-finger dolly keeps OrbitControls' exponent 1, set on a touch).
		controls.zoomSpeed = CAMERA_ZOOM_SPEED;
		cursor = cursorOnTargetPlane(event);
	};
	dom.addEventListener('wheel', onWheel, {passive: false});

	const controls = new OrbitControls(camera, dom);
	controls.enablePan = false;
	controls.enableDamping = true;
	controls.dampingFactor = 0.12;
	controls.rotateSpeed = ORBIT_ROTATE_SPEED;
	controls.zoomSpeed = CAMERA_ZOOM_SPEED;
	// Orbiting, two fingers only zoom (towards the target): pan is off, so DOLLY_PAN leaves the dolly half.
	const ORBIT_TOUCHES = {ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN};
	controls.touches = ORBIT_TOUCHES;

	// The radius OrbitControls recomputes from position − target can land one ulp outside [min, max] (always at cam_home
	// and in the seat view, where min = max); the clamp then counts as a zoom and every update reports a change, so the
	// room would never stop drawing. A relative slack of 1e-9 (27 nm at 26.5 m) keeps the idle state idle; a dolly
	// clamped onto the slack itself can still flicker by an ulp, which the unmoved-pose check in 'change' swallows.
	const setDistanceRange = (min: number, max: number): void => {
		controls.minDistance = min * (1 - 1e-9);
		controls.maxDistance = max * (1 + 1e-9);
	};
	const applyOrbitLimits = (): void => {
		controls.minAzimuthAngle = limits.minAzimuth;
		controls.maxAzimuthAngle = limits.maxAzimuth;
		controls.minPolarAngle = limits.minPolar;
		controls.maxPolarAngle = limits.maxPolar;
		setDistanceRange(limits.minDistance, limits.maxDistance);
		controls.enableZoom = true;
		controls.rotateSpeed = ORBIT_ROTATE_SPEED;
		controls.touches = ORBIT_TOUCHES;
	};
	// OrbitControls turns the camera about the target at a fixed distance and 'change' moves both back so the eye
	// stays put: the look turns about the eye. The camera sits opposite the look, so a larger polar angle looks up.
	// A negative speed makes the view follow the cursor (the scene is dragged), 1:1 at the current angle.
	const applySeatLimits = (pose: SeatPose): void => {
		const offset = toVector(pose.eye).sub(toVector(pose.target));
		seatDistance = offset.length();
		const azimuth = Math.atan2(offset.x, offset.z);
		const polar = Math.acos(offset.y / seatDistance);
		controls.minAzimuthAngle = azimuth - SEAT_LOOK_YAW;
		controls.maxAzimuthAngle = azimuth + SEAT_LOOK_YAW;
		controls.minPolarAngle = Math.max(0, polar - SEAT_LOOK_DOWN);
		controls.maxPolarAngle = Math.min(Math.PI, polar + SEAT_LOOK_UP);
		setDistanceRange(seatDistance, seatDistance);
		controls.enableZoom = false;
		controls.rotateSpeed = -camera.fov / 360;
		// no two-finger role for the controls (state NONE): otherwise the first finger's turn goes on with the
		// two fingers' midpoint and the gaze jumps; the rig narrows the view for them.
		controls.touches = {ONE: TOUCH.ROTATE};
	};
	const applyNearFar = (): void => {
		const {near, far} = nearFarFor(camera.position.distanceTo(controls.target), homeDistance);
		if (near === camera.near && far === camera.far) return;
		camera.near = near;
		camera.far = far;
		camera.updateProjectionMatrix();
	};

	// the view narrows (or widens back) by `scale` about a point on screen: the direction under it stays under it and
	// the eye stays put; the look window still holds.
	function narrowSeatView(scale: number, clientX: number, clientY: number): void {
		if (!seatPose) return;
		const next = Math.min(1, Math.max(SEAT_ZOOM_MIN, zoom * scale));
		const rect = dom.getBoundingClientRect();
		const along = cursorRay(clientX, clientY);
		if (next === zoom || !along) return;
		zoom = next;
		camera.fov = viewFov(camera.aspect);
		camera.updateProjectionMatrix();
		controls.rotateSpeed = -camera.fov / 360;
		// The yaw and pitch (no roll) that show `along` at the same spot through the new angle: in view space it lies at
		// (right, up, 1); up·cos(pitch) + sin(pitch) = along.y·|v| fixes the pitch, the rest of it the yaw.
		const t = halfTan(camera.fov);
		const right = (((clientX - rect.left) / rect.width) * 2 - 1) * t * camera.aspect;
		const up = (-((clientY - rect.top) / rect.height) * 2 + 1) * t;
		const length = Math.hypot(right, up, 1);
		const pitch = Math.atan2(1, up) - Math.acos(Math.min(1, Math.max(-1, (along.y * length) / Math.hypot(up, 1))));
		const yaw = Math.atan2(along.x, along.z) + Math.atan2(right, Math.cos(pitch) - up * Math.sin(pitch));
		controls.target
			.copy(camera.position)
			.add(
				new Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)).multiplyScalar(
					seatDistance,
				),
			);
		// Clamps to the look window; 'change' keeps the eye in place and reports the view, else it is reported here.
		moved = false;
		controls.update();
		if (moved) return;
		applyNearFar();
		emit();
	}

	controls.addEventListener('change', () => {
		if (mode === 'orbit' && !tween) {
			const target = controls.target;
			const distance = camera.position.distanceTo(target);
			if (cursor && Math.abs(distance - lastDistance) > 1e-9) {
				// The dolly scaled camera ↔ target by k about the target; moving both by (1 − k)(P − target) makes it a scaling
				// about P instead, which keeps P (and its whole cursor ray) under the cursor and the target at its height.
				shift.subVectors(cursor, target).multiplyScalar(1 - distance / lastDistance);
				target.add(shift);
				camera.position.add(shift);
			}
			const boxed = clampTargetToPanBox(target, camTarget, camPan);
			shift.set(boxed.x - target.x, boxed.y - target.y, boxed.z - target.z);
			target.add(shift);
			camera.position.add(shift);
			lastDistance = distance;
		} else if (mode === 'seat' && !tween && seatPose) {
			const {eye} = seatPose;
			shift.set(eye.x - camera.position.x, eye.y - camera.position.y, eye.z - camera.position.z);
			controls.target.add(shift);
			camera.position.add(shift);
		}
		cursor = null;
		// OrbitControls reports a clamp that lands an ulp off a distance limit as a change on every update; the view did
		// not move, so nothing is reported or drawn.
		if (camera.position.equals(shownPosition) && controls.target.equals(shownTarget)) return;
		shownPosition.copy(camera.position);
		shownTarget.copy(controls.target);
		moved = true;
		applyNearFar();
		emit();
	});
	controls.addEventListener('end', () => {
		cursor = null;
	});

	// Ends any damping glide at once so a tween starts from where the camera really is and nothing drifts afterwards.
	const stopMomentum = (): void => {
		if (!controls.enabled) return;
		controls.enableDamping = false;
		controls.update();
		controls.enableDamping = true;
	};
	const startTween = (to: Pose, next: SceneCameraMode): void => {
		stopMomentum();
		controls.enabled = false;
		tween = {
			from: {position: camera.position.clone(), target: controls.target.clone(), fov: camera.fov},
			to,
			start: null,
		};
		mode = next;
		emit();
	};
	const finishTween = (): void => {
		tween = null;
		if (mode === 'focus') return;
		if (mode === 'seat' && seatPose) applySeatLimits(seatPose);
		else {
			applyOrbitLimits();
			lastDistance = camera.position.distanceTo(controls.target);
		}
		controls.enabled = true;
		controls.update();
	};
	const saveOrbitPose = (): void => {
		if (mode === 'orbit' && !tween) orbitPose = {position: camera.position.clone(), target: controls.target.clone()};
	};
	const seatTween = (pose: SeatPose): void => {
		zoom = 1;
		startTween(
			{position: toVector(pose.eye), target: toVector(pose.target), fov: (aspect) => seatFov(pose.fovDeg, aspect)},
			'seat',
		);
	};

	function exitToOrbit(): void {
		if (mode === 'orbit') return;
		seatPose = null;
		zoom = 1;
		const home = orbitPose ?? {position: toVector(camHome), target: toVector(camTarget)};
		startTween({position: home.position.clone(), target: home.target.clone(), fov: fovFor}, 'orbit');
	}
	function focusScreen(): void {
		const screen = layout.screen;
		if (!screen || mode === 'focus') return;
		saveOrbitPose();
		const pose = screenFocusPose(screen, camera.aspect);
		startTween({position: toVector(pose.position), target: toVector(pose.target), fov: fovFor}, 'focus');
	}

	// Seated presses that reach the canvas: TableGame3DHost takes presses on pieces in the capture phase, so these are on
	// empty space (or a drop target). Two fingers narrow the view; a double tap or click returns to the pose.
	const presses = new Map<number, {x: number; y: number}>();
	let multiTouch = false;
	let lastTap: {at: number; x: number; y: number} | null = null;
	const onPointerDown = (event: PointerEvent): void => {
		// OrbitControls' two-finger dolly with exponent 1; a mouse's dolly (its middle button) the wheel's step.
		controls.zoomSpeed = event.pointerType === 'touch' ? 1 : CAMERA_ZOOM_SPEED;
		// only the main button taps (a right-button double click is a context menu, not a look back).
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		presses.set(event.pointerId, {x: event.clientX, y: event.clientY});
		if (presses.size > 1) {
			multiTouch = true;
			lastTap = null;
		}
	};
	const onPointerMove = (event: PointerEvent): void => {
		const press = presses.get(event.pointerId);
		if (!press || presses.size !== 2 || mode !== 'seat' || tween) return;
		const [a, b] = [...presses.values()] as [{x: number; y: number}, {x: number; y: number}];
		const before = Math.hypot(a.x - b.x, a.y - b.y);
		press.x = event.clientX;
		press.y = event.clientY;
		const after = Math.hypot(a.x - b.x, a.y - b.y);
		if (before > 0 && after > 0) narrowSeatView(before / after, (a.x + b.x) / 2, (a.y + b.y) / 2);
	};
	const onPointerUp = (event: PointerEvent): void => {
		const press = presses.get(event.pointerId);
		if (!press) return;
		presses.delete(event.pointerId);
		const wasMulti = multiTouch;
		if (presses.size === 0) multiTouch = false;
		if (wasMulti || mode !== 'seat' || tween) return;
		if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) {
			lastTap = null;
			return;
		}
		const previous = lastTap;
		lastTap = {at: event.timeStamp, x: event.clientX, y: event.clientY};
		if (
			!previous ||
			event.timeStamp - previous.at > DOUBLE_TAP_MS ||
			Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > DOUBLE_TAP_PX
		)
			return;
		lastTap = null;
		if (seatPose && !pickedAt?.(event.clientX, event.clientY)) seatTween(seatPose);
	};
	const onPointerCancel = (event: PointerEvent): void => {
		presses.delete(event.pointerId);
		if (presses.size === 0) multiTouch = false;
	};
	const doc = dom.ownerDocument;
	dom.addEventListener('pointerdown', onPointerDown);
	doc.addEventListener('pointermove', onPointerMove);
	doc.addEventListener('pointerup', onPointerUp);
	doc.addEventListener('pointercancel', onPointerCancel);

	camera.position.copy(toVector(camHome));
	controls.target.copy(toVector(camTarget));
	camera.fov = fovFor(camera.aspect);
	applyOrbitLimits();
	controls.update();
	applyNearFar();
	camera.updateProjectionMatrix();
	// project() may run before the first frame (overlay anchors placed on mount).
	camera.updateMatrixWorld();

	return {
		camera,
		update(nowMs) {
			if (!tween) {
				if (!controls.enabled) return false;
				moved = false;
				if (controls.update() && moved) return true;
				// Below OrbitControls' change threshold the damping glide goes on unseen and wakes a later, unrelated frame;
				// end it here so idle stays idle.
				stopMomentum();
				return false;
			}
			tween.start ??= nowMs;
			const t = Math.min(1, (nowMs - tween.start) / CAMERA_TWEEN_MS);
			const eased = easeInOutCubic(t);
			const {from, to} = tween;
			camera.position.lerpVectors(from.position, to.position, eased);
			controls.target.lerpVectors(from.target, to.target, eased);
			camera.fov = from.fov + (to.fov(camera.aspect) - from.fov) * eased;
			camera.lookAt(controls.target);
			camera.updateProjectionMatrix();
			applyNearFar();
			if (t === 1) finishTween();
			emit();
			return tween !== null;
		},
		setAspect(aspect) {
			camera.aspect = aspect;
			if (!tween) camera.fov = viewFov(aspect);
			if (mode === 'seat' && !tween) controls.rotateSpeed = -camera.fov / 360;
			camera.updateProjectionMatrix();
			emit();
		},
		mode: () => mode,
		tweening: () => tween !== null,
		focusScreen,
		enterSeat(pose, keepLook = false) {
			if (keepLook && mode === 'seat' && seatPose && !tween) {
				// The viewer's turn from the old pose's own look (yaw, pitch) carries over onto the new pose's look: a viewer
				// who never turned arrives at the new pose exactly, a resize (same look) keeps the turned one.
				const angles = (d: Vector3) => ({yaw: Math.atan2(d.x, d.z), pitch: Math.asin(Math.min(1, Math.max(-1, d.y)))});
				const now = angles(controls.target.clone().sub(camera.position).normalize());
				const from = angles(toVector(seatPose.target).sub(toVector(seatPose.eye)).normalize());
				const to = angles(toVector(pose.target).sub(toVector(pose.eye)).normalize());
				const yaw = to.yaw + now.yaw - from.yaw;
				const pitch = to.pitch + now.pitch - from.pitch;
				const look = new Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
				const eye = toVector(pose.eye);
				const distance = eye.distanceTo(toVector(pose.target));
				// Every board game puts the eye at the same spot, but its look and angle differ: those still glide.
				const samePose =
					eye.distanceTo(camera.position) < 1e-9 &&
					toVector(pose.target).distanceTo(toVector(seatPose.target)) < 1e-9 &&
					pose.fovDeg === seatPose.fovDeg;
				seatPose = pose;
				if (samePose) {
					// A resize that keeps the pose: the same eye and turned look, the angle for the new aspect.
					applySeatLimits(pose);
					controls.target.copy(eye).addScaledVector(look, distance);
					camera.fov = viewFov(camera.aspect);
					camera.updateProjectionMatrix();
					controls.rotateSpeed = -camera.fov / 360;
					controls.update();
					applyNearFar();
					emit();
					return;
				}
				startTween(
					{
						position: eye,
						target: eye.clone().addScaledVector(look, distance),
						fov: (aspect) => seatFov(pose.fovDeg, aspect) * zoom,
					},
					'seat',
				);
				return;
			}
			saveOrbitPose();
			seatPose = pose;
			seatTween(pose);
		},
		exitToOrbit,
		azimuthFromHome() {
			const {position} = camera;
			const {target} = controls;
			return fromHome(Math.atan2(position.x - target.x, position.z - target.z), limits.homeAzimuth);
		},
		zoomScale: () =>
			mode === 'seat' && seatPose ? halfTan(seatFov(seatPose.fovDeg, camera.aspect)) / halfTan(camera.fov) : 1,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			tween = null;
			listeners.clear();
			dom.removeEventListener('wheel', onWheel);
			dom.removeEventListener('pointerdown', onPointerDown);
			doc.removeEventListener('pointermove', onPointerMove);
			doc.removeEventListener('pointerup', onPointerUp);
			doc.removeEventListener('pointercancel', onPointerCancel);
			controls.dispose();
		},
	};
}
