// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {EventEmitter} from 'node:events';
import type {
	RoomLayout,
	SceneCameraMode,
	Vec3,
	VoiceSceneHandle,
} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {type IObservableValue, runInAction} from 'mobx';
import {act, type ComponentProps, createElement, type ReactNode, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

interface Entry {
	user: {id: string; username: string};
	userId: string;
	connectionId: string;
	speaking: boolean;
	hasCamera: boolean;
	hasScreenShare: boolean;
	isLocal: boolean;
	selfMute: boolean;
	selfDeaf: boolean;
}

const env = vi.hoisted(() => ({
	games: true,
	room: null as unknown,
	planned: new Map<string, string>(),
	realTooltip: false,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate, number: String}})}));
// Popout's keyboard-mode store imports UserSettings lazily, which needs the app bootstrap.
vi.mock('@app/features/ui/commands/PopoutCommands', () => ({close: vi.fn()}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {put: vi.fn(() => Promise.resolve({}))}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, games: env.games, cameras: true}),
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		channelId: '500',
		connectionId: 'conn-a',
		get room() {
			return env.room;
		},
	},
}));
// The real hook re-renders on every media engine change; an observable stands in for that here.
vi.mock('@app/features/voice/components/VoiceParticipantAvatarList', async () => {
	const {observable} = await import('mobx');
	const entries = observable.box<Array<unknown>>([], {deep: false});
	return {useVoiceParticipantAvatarEntries: () => entries.get(), testEntries: entries};
});
vi.mock('@app/features/voice_scene/state/VoiceSceneSettings', () => ({
	default: {spatialAudio: true, showRoomCameras: true},
}));
vi.mock('@app/features/voice_scene/video/RoomCameraStore', () => ({
	default: {
		qualityOf: (identity: string) => env.planned.get(identity) ?? null,
		apply: vi.fn(),
		releaseAll: vi.fn(),
		holds: () => false,
	},
}));
vi.mock('@app/features/voice_scene/audio/RoomSpatialAudio', () => ({
	createRoomSpatialAudio: () => ({attach: vi.fn(), detach: vi.fn(), setMode: vi.fn(), update: vi.fn()}),
}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	requestTableListRefresh: vi.fn(),
	spectate: vi.fn(),
	unspectate: vi.fn(),
	act: vi.fn(),
}));
vi.mock('@app/features/table_game/state/TableGames', () => ({
	default: {
		requestPanel: vi.fn(),
		getSummary: () => null,
		getView: () => null,
		getRack: () => [],
		getWatchMode: () => null,
	},
}));
vi.mock('@app/features/notification/utils/SoundUtils', () => ({SoundType: {}}));
vi.mock('@app/features/table_game/sound/TableGameSounds', () => ({
	playTableUiSound: vi.fn(),
	setTableSoundFocus: vi.fn(),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/table_game/components/TableGamesEntry', () => ({
	TableGamesEntry: ({slot, placement, panelAnchor}: {slot: string; placement: string; panelAnchor?: Element | null}) =>
		createElement('div', {
			'data-table-entry': slot,
			'data-placement': placement,
			'data-panel-anchor': panelAnchor ? (panelAnchor.hasAttribute('data-seat-hud') ? 'hud' : 'other') : 'none',
		}),
}));
vi.mock('@app/features/table_game/components/TableGamePanel', () => ({
	tableSlotNumber: (slot: string) => Number.parseInt(slot.slice(1), 10),
}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({user, size}: {user: {id: string}; size: number}) =>
		createElement('div', {'data-avatar': user.id, 'data-size': size}),
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: true}}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: true}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
vi.mock('@app/features/ui/state/ContextMenu', () => ({default: {getContextMenu: () => null}}));
vi.mock('@app/features/ui/utils/WindowFocusInteractionGuard', () => ({
	canUseWindowFocusedHoverControls: () => true,
	subscribeWindowHoverControlsChange: () => () => {},
}));
vi.mock('@app/features/ui/utils/AppZoomUtils', () => ({
	appZoomCssPx: (value: number) => `${value}px`,
	appZoomLayoutPx: (value: number) => value,
}));
vi.mock('@app/features/theme/layout/RemFromPx', () => ({remFromPx: (value: number) => `${value}px`}));
vi.mock('@app/features/ui/tooltip/Tooltip', async () => {
	const {Tooltip} = await vi.importActual<typeof import('@app/features/ui/tooltip/Tooltip')>(
		'@app/features/ui/tooltip/Tooltip',
	);
	return {
		Tooltip: (props: ComponentProps<typeof Tooltip>) =>
			env.realTooltip ? createElement(Tooltip, props) : props.children,
	};
});
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	// The real one shows `tooltip` on hover and the profile popout on click.
	PreloadableUserPopout: ({children, tooltip, user}: {children: ReactNode; tooltip: string; user: {id: string}}) => {
		const [open, setOpen] = useState(false);
		return createElement(
			'div',
			{'data-tooltip': tooltip, onClick: () => setOpen(true)},
			children,
			open ? createElement('div', {'data-profile-popout': user.id}) : null,
		);
	},
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/action_menu/VoiceParticipantContextMenu', () => ({VoiceParticipantContextMenu: () => null}));
vi.mock('@app/features/voice/components/useStreamWatchState', () => ({
	useStreamWatchState: () => ({isWatching: false, canWatch: true, startWatching: vi.fn(), stopWatching: vi.fn()}),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@livekit/components-react', () => ({VideoTrack: () => null}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: {getShowMyOwnCamera: () => true}}));
vi.mock('@app/features/voice_scene/components/VoiceSceneTvPicker', () => ({VoiceSceneTvPicker: () => null}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const {testEntries} = (await import('@app/features/voice/components/VoiceParticipantAvatarList')) as unknown as {
	testEntries: IObservableValue<Array<Entry>>;
};

function setEntries(entries: Array<Entry>): void {
	act(() => runInAction(() => testEntries.set(entries)));
}
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {VoiceSceneOverlay} = await import('@app/features/voice_scene/components/VoiceSceneOverlay');

const LAYOUT: RoomLayout = {
	seats: [
		{name: 'seat_A_01', group: 'A', position: {x: 1, y: 1, z: 0}, table: null, watch: null},
		{name: 'seat_A_02', group: 'A', position: {x: 2, y: 1, z: 0}, table: null, watch: null},
		// Behind the camera in these tests.
		{name: 'seat_B_03', group: 'B', position: {x: 3, y: 1, z: 99}, table: null, watch: null},
		// One metre south of the table centre.
		{name: 'seat_T01_1', group: 'T01', position: {x: 4, y: 1, z: 1}, table: {slot: 'T01', position: 1}, watch: null},
		{name: 'seat_T01_3', group: 'T01', position: {x: 4, y: 1, z: -1}, table: {slot: 'T01', position: 3}, watch: null},
		{name: 'seat_T01_Y1', group: 'T01', position: {x: 6, y: 1, z: 0}, table: null, watch: {slot: 'T01', index: 1}},
	],
	stands: [{x: 5, y: 2, z: 0}],
	tables: [{slot: 'T01', center: {x: 4, y: 0.5, z: 0}, topSize: 1}],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	screen: null,
	camPan: {x: 0, z: 0},
};

function fakeHandle() {
	const listeners = new Set<() => void>();
	let offset = 0;
	const project = vi.fn((p: Vec3) => ({x: p.x * 100 + offset, y: p.y * 100, visible: p.z < 50, scale: 1}));
	let mode: SceneCameraMode = 'orbit';
	const modeListeners = new Set<(mode: SceneCameraMode) => void>();
	const setMode = (next: SceneCameraMode) => {
		if (next === mode) return;
		mode = next;
		for (const listener of modeListeners) listener(next);
	};
	const handle = {
		layout: LAYOUT,
		project,
		onViewChange: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		getCameraAzimuth: () => 0,
		requestRender: vi.fn(),
		setTableTop: vi.fn(),
		attachScreenElement: vi.fn(),
		screenInView: () => true,
		occluder: () => () => false,
		wheel: vi.fn(),
		getCameraMode: () => mode,
		onCameraModeChange: (cb: (mode: SceneCameraMode) => void) => {
			modeListeners.add(cb);
			return () => modeListeners.delete(cb);
		},
		focusScreen: vi.fn(),
		enterSeatView: vi.fn(() => setMode('seat')),
		exitToOrbit: vi.fn(() => setMode('orbit')),
		mountTableGame: vi.fn(() => null),
	} satisfies VoiceSceneHandle;
	return {
		handle,
		project,
		moveCamera(dx: number) {
			offset = dx;
			for (const cb of listeners) cb();
		},
	};
}

function fakeRoom(seats: Record<string, string>) {
	const participants = Object.entries(seats).map(([identity, seat]) => ({
		identity,
		attributes: {'micup.seat': seat},
		getTrackPublication: () => ({trackSid: identity}),
	}));
	return Object.assign(new EventEmitter(), {
		localParticipant: {identity: 'user_1_conn-a', attributes: {}},
		remoteParticipants: new Map(participants.map((participant) => [participant.identity, participant])),
		getParticipantByIdentity: (identity: string) =>
			participants.find((participant) => participant.identity === identity),
	});
}

const entry = (userId: string, extra: Partial<Entry> = {}): Entry => ({
	user: {id: userId, username: `user${userId}`},
	userId,
	connectionId: `conn-${userId}`,
	speaking: false,
	hasCamera: false,
	hasScreenShare: false,
	isLocal: false,
	selfMute: false,
	selfDeaf: false,
	...extra,
});

const CHANNEL = {id: '500', guildId: '9', roomTheme: 'oyun-odasi'} as never;
let root: Root;
let host: HTMLDivElement;
const flushPlacement = () => act(() => vi.advanceTimersToNextFrame());

function render(handle: VoiceSceneHandle): void {
	act(() => root.render(createElement(VoiceSceneOverlay, {handle, channel: CHANNEL})));
	flushPlacement();
}

function seatMe(seat: string): void {
	(env.room as {localParticipant: {attributes: Record<string, string>}}).localParticipant.attributes = {
		'micup.seat': seat,
	};
}

const overlayLayer = () => host.querySelector('[data-flx="voice-scene.voice-scene-overlay.overlay"]') as HTMLElement;
const buttonWithText = (text: string) =>
	[...host.querySelectorAll('button')].find((button) => button.textContent === text) as HTMLButtonElement | undefined;

function anchorOf(selector: string): HTMLElement {
	const element = host.querySelector(selector);
	const anchor = element?.closest('[data-scene-anchor]');
	if (!(anchor instanceof HTMLElement)) throw new Error(`no anchor for ${selector}`);
	return anchor;
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2')]);
	env.games = true;
	env.realTooltip = false;
	env.planned.clear();
	env.room = fakeRoom({'user_2_conn-2': 'seat_A_01'});
	vi.mocked(http.put).mockClear();
	vi.mocked(TableGames.requestPanel).mockClear();
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

describe('VoiceSceneOverlay', () => {
	it('keeps empty marker DOM across twelve seat/room cycles while hidden markers stay inert and disabled', () => {
		seatMe('seat_T01_1');
		const {handle} = fakeHandle();
		render(handle);
		const markers = [...host.querySelectorAll<HTMLButtonElement>('[data-seat]')];
		expect(markers.length).toBeGreaterThan(0);
		for (let cycle = 0; cycle < 12; cycle++) {
			for (const marker of markers) {
				expect(host.querySelector(`[data-seat="${marker.dataset.seat}"]`)).toBe(marker);
				expect(marker.disabled).toBe(true);
				expect(marker.closest('[inert]')).not.toBeNull();
				expect(anchorOf(`[data-seat="${marker.dataset.seat}"]`).style.visibility).toBe('hidden');
				act(() => marker.click());
			}
			expect(http.put).not.toHaveBeenCalled();
			expect(TableGames.requestPanel).not.toHaveBeenCalled();
			act(() => buttonWithText('Back to room')?.click());
			flushPlacement();
			for (const marker of markers) {
				expect(host.querySelector(`[data-seat="${marker.dataset.seat}"]`)).toBe(marker);
				expect(marker.disabled).toBe(false);
				expect(marker.closest('[inert]')).toBeNull();
				expect(anchorOf(`[data-seat="${marker.dataset.seat}"]`).style.visibility).toBe('');
			}
			act(() => (host.querySelector('[data-back-to-table="T01"]') as HTMLButtonElement).click());
			flushPlacement();
		}
	});

	it.each(['hover', 'focus'] as const)(
		'closes a real %s Tooltip portal when markers become disabled in seat view',
		async (driver) => {
			env.realTooltip = true;
			seatMe('seat_T01_1');
			const {handle} = fakeHandle();
			render(handle);
			act(() => buttonWithText('Back to room')?.click());
			flushPlacement();
			const marker = host.querySelector('[data-seat="seat_A_02"]') as HTMLButtonElement;
			const blur = vi.spyOn(marker, 'blur');
			const originalMatches = marker.matches.bind(marker);
			const matches = vi
				.spyOn(marker, 'matches')
				.mockImplementation((selector) => (selector === ':hover' ? driver === 'hover' : originalMatches(selector)));
			const open = async () => {
				await act(async () => {
					if (driver === 'focus') marker.focus();
					else marker.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
				});
				flushPlacement();
				expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
				expect(marker.hasAttribute('aria-describedby')).toBe(true);
			};
			await open();
			act(() => (host.querySelector('[data-back-to-table="T01"]') as HTMLButtonElement).click());
			flushPlacement();
			expect(document.querySelector('[role="tooltip"]')).toBeNull();
			expect(marker.hasAttribute('aria-describedby')).toBe(false);
			expect(marker.disabled).toBe(true);
			expect(marker.closest('[inert]')).not.toBeNull();
			// happy-dom skips native blur on disabled nodes; Chromium verifies the focus result in browser QA.
			expect(blur).toHaveBeenCalledTimes(driver === 'focus' ? 1 : 0);
			act(() => buttonWithText('Back to room')?.click());
			flushPlacement();
			expect(host.querySelector('[data-seat="seat_A_02"]')).toBe(marker);
			act(() => marker.blur());
			await open();
			matches.mockRestore();
			blur.mockRestore();
		},
	);

	it('leaves a camera card focused when entering seat view', () => {
		setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2', {hasCamera: true})]);
		env.room = fakeRoom({'user_2_conn-2': 'seat_T01_3'});
		env.planned.set('user_2_conn-2', 'medium');
		seatMe('seat_T01_1');
		const {handle} = fakeHandle();
		render(handle);
		act(() => buttonWithText('Back to room')?.click());
		flushPlacement();
		const card = host.querySelector('[data-camera-card="room"]') as HTMLButtonElement;
		card.focus();
		act(() => (host.querySelector('[data-back-to-table="T01"]') as HTMLButtonElement).click());
		flushPlacement();
		expect(host.querySelector('[data-camera-card="seat"]')).toBe(card);
		expect(document.activeElement).toBe(card);
	});

	it('only shown table-player cameras become cards, preserving profile and context actions outside the inert game layer', () => {
		setEntries([
			entry('1', {isLocal: true, connectionId: 'conn-a'}),
			entry('2', {hasCamera: true}),
			entry('3', {hasCamera: true}),
			entry('4', {hasCamera: true}),
		]);
		env.room = fakeRoom({'user_2_conn-2': 'seat_T01_3', 'user_3_conn-3': 'seat_A_01', 'user_4_conn-4': 'seat_T01_Y1'});
		for (const id of ['2', '3', '4']) env.planned.set(`user_${id}_conn-${id}`, 'medium');
		seatMe('seat_T01_1');
		const {handle} = fakeHandle();
		render(handle);
		const card = host.querySelector('[data-camera-card="seat"]');
		expect(card).not.toBeNull();
		expect(host.querySelectorAll('[data-camera-card]')).toHaveLength(1);
		expect(card?.closest('[inert]')).toBeNull();
		expect(overlayLayer().hasAttribute('inert')).toBe(false);
		act(() => (card as HTMLButtonElement).click());
		expect(host.querySelector('[data-profile-popout="2"]')).not.toBeNull();
		expect(host.querySelector('[data-avatar="3"]')?.closest('[inert]')).not.toBeNull();
		act(() => buttonWithText('Back to room')?.click());
		expect(host.querySelector('[data-camera-card="room"]')).not.toBeNull();
	});
	it('a table profile trigger keeps focus and its DOM node when room camera visibility toggles', () => {
		setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2', {hasCamera: true})]);
		env.room = fakeRoom({'user_2_conn-2': 'seat_T01_3'});
		env.planned.set('user_2_conn-2', 'low');
		const {handle} = fakeHandle();
		render(handle);
		const button = host.querySelector('[data-camera-card]') as HTMLButtonElement;
		button.focus();
		expect(document.activeElement).toBe(button);
		env.planned.clear();
		setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2', {hasCamera: true})]);
		render(handle);
		expect(host.querySelector('[data-avatar="2"]')?.closest('button')).toBe(button);
		expect(document.activeElement).toBe(button);
		expect(button.closest('[data-scene-anchor]')?.getAttribute('style')).not.toMatch(/width:|height:/);
		env.planned.set('user_2_conn-2', 'low');
		setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2', {hasCamera: true})]);
		render(handle);
		expect(host.querySelector('[data-camera-card]')).toBe(button);
		expect(document.activeElement).toBe(button);
	});

	it('positions avatars from handle.project and repositions only on onViewChange', () => {
		const {handle, project, moveCamera} = fakeHandle();
		render(handle);
		const anchor = anchorOf('[data-avatar="2"]');
		expect(anchor.style.transform).toContain('translate3d(100px, 100px, 0)');
		const calls = project.mock.calls.length;
		setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2', {speaking: true})]);
		render(handle);
		expect(project.mock.calls.length).toBe(calls);
		moveCamera(7);
		expect(anchorOf('[data-avatar="2"]').style.transform).toContain('translate3d(107px, 100px, 0)');
	});

	it('hidden (behind camera) seats are not rendered', () => {
		const {handle} = fakeHandle();
		render(handle);
		expect(anchorOf('[data-seat="seat_B_03"]').hidden).toBe(true);
		expect(anchorOf('[data-seat="seat_A_02"]').hidden).toBe(false);
	});

	it('only table labels keep their screen size as the camera zooms, with distance ordering preserved', () => {
		const {handle, project, moveCamera} = fakeHandle();
		render(handle);
		for (const scale of [0.6, 1.8]) {
			project.mockImplementation((p: Vec3) => ({x: p.x * 100, y: p.y * 100, visible: p.z < 50, scale}));
			moveCamera(0);
			expect(anchorOf('[data-table-entry="T01"]').style.transform).toContain('scale(1)');
			expect(anchorOf('[data-seat="seat_T01_1"]').style.transform).toContain(`scale(${scale})`);
			expect(anchorOf('[data-avatar="2"]').style.transform).toContain(`scale(${scale})`);
			expect(anchorOf('[data-table-entry="T01"]').style.zIndex).toBe(String(1000 + Math.round(scale * 100)));
		}
	});

	it('a seat occluded by scene geometry is still drawn', () => {
		// the DOM layer sits over the canvas and knows only project().visible (in front, in view); no ray test.
		const {handle} = fakeHandle();
		env.room = fakeRoom({'user_2_conn-2': 'seat_A_02'});
		render(handle);
		expect(anchorOf('[data-avatar="2"]').hidden).toBe(false);
	});

	it('speaking adds the ring class without requesting a render', () => {
		const {handle} = fakeHandle();
		render(handle);
		const avatarButton = () => host.querySelector('[data-avatar="2"]')?.closest('button');
		expect(avatarButton()?.getAttribute('data-speaking')).toBe('false');
		setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2', {speaking: true})]);
		render(handle);
		expect(avatarButton()?.getAttribute('data-speaking')).toBe('true');
		expect(handle.requestRender).not.toHaveBeenCalled();
	});

	it('hover shows name tooltip; click opens the profile popout', () => {
		const {handle} = fakeHandle();
		render(handle);
		const trigger = host.querySelector('[data-avatar="2"]')?.closest('[data-tooltip]') as HTMLElement;
		expect(trigger.getAttribute('data-tooltip')).toBe('user2');
		act(() => trigger.click());
		expect(host.querySelector('[data-profile-popout="2"]')).not.toBeNull();
	});

	it('click on a free lounge seat calls PUT voice-seat with my connection id', () => {
		const {handle} = fakeHandle();
		render(handle);
		act(() => (host.querySelector('[data-seat="seat_A_02"]') as HTMLButtonElement).click());
		expect(http.put).toHaveBeenCalledWith('/channels/500/voice-seat', {
			body: {connection_id: 'conn-a', seat: 'seat_A_02'},
		});
		// A taken seat shows its avatar, not a marker.
		expect(host.querySelector('[data-seat="seat_A_01"]')).toBeNull();
	});

	it('click on a table seat opens TableGamesEntry for that slot', () => {
		const {handle} = fakeHandle();
		render(handle);
		expect(anchorOf('[data-table-entry="T01"]').style.transform).toContain('translate3d(400px, 50px, 0)');
		act(() => (host.querySelector('[data-seat="seat_T01_1"]') as HTMLButtonElement).click());
		expect(TableGames.requestPanel).toHaveBeenCalledWith('500', 'T01');
		expect(http.put).not.toHaveBeenCalled();
	});

	it('a table label draws above the seat markers and avatars around it, even nearer ones', () => {
		const {handle, project} = fakeHandle();
		// The table seat is nearer the camera than the table centre: a bigger scale, so a higher z by distance alone.
		project.mockImplementation((p: Vec3) => ({
			x: p.x * 100,
			y: p.y * 100,
			visible: p.z < 50,
			scale: p.z > 0.5 ? 1.8 : 0.6,
		}));
		render(handle);
		const label = Number(anchorOf('[data-table-entry="T01"]').style.zIndex);
		expect(label).toBeGreaterThan(Number(anchorOf('[data-seat="seat_T01_1"]').style.zIndex));
		expect(label).toBeGreaterThan(Number(anchorOf('[data-avatar="2"]').style.zIndex));
	});

	it('a seated table player is drawn smaller and pushed out from the table centre', () => {
		setEntries([entry('1', {isLocal: true, connectionId: 'conn-a'}), entry('2'), entry('3')]);
		env.room = fakeRoom({'user_2_conn-2': 'seat_T01_1', 'user_3_conn-3': 'seat_A_01'});
		const {handle, project} = fakeHandle();
		// South (+Z) shows as down on screen here.
		project.mockImplementation((p: Vec3) => ({x: p.x * 100, y: (p.y + p.z) * 100, visible: p.z < 50, scale: 1}));
		render(handle);
		expect(Number(host.querySelector('[data-avatar="2"]')?.getAttribute('data-size'))).toBeLessThan(40);
		// seat_T01_1 is 1 m south of the table centre (y 200 px on its chair); its avatar sits further south.
		const avatarY = Number(/translate3d\(400px, ([\d.]+)px/.exec(anchorOf('[data-avatar="2"]').style.transform)?.[1]);
		expect(avatarY).toBeGreaterThan(220);
		// A lounge seat keeps its size and point: only the table moves its avatars.
		expect(host.querySelector('[data-avatar="3"]')?.getAttribute('data-size')).toBe('40');
		expect(anchorOf('[data-avatar="3"]').style.transform).toContain('translate3d(100px, 100px, 0)');
	});

	it('table games off: no table labels and no table seat markers', () => {
		env.games = false;
		const {handle} = fakeHandle();
		render(handle);
		expect(host.querySelector('[data-table-entry]')).toBeNull();
		expect(host.querySelector('[data-seat="seat_T01_1"]')).toBeNull();
		expect(host.querySelector('[data-seat="seat_T01_Y1"]')).toBeNull();
	});

	it('watch seat markers show while games are on; a click asks the server for that watch seat', () => {
		const {handle} = fakeHandle();
		render(handle);
		act(() => (host.querySelector('[data-seat="seat_T01_Y1"]') as HTMLButtonElement).click());
		expect(http.put).toHaveBeenCalledWith('/channels/500/voice-seat', {
			body: {connection_id: 'conn-a', seat: 'seat_T01_Y1'},
		});
		expect(TableGames.requestPanel).not.toHaveBeenCalled();
	});

	it('seat view hides my table chip; no DOM element takes pointer events over the table top', () => {
		env.room = fakeRoom({'user_2_conn-2': 'seat_T01_3'});
		seatMe('seat_T01_1');
		const {handle} = fakeHandle();
		render(handle);
		expect(handle.enterSeatView).toHaveBeenCalledTimes(1);
		// Each non-camera anchor is inert: table drags reach the canvas, while cards can still show profiles.
		const layer = overlayLayer();
		expect(layer.hasAttribute('inert')).toBe(false);
		const anchors = [...host.querySelectorAll('[data-scene-anchor]')];
		expect(anchors.length).toBeGreaterThan(0);
		for (const anchor of anchors) expect(anchor.closest('[inert]')).not.toBeNull();
		// Still mounted (the panel opens from it), never seen.
		expect(anchorOf('[data-table-entry="T01"]').style.visibility).toBe('hidden');
		const hud = host.querySelector('[data-seat-hud]');
		expect(hud).not.toBeNull();
		expect(hud?.closest('[inert]')).toBeNull();
	});

	it('in the seat view my own avatar is hidden, table players draw at 72 px and empty seats show no markers', () => {
		env.room = fakeRoom({'user_2_conn-2': 'seat_T01_3'});
		seatMe('seat_T01_1');
		const {handle} = fakeHandle();
		render(handle);
		expect(host.querySelector('[data-avatar="1"]')).toBeNull();
		expect(host.querySelector('[data-avatar="2"]')?.getAttribute('data-size')).toBe('72');
		const markers = [...host.querySelectorAll<HTMLButtonElement>('[data-seat]')];
		expect(markers.length).toBeGreaterThan(0);
		for (const marker of markers) {
			expect(marker.disabled).toBe(true);
			expect(marker.closest('[inert]')).not.toBeNull();
			expect(anchorOf(`[data-seat="${marker.dataset.seat}"]`).style.visibility).toBe('hidden');
		}
	});

	it('in the seat view a table player sits on their own seat point, so everyone at the table stays in frame; the room pushes them out', () => {
		env.room = fakeRoom({'user_2_conn-2': 'seat_T01_3'});
		seatMe('seat_T01_1');
		const {handle, project} = fakeHandle();
		// South (+Z) shows as down on screen here; seat_T01_3 is 1 m north of the table centre, at y (1 − 1) × 100 = 0.
		project.mockImplementation((p: Vec3) => ({x: p.x * 100, y: (p.y + p.z) * 100, visible: p.z < 50, scale: 1}));
		render(handle);
		const avatarY = () =>
			Number(/translate3d\(400px, (-?[\d.]+)px/.exec(anchorOf('[data-avatar="2"]').style.transform)?.[1]);
		expect(avatarY()).toBeCloseTo(0, 6);
		act(() => buttonWithText('Back to room')?.click());
		flushPlacement();
		// In the room the table player moves 0.45 m further north, off the table label and the drawn top.
		expect(avatarY()).toBeCloseTo(-45, 6);
	});

	it("Back to room keeps the seat and shows the room; the table label's Back to table returns", () => {
		seatMe('seat_T01_1');
		const {handle} = fakeHandle();
		render(handle);
		act(() => buttonWithText('Back to room')?.click());
		expect(handle.exitToOrbit).toHaveBeenCalledTimes(1);
		expect(overlayLayer().hasAttribute('inert')).toBe(false);
		expect(host.querySelector('[data-seat-hud]')).toBeNull();
		expect(anchorOf('[data-table-entry="T01"]').style.visibility).toBe('');
		expect(host.querySelector('[data-avatar="1"]')).not.toBeNull();
		act(() => (host.querySelector('[data-back-to-table="T01"]') as HTMLButtonElement).click());
		expect(handle.enterSeatView).toHaveBeenCalledTimes(2);
		expect(host.querySelector('[data-back-to-table]')).toBeNull();
	});

	it("in the seat view my table's panel opens beside the HUD, not over the table; in the room from its label (A6)", () => {
		seatMe('seat_T01_1');
		const {handle} = fakeHandle();
		render(handle);
		expect(host.querySelector('[data-table-entry="T01"]')?.getAttribute('data-panel-anchor')).toBe('hud');
		act(() => buttonWithText('Back to room')?.click());
		expect(host.querySelector('[data-table-entry="T01"]')?.getAttribute('data-panel-anchor')).toBe('none');
	});

	it('Esc in the seat view goes back to the room', () => {
		seatMe('seat_T01_Y1');
		const {handle} = fakeHandle();
		render(handle);
		expect(handle.getCameraMode()).toBe('seat');
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
		});
		expect(handle.exitToOrbit).toHaveBeenCalledTimes(1);
		expect(host.querySelector('[data-back-to-table="T01"]')).not.toBeNull();
	});

	it('standing shows at most 24 avatars and +N', () => {
		setEntries([
			entry('1', {isLocal: true, connectionId: 'conn-a'}),
			...Array.from({length: 30}, (_, index) => entry(String(100 + index))),
		]);
		env.room = fakeRoom({});
		const {handle} = fakeHandle();
		render(handle);
		// 31 people stand (me included): 24 avatars and +7.
		expect(host.querySelectorAll('[data-standing] [data-avatar]')).toHaveLength(24);
		expect(host.querySelector('[data-standing-overflow]')?.textContent).toBe('+7');
	});

	it('none of my identities seated → asks the server for any seat after 3 s', () => {
		vi.useFakeTimers();
		const {handle} = fakeHandle();
		render(handle);
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(http.put).toHaveBeenCalledWith('/channels/500/voice-seat', {body: {connection_id: 'conn-a', seat: null}});
	});

	it('my seat attribute is there → no fallback request', () => {
		vi.useFakeTimers();
		env.room = fakeRoom({'user_2_conn-2': 'seat_A_01'});
		(env.room as {localParticipant: {attributes: Record<string, string>}}).localParticipant.attributes = {
			'micup.seat': 'seat_A_02',
		};
		const {handle} = fakeHandle();
		render(handle);
		act(() => {
			vi.advanceTimersByTime(60000);
		});
		expect(http.put).not.toHaveBeenCalled();
	});

	it('my seat attribute names a seat missing from this room (theme changed) → asks for any seat after 3 s', () => {
		vi.useFakeTimers();
		env.room = fakeRoom({});
		(env.room as {localParticipant: {attributes: Record<string, string>}}).localParticipant.attributes = {
			'micup.seat': 'seat_X_09',
		};
		const {handle} = fakeHandle();
		render(handle);
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(http.put).toHaveBeenCalledWith('/channels/500/voice-seat', {body: {connection_id: 'conn-a', seat: null}});
	});
});
