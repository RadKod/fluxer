// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import {Logger} from '@app/features/platform/utils/AppLogger';
import type {VoiceParticipantAvatarEntry} from '@app/features/voice/components/VoiceParticipantAvatarList';
import {resolveDevicePixelRatio} from '@app/features/voice/DevicePixelRatio';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import CallMediaPrefs from '@app/features/voice/state/CallMediaPrefs';
import PopoutWindowManager, {getVoiceTilePopoutKey} from '@app/features/voice/state/PopoutWindowManager';
import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import {anchorScale} from '@app/features/voice_scene/components/VoiceSceneAnchor';
import type {RoomSeat, Vec3, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import {cameraCardPlacement, isTableCameraSeat} from '@app/features/voice_scene/utils/CameraCardLayout';
import type {SeatAssignment, SeatParticipant} from '@app/features/voice_scene/utils/SeatAssignment';
import {
	type CameraCandidate,
	planRoomCameras,
	ROOM_CAMERA_REPLAN_THROTTLE_MS,
} from '@app/features/voice_scene/video/CameraSubscriptionPlan';
import RoomCameraStore from '@app/features/voice_scene/video/RoomCameraStore';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {type Room, Track} from 'livekit-client';
import {useEffect, useRef} from 'react';

export interface RoomCamerasParams {
	handle: VoiceSceneHandle;
	room: Room | null;
	channelId: string;
	assignment: SeatAssignment<SeatParticipant>;
	entries: ReadonlyArray<VoiceParticipantAvatarEntry>;
	// Seat name → where its avatar is drawn.
	avatarPoints: ReadonlyMap<string, Vec3>;
	// Identity of the camera watched on the TV, if any.
	tv: string | null;
	container?: HTMLElement | null;
}

// CSS sizes of the avatar discs the overlay draws: lounge seat, table seat (72 in the seat view, SEAT-UI), standing.
const LOUNGE_AVATAR_PX = 40;
const TABLE_AVATAR_PX = 32;
const SEAT_VIEW_TABLE_AVATAR_PX = 72;
const STANDING_AVATAR_PX = 32;
const SPOKE_RECENTLY_MS = 10_000;
// Re-plan at least this often while open, so "spoke in the last 10 s" fades without a view change.
const REPLAN_TICK_MS = 2000;
const logger = new Logger('useRoomCameras');
// TEMPORARY: upstream MediaEngine.setLocalVideoDisabled(false) ("show video" again) subscribes the camera
// straight through LiveKit (setSubscribed with true), around the room's plan, and nothing releases it while the room is
// open. The warning below goes to this browser's console only (the app logger sends nothing to a server), so it is no
// production signal. Trigger: the KW-CAM count goes over the plan's limits, or the console warning shows up in a
// support session. A production signal would come from the server side — the LiveKit SFU counting, per participant,
// subscribed video tracks over the plan's limit (separate job). Path (separate job): turn that upstream call into the
// managed path (VideoSubscriptionManager subscribeToVideo), so the room's plan sees and owns it.
let offPlanWarned = false;

interface DrawnAvatar {
	identity: string;
	point: Vec3;
	size: number;
	order: number;
	seat: RoomSeat | undefined;
}

const tableOf = (seat: RoomSeat | undefined): string | null => seat?.table?.slot ?? seat?.watch?.slot ?? null;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// the room's camera subscriptions. Plans from the drawn avatars (≤ 9, ≤ 4 medium, the TV high) at most
// every 500 ms on view changes, hands the plan to RoomCameraStore — the only owner while the room is open — and
// releases everything when the room closes, before the call grid's tiles take over in the same commit. Call from
// an observer: the switch, the setting, local disables and popouts are read while it renders.
export function useRoomCameras(p: RoomCamerasParams): void {
	const {handle, room, channelId, assignment, entries, avatarPoints, tv, container} = p;
	const enabled =
		room !== null &&
		readVoiceRoomAssignment(ExperimentAssignments.response).cameras &&
		VoiceSceneSettings.showRoomCameras;
	const callId = MediaEngine.connectionId ?? '';
	const callPopout = PopoutWindowManager.isCallPopoutOpenForChannel(channelId);
	const cameras = entries.flatMap((entry) => {
		if (!entry.hasCamera || entry.isLocal) return [];
		const identity = buildVoiceParticipantIdentity(entry.userId, entry.connectionId);
		return [
			{
				entry,
				identity,
				locallyDisabled: callId !== '' && CallMediaPrefs.isVideoDisabled(callId, identity),
				externallyHeld:
					callPopout ||
					PopoutWindowManager.isOpen(getVoiceTilePopoutKey(identity, 'camera')) ||
					PopoutWindowManager.isOpen(getVoiceTilePopoutKey(identity, 'user')),
			},
		];
	});
	const latest = useRef({handle, assignment, avatarPoints, tv, enabled, cameras});
	latest.current = {handle, assignment, avatarPoints, tv, enabled, cameras};
	const lastSpoke = useRef(new Map<string, number>());
	const schedule = useRef<() => void>(() => {});
	const viewport = useRef({width: window.innerWidth, height: window.innerHeight});
	useEffect(() => {
		if (!container) return;
		viewport.current = {
			width: container.clientWidth || window.innerWidth,
			height: container.clientHeight || window.innerHeight,
		};
		const resize = new ResizeObserver(([size]) => {
			viewport.current = {width: size.contentRect.width, height: size.contentRect.height};
			schedule.current();
		});
		resize.observe(container);
		return () => resize.disconnect();
	}, [container]);

	useEffect(() => {
		const replan = (): void => {
			const now = Date.now();
			const {handle, assignment, avatarPoints, tv, enabled, cameras} = latest.current;
			if (cameras.length === 0) {
				RoomCameraStore.apply(new Map());
				return;
			}
			const {layout} = handle;
			const seats = new Map(layout.seats.map((seat, order) => [seat.name, {seat, order}]));
			const seatView = handle.getCameraMode() === 'seat';
			const drawn = new Map<string, DrawnAvatar>();
			for (const [name, person] of assignment.seated) {
				const found = seats.get(name);
				drawn.set(person.userId, {
					identity: buildVoiceParticipantIdentity(person.userId, person.connectionId),
					point: avatarPoints.get(name) ?? found?.seat.position ?? layout.camTarget,
					size: !found?.seat.table ? LOUNGE_AVATAR_PX : seatView ? SEAT_VIEW_TABLE_AVATAR_PX : TABLE_AVATAR_PX,
					order: found?.order ?? 0,
					seat: found?.seat,
				});
			}
			assignment.standing.forEach((person, index) => {
				const placement = assignment.placements.get(person.userId);
				if (!placement) return;
				drawn.set(person.userId, {
					identity: buildVoiceParticipantIdentity(person.userId, person.connectionId),
					point: placement.position,
					size: STANDING_AVATAR_PX,
					order: layout.seats.length + index,
					seat: undefined,
				});
			});
			const me = Authentication.currentUserId;
			const mine = me === null ? undefined : assignment.placements.get(me);
			const myTable = tableOf(mine?.seat ? seats.get(mine.seat)?.seat : undefined);
			const listener = mine?.position ?? layout.camTarget;
			const dpr = resolveDevicePixelRatio(window);
			const candidates: Array<CameraCandidate> = [];
			const externallyHeld = new Set<string>();
			for (const camera of cameras) {
				if (camera.entry.speaking) lastSpoke.current.set(camera.identity, now);
				if (camera.externallyHeld) externallyHeld.add(camera.identity);
				// One avatar per user: another device of someone drawn elsewhere has no disc of its own.
				const found = drawn.get(camera.entry.userId);
				const avatar = found?.identity === camera.identity ? found : undefined;
				const projected = avatar ? handle.project(avatar.point) : null;
				const table = isTableCameraSeat(avatar?.seat)
					? layout.tables.find((table) => table.slot === avatar?.seat?.table?.slot)
					: undefined;
				const ownPlayerTable = !!mine?.seat && isTableCameraSeat(seats.get(mine.seat)?.seat);
				const cardMode =
					table && (!seatView || (ownPlayerTable && table.slot === myTable)) ? (seatView ? 'seat' : 'room') : undefined;
				const card =
					cardMode && table && projected
						? cameraCardPlacement(handle, projected, {mode: cardMode, table}, viewport.current)
						: null;
				candidates.push({
					identity: camera.identity,
					visible: card?.visible ?? projected?.visible ?? false,
					discPx: card ? card.width * dpr : avatar && projected ? avatar.size * anchorScale(projected.scale) * dpr : 0,
					cameraCard: cardMode,
					distanceM: distance(assignment.placements.get(camera.entry.userId)?.position ?? layout.camTarget, listener),
					sameTable: myTable !== null && tableOf(avatar?.seat) === myTable,
					speakingRecently:
						now - (lastSpoke.current.get(camera.identity) ?? Number.NEGATIVE_INFINITY) <= SPOKE_RECENTLY_MS,
					seatOrder: avatar?.order ?? Number.MAX_SAFE_INTEGER,
					locallyDisabled: camera.locallyDisabled,
					externallyHeld: camera.externallyHeld,
				});
			}
			RoomCameraStore.apply(planRoomCameras({enabled, candidates, tv}), externallyHeld);
			if (offPlanWarned || !room) return;
			let offPlan = 0;
			for (const participant of room.remoteParticipants.values()) {
				const {identity} = participant;
				const subscribed = participant.getTrackPublication(Track.Source.Camera)?.isSubscribed ?? false;
				if (subscribed && !RoomCameraStore.holds(identity) && !externallyHeld.has(identity)) offPlan++;
			}
			if (offPlan === 0) return;
			offPlanWarned = true; // once per page load, in this browser's console only (see TEMPORARY: above)
			logger.warn('Room camera subscribed outside the room plan (upstream setLocalVideoDisabled path)', {
				count: offPlan,
			});
		};
		let lastRun = Number.NEGATIVE_INFINITY;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const run = (): void => {
			timer = null;
			lastRun = Date.now();
			replan();
		};
		schedule.current = () => {
			if (timer !== null) return;
			const wait = lastRun + ROOM_CAMERA_REPLAN_THROTTLE_MS - Date.now();
			if (wait <= 0) run();
			else timer = setTimeout(run, wait);
		};
		run();
		const stopViewChanges = handle.onViewChange(() => schedule.current());
		const tick = setInterval(() => schedule.current(), REPLAN_TICK_MS);
		return () => {
			stopViewChanges();
			clearInterval(tick);
			if (timer !== null) clearTimeout(timer);
			schedule.current = () => {};
			RoomCameraStore.releaseAll();
		};
	}, [handle, room]);

	const camerasKey = cameras
		.map(
			(camera) =>
				`${camera.identity}:${Number(camera.entry.speaking)}${Number(camera.locallyDisabled)}${Number(camera.externallyHeld)}`,
		)
		.join('|');
	// The mount itself is planned above; later input changes ask for a plan through the same throttle.
	const mounted = useRef(false);
	useEffect(() => {
		if (mounted.current) schedule.current();
		mounted.current = true;
	}, [assignment, avatarPoints, tv, enabled, camerasKey]);
}
