// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {testView} from '@app/features/table_game/state/TableGameTestViews';
import type {VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ROOM_THEME_MANIFEST} from '@fluxer/constants/src/VoiceRoomThemeManifest';
import {observer} from 'mobx-react-lite';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({
	rendererModuleLoaded: false,
	createRenderer: vi.fn(),
	makePersistent: vi.fn(() => Promise.resolve()),
	canManage: false,
	defaultTheme: null as string | null,
	updateChannel: vi.fn(async () => undefined),
	can: vi.fn(),
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (d: {message: string}, values: Record<string, unknown> = {}) =>
				d.message.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token)),
		},
	}),
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: env.makePersistent}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
	},
}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, games: true, default_room_theme: env.defaultTheme}),
}));
vi.mock('@app/features/permissions/state/Permission', () => ({
	default: {
		can: (...args: Array<unknown>) => {
			env.can(...args);
			return env.canManage;
		},
	},
}));
vi.mock('@app/features/channel/commands/ChannelCommands', () => ({update: env.updateChannel}));
vi.mock('@app/features/channel/components/alerts/ChannelErrorModalUtils', () => ({showChannelErrorModal: vi.fn()}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({
	Combobox: ({
		'aria-label': label,
		value,
		options,
		onChange,
	}: {
		'aria-label': string;
		value: string | null;
		options: Array<{value: string | null; label: string}>;
		onChange: (value: string | null) => void;
	}) =>
		createElement(
			'select',
			{
				'aria-label': label,
				value: value ?? '',
				onChange: (event: {target: {value: string}}) => onChange(event.target.value || null),
			},
			options.map((option) =>
				createElement('option', {key: option.value ?? '', value: option.value ?? ''}, option.label),
			),
		),
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/voice_scene/utils/WebglSupport', () => ({
	getWebglSupport: () => ({webgl2: true, renderer: 'ANGLE (NVIDIA)', hardwareConcurrency: 8, deviceMemory: 8}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {staticCdnEndpoint: 'https://static.micup.gg'}}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => createElement('span', {'data-spinner': true})}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/channel/components/channel_header_components/ChannelHeaderIcon', () => ({
	ChannelHeaderIcon: ({label, onClick}: {label: string; onClick?: () => void}) =>
		createElement('button', {type: 'button', 'data-header-icon': label, onClick}, label),
}));
vi.mock('@app/features/voice_scene/components/VoiceSceneOverlay', () => ({
	VoiceSceneOverlay: () => createElement('div', {'data-overlay': true}),
}));
vi.mock('@app/features/table_game/utils/drawTableTop', () => ({drawTableTop: vi.fn()}));
vi.mock('@app/features/voice_scene/scene/VoiceSceneRenderer', () => {
	env.rendererModuleLoaded = true;
	return {createVoiceSceneRenderer: (...args: Array<unknown>) => env.createRenderer(...args)};
});

const {VoiceSceneView} = await import('@app/features/voice_scene/components/VoiceSceneView');
const {VoiceSceneToggleButton} = await import('@app/features/voice_scene/components/VoiceSceneToggleButton');
const {roomViewFor} = await import('@app/features/voice_scene/state/RoomView');
const {default: VoiceSceneSettings} = await import('@app/features/voice_scene/state/VoiceSceneSettings');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {drawTableTop} = await import('@app/features/table_game/utils/drawTableTop');

// Taken at import: the store persists itself once, and mocks are cleared before every test.
const persistCalls = [...env.makePersistent.mock.calls];
const ROOM_CHANNEL = {id: '500', guildId: '9', type: ChannelTypes.GUILD_VOICE, roomTheme: 'oyun-odasi'} as never;

const FlatOrRoom = observer(function FlatOrRoom({channel}: {channel: never}) {
	return roomViewFor(channel).show
		? createElement(VoiceSceneView, {channel})
		: createElement('div', {'data-flat': roomViewFor(channel).reason});
});

function fakeHandle(): VoiceSceneHandle {
	return {
		layout: {
			seats: [],
			stands: [],
			tables: [],
			camTarget: {x: 0, y: 0, z: 0},
			camHome: {x: 0, y: 10, z: 10},
			screen: null,
			camPan: {x: 0, z: 0},
		},
		project: () => ({x: 0, y: 0, visible: true, scale: 1}),
		onViewChange: () => () => {},
		getCameraAzimuth: () => 0,
		requestRender: vi.fn(),
		setTableTop: vi.fn(),
		attachScreenElement: vi.fn(),
		screenInView: () => true,
		occluder: () => () => false,
		wheel: vi.fn(),
		getCameraMode: () => 'orbit',
		onCameraModeChange: () => () => {},
		focusScreen: vi.fn(),
		enterSeatView: vi.fn(),
		exitToOrbit: vi.fn(),
		mountTableGame: () => null,
	};
}

let root: Root | null = null;
let host: HTMLDivElement;

async function render(node: ReactNode): Promise<void> {
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(node);
	});
	await flush();
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	env.canManage = false;
	env.defaultTheme = null;
	env.updateChannel.mockClear();
	env.can.mockClear();
	env.createRenderer.mockReset();
	VoiceSceneSettings.retry();
	TableGames.reset();
	vi.mocked(drawTableTop).mockClear();
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
});

describe('VoiceSceneView', () => {
	it('loads three only through dynamic import (renderer module mocked)', async () => {
		expect(env.rendererModuleLoaded).toBe(false);
		const handle = fakeHandle();
		const dispose = vi.fn();
		const create = env.createRenderer;
		create.mockResolvedValueOnce({handle, dispose});
		await render(createElement(VoiceSceneView, {channel: ROOM_CHANNEL}));
		expect(env.rendererModuleLoaded).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(host.querySelector('[data-overlay]')).not.toBeNull();
		await act(async () => {
			root?.unmount();
		});
		root = null;
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it('takes the GLB only from the manifest file under the static CDN (Ş8)', async () => {
		const create = env.createRenderer;
		create.mockResolvedValueOnce({handle: fakeHandle(), dispose: vi.fn()});
		await render(createElement(VoiceSceneView, {channel: ROOM_CHANNEL}));
		// The manifest names a content-hashed file; the URL is that name under the static CDN and nothing else.
		const {file} = VOICE_ROOM_THEME_MANIFEST['oyun-odasi'];
		expect(file).toMatch(/^oyun-odasi\.[0-9a-f]{12}\.glb$/);
		expect(create.mock.calls[0]?.[0].url).toBe(`https://static.micup.gg/rooms/${file}`);
	});

	it('loads the inherited instance theme from the manifest', async () => {
		env.defaultTheme = 'kahvehane';
		env.createRenderer.mockResolvedValueOnce({handle: fakeHandle(), dispose: vi.fn()});
		await render(
			createElement(FlatOrRoom, {
				channel: {id: '500', guildId: '9', type: ChannelTypes.GUILD_VOICE, roomTheme: null} as never,
			}),
		);
		expect(host.querySelector('[data-flat]')).toBeNull();
		expect(env.createRenderer.mock.calls[0]?.[0].url).toBe(
			`https://static.micup.gg/rooms/${VOICE_ROOM_THEME_MANIFEST.kahvehane.file}`,
		);
	});

	it.each([ChannelTypes.DM, ChannelTypes.GROUP_DM])(
		'does not load an inherited scene in channel type %s',
		async (type) => {
			env.defaultTheme = 'kahvehane';
			await render(
				createElement(VoiceSceneView, {channel: {id: '500', guildId: null, type, roomTheme: null} as never}),
			);
			expect(env.createRenderer).not.toHaveBeenCalled();
			expect(host.querySelector('[data-overlay]')).toBeNull();
		},
	);

	it('offers the room selector to channel managers and updates the shared channel', async () => {
		env.canManage = true;
		env.defaultTheme = 'kahvehane';
		env.createRenderer.mockResolvedValueOnce({handle: fakeHandle(), dispose: vi.fn()});
		await render(createElement(VoiceSceneView, {channel: ROOM_CHANNEL}));
		const select = host.querySelector<HTMLSelectElement>('select[aria-label="Room theme"]');
		expect(select).not.toBeNull();
		expect(env.can).toHaveBeenCalledWith(Permissions.MANAGE_CHANNELS, {guildId: '9', channelId: '500'});
		expect(select!.options[0].textContent).toBe('Default (Coffeehouse)');
		await act(async () => {
			select!.value = 'none';
			select!.dispatchEvent(new Event('change', {bubbles: true}));
		});
		expect(env.updateChannel).toHaveBeenCalledWith('500', {room_theme: 'none'});
	});

	it('does not expose the room selector without manage channels permission', async () => {
		env.createRenderer.mockResolvedValueOnce({handle: fakeHandle(), dispose: vi.fn()});
		await render(createElement(VoiceSceneView, {channel: ROOM_CHANNEL}));
		expect(host.querySelector('select[aria-label="Room theme"]')).toBeNull();
	});

	it('shows the flat view on loader error', async () => {
		env.createRenderer.mockRejectedValueOnce(new Error('GLB contract: screen missing'));
		await render(createElement(FlatOrRoom, {channel: ROOM_CHANNEL}));
		expect(host.querySelector('[data-flat]')?.getAttribute('data-flat')).toBe('load_failed');
		expect(VoiceSceneSettings.failure).toBe('load_failed');
	});

	it('flat/room toggle persists per device', async () => {
		expect(persistCalls).toEqual([
			[VoiceSceneSettings, 'VoiceSceneSettings', ['preferRoom', 'spatialAudio', 'showRoomCameras']],
		]);
		await render(createElement(VoiceSceneToggleButton, {channel: ROOM_CHANNEL}));
		const button = () => host.querySelector('[data-header-icon]') as HTMLButtonElement;
		expect(button().textContent).toBe('Show flat view');
		await act(async () => button().click());
		expect(VoiceSceneSettings.preferRoom).toBe(false);
		expect(roomViewFor(ROOM_CHANNEL).reason).toBe('user_flat');
		expect(button().textContent).toBe('Show 3D room');
		await act(async () => button().click());
		expect(VoiceSceneSettings.preferRoom).toBe(true);
	});

	it('after a lost context the header offers a retry that brings the room back', async () => {
		VoiceSceneSettings.reportFailure('context_lost');
		await render(createElement(VoiceSceneToggleButton, {channel: ROOM_CHANNEL}));
		const button = host.querySelector('[data-header-icon]') as HTMLButtonElement;
		expect(button.textContent).toBe('3D view stopped. Try again');
		await act(async () => button.click());
		expect(roomViewFor(ROOM_CHANNEL)).toEqual({show: true, reason: 'room'});
	});

	it('a table state change redraws only that table top', async () => {
		const handle = fakeHandle();
		env.createRenderer.mockResolvedValueOnce({handle, dispose: vi.fn()});
		await render(createElement(VoiceSceneView, {channel: ROOM_CHANNEL}));
		vi.mocked(handle.setTableTop).mockClear();
		vi.mocked(drawTableTop).mockClear();
		const view = testView({version: 2, summary: {slot: 'T02'}});
		await act(async () => {
			TableGames.handleView('500', view, 'event');
		});
		expect(drawTableTop).toHaveBeenCalledTimes(1);
		expect(vi.mocked(drawTableTop).mock.calls[0]?.[1]).toBe(TableGames.getView('500', 'T02'));
		expect(handle.setTableTop).toHaveBeenCalledTimes(1);
		expect(vi.mocked(handle.setTableTop).mock.calls[0]?.[0]).toBe('T02');
	});
});
