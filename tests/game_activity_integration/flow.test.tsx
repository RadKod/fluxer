// SPDX-License-Identifier: AGPL-3.0-or-later
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createUserID} from '@app/api/BrandedTypes';
import {decideProfileView} from '@app/api/user/profile/ProfileAccessRules';
import {GameActivityPolicyService, gameActivityPolicyState} from '@app/api/user/services/GameActivityPolicyService';
import {ProfilePrivacyLevels, RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {GameActivityVisibilitySchema} from '@fluxer/schema/src/domains/user/GameActivitySchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GameActivityDetection} from '../../fluxer_desktop/src/main/GameActivityDetection';

const fixture = vi.hoisted(() => ({blocked: false}));
vi.mock('@app/features/app/state/GeoIP', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {handleConnectionClosed: vi.fn()}}));
vi.mock('@app/features/gateway/transport/GatewayConnection', () => ({default: {logout: vi.fn()}}));
vi.mock('@app/features/gateway/transport/FastConnect', () => ({takeFastConnect: () => null}));
vi.mock('@app/features/gateway/transport/GatewayCompression', () => ({
	GatewayCompression: class {},
	isGatewayCompressionError: () => false,
}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {clearExcept: vi.fn(), getItem: () => null},
	PRESERVED_RESET_STORAGE_KEYS: [],
}));
vi.mock('@app/features/ui/state/LayerManager', () => ({default: {closeAll: vi.fn()}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: {connectionId: null}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
		debug() {}
		error() {}
	},
	LogLevel: {},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', async () => {
	const {setupI18n} = await import('@lingui/core');
	return {useLingui: () => ({i18n: setupI18n({locale: 'en', messages: {en: {}}})})};
});
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {id: '1'}}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({
	default: {
		getRelationship: () => ({type: RelationshipTypes.FRIEND}),
		isBlocked: () => fixture.blocked,
	},
}));

const {DesktopGameActivityBridge} = await import('@app/features/game_activity/utils/DesktopGameActivityBridge');
const {GatewaySocket, GatewayState} = await import('@app/features/gateway/transport/GatewaySocket');
const {GameActivityDisplay} = await import('@app/features/game_activity/components/GameActivityDisplay');
const {default: store} = await import('@app/features/game_activity/state/GameActivityStore');
const {getGameIconUrl} = await import('@app/features/game_activity/utils/GameIconUrls');

function project(input: unknown) {
	const temp = process.env.GAME_ACTIVITY_TEST_TMP!;
	const path = join(temp, 'input.json').replaceAll('\\', '/');
	writeFileSync(path, JSON.stringify(input));
	const erl = process.env.OTP_BIN ? join(process.env.OTP_BIN, process.platform === 'win32' ? 'erl.exe' : 'erl') : 'erl';
	const result = spawnSync(
		erl,
		[
			'-noshell',
			'-pa',
			join(temp, 'ebin'),
			'-pa',
			process.env.GAME_ACTIVITY_MECK_EBIN!,
			'-eval',
			`game_activity_integration_bridge:run("${path}"),halt().`,
		],
		{encoding: 'utf8', timeout: 25000},
	);
	if (result.status !== 0) throw new Error(`${result.error ?? ''}${result.stdout}${result.stderr}`);
	return JSON.parse(result.stdout) as {
		viewers: Array<{viewer: number; subscribed: boolean; output: Array<any>}>;
		selected: unknown;
	};
}

async function grants(profilePrivacy = ProfilePrivacyLevels.FRIENDS, visibility = 'friends') {
	const owner = {isBot: false, isSystem: false, dateOfBirth: '2000-01-01'};
	const settings = {gameActivityVisibility: visibility, gameActivityPolicyRevision: 3n, profilePrivacy};
	const service = new GameActivityPolicyService({
		users: {
			findUnique: async () => owner,
			findSettings: async () => settings,
			getRelationship: async (viewer: bigint, target: bigint, kind: number) =>
				kind === RelationshipTypes.FRIEND
					? {}
					: kind === RelationshipTypes.BLOCKED && viewer === 3n && target === 2n
						? {}
						: null,
			getIncomingRelationship: async () => null,
		} as never,
		gateway: {} as never,
	});
	const viewers = await Promise.all(
		[1, 3].map(async (viewer) => ({
			viewer,
			grant: (await service.getGrants(createUserID(BigInt(viewer)), [createUserID(2n)], 'e2e-grant')).grants[0],
		})),
	);
	return {policy: gameActivityPolicyState(owner as never, settings as never), viewers};
}

describe('C/catalog -> D producer/socket -> A grants -> B owner/receiver -> D profile component integration', () => {
	const roots: Array<ReturnType<typeof createRoot>> = [];
	const bridges: Array<InstanceType<typeof DesktopGameActivityBridge>> = [];
	const detectors: Array<GameActivityDetection> = [];
	beforeEach(() => {
		vi.useFakeTimers({now: Date.now()});
		fixture.blocked = false;
		store.reset();
		store.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
		Object.defineProperty(document, 'hidden', {value: false, configurable: true});
		vi.stubGlobal('IntersectionObserver', undefined);
		vi.stubGlobal('WebSocket', {OPEN: 1});
		(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	});
	afterEach(async () => {
		await act(async () => {
			for (const root of roots.splice(0)) root.unmount();
		});
		for (const bridge of bridges.splice(0)) await bridge.setAccount(null);
		for (const detector of detectors.splice(0)) await detector.stop();
		document.body.replaceChildren();
		store.reset();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	async function source() {
		const frames: Array<{op: number; d: any}> = [];
		const socket = new GatewaySocket('wss://local-fixture.invalid', {
			token: 'fixture',
			apiVersion: 1,
			compression: 'none',
			properties: {} as never,
		});
		Object.assign(socket, {
			connectionState: GatewayState.Connected,
			socket: {readyState: 1, send: (data: string) => frames.push(JSON.parse(data))},
		});
		let listener: ((state: any) => void) | null = null;
		const listProcesses = vi.fn(async () => [{exe: 'VALORANT-Win64-Shipping.exe', pid: 4242}]);
		const detector = new GameActivityDetection({
			platform: 'win32',
			listProcesses,
			now: () => Date.now() - 120000,
			monotonicNow: () => performance.now(),
			onState: (state) => listener?.(state),
		});
		detectors.push(detector);
		const bridge = new DesktopGameActivityBridge({
			getApi: () => ({
				gameActivityGetCapabilities: async () => ({version: 1, supported: true}),
				gameActivityConfigure: async (request: any) => {
					const result = detector.configure(request);
					await detector.poll();
					return result;
				},
				gameActivityGetState: async () => detector.getState(),
				onGameActivityState: (callback: any) => {
					listener = callback;
					return () => {
						listener = null;
					};
				},
			}),
			getPresence: () => ({status: 'dnd', afk: true, mobile: false, custom_status: {text: 'keep'}}),
			getEnabled: () => true,
			send: (presence) =>
				socket.updatePresence(
					presence.status,
					presence.afk,
					presence.mobile,
					presence.custom_status,
					presence.game_activity,
				),
		});
		bridges.push(bridge);
		await bridge.setAccount('2');
		vi.advanceTimersByTime(3000);
		return {bridge, detector, frames, listProcesses};
	}
	async function render(userId = '2', fullProfile = true, visible = true) {
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () => root.render(createElement(GameActivityDisplay, {userId, fullProfile, visible})));
		return container;
	}
	it('fake process selects real catalog game and authorized friend sees its icon, name and duration; off clears immediately', async () => {
		const {bridge, frames, listProcesses} = await source();
		expect(listProcesses).toHaveBeenCalledOnce();
		expect(frames[0]).toEqual({
			op: 3,
			d: {
				status: 'dnd',
				afk: true,
				mobile: false,
				custom_status: {text: 'keep'},
				game_activity: {game_id: 'valorant', started_at: Date.now() - 123000},
			},
		});
		const start = frames[0].d.game_activity;
		const result = project({...(await grants()), activities: [start], off: true});
		const friend = result.viewers.find((row) => row.viewer === 1)!;
		expect(friend.subscribed).toBe(true);
		expect(friend.output[0]).toEqual({user: {id: '2'}, game_activity: start});
		store.update(friend.output[0]);
		const view = await render();
		let iconUrl: string | null = null;
		await act(async () => {
			iconUrl = await getGameIconUrl('valorant', 64);
		});
		expect(view.textContent).toContain('VALORANT');
		expect(view.textContent).toContain('2 min');
		expect(view.querySelector('img')?.getAttribute('src')).toBe(iconUrl);
		expect(result.selected).toBeNull();
		expect(friend.output.at(-1)?.game_activity).toBeNull();
		await act(async () => store.update(friend.output.at(-1)!));
		expect(view.textContent).not.toContain('VALORANT');
		const stopped = bridge.stopSharing();
		expect(frames.at(-1)?.d).toEqual({...frames[0].d, game_activity: null});
		await stopped;
		expect(vi.getTimerCount()).toBe(0);
	});
	it('blocked viewer receives no projection even with friendship and the client refuses leaked blocked data', async () => {
		const {frames} = await source();
		const result = project({...(await grants()), activities: [frames[0].d.game_activity]});
		const blocked = result.viewers.find((row) => row.viewer === 3)!;
		expect(blocked.subscribed).toBe(false);
		expect(blocked.output).toEqual([]);
		fixture.blocked = true;
		store.update({user: {id: '2'}, game_activity: frames[0].d.game_activity});
		expect((await render()).textContent).toBe('');
	});
	it('rejects shared_guilds sharing while existing profile guilds audience still intersects friendship', async () => {
		expect(GameActivityVisibilitySchema.safeParse('shared_guilds').success).toBe(false);
		const data = await grants(ProfilePrivacyLevels.MUTUAL_GUILDS);
		expect(data.policy.effective_profile_audience).toBe('guilds');
		expect(data.viewers[0].grant.allowed).toBe(true);
		expect(decideProfileView({audience: 'guilds', bond: 'guild', blocked: false, bot: false, strangerOk: false})).toBe(
			'full',
		);
		const strangerGrant = {...data.viewers[0].grant, friend: false, allowed: false};
		const result = project({
			...data,
			viewers: [{viewer: 1, grant: strangerGrant}],
			activities: [{game_id: 'valorant', started_at: Date.now()}],
		});
		expect(result.viewers[0].subscribed).toBe(false);
		expect(result.viewers[0].output).toEqual([]);
	});
	it('only_me and account sharing off deny at A and B', async () => {
		for (const data of [
			await grants(ProfilePrivacyLevels.ONLY_ME),
			await grants(ProfilePrivacyLevels.FRIENDS, 'off'),
		]) {
			expect(data.viewers[0].grant.allowed).toBe(false);
			const result = project({...data, activities: [{game_id: 'valorant', started_at: Date.now()}]});
			expect(result.viewers[0].subscribed).toBe(false);
			expect(result.viewers[0].output).toEqual([]);
		}
	});
	it('real display instances share one visible clock and preserve a friend activity across guild/absent updates', async () => {
		const activity = {game_id: 'valorant', started_at: Date.now() - 120000};
		store.update({user: {id: '2'}, game_activity: activity});
		const first = await render();
		await render('2');
		await render('2', true, false);
		expect(vi.getTimerCount()).toBe(1);
		await act(async () => {
			store.update({user: {id: '2'}, guild_id: 'guild', game_activity: null});
			store.update({user: {id: '2'}, status: 'online'});
			vi.advanceTimersByTime(60000);
		});
		expect(first.textContent).toContain('3 min');
		expect(store.get('2')).toEqual(activity);
		await act(async () => {
			for (const root of roots.splice(0)) root.unmount();
		});
		expect(vi.getTimerCount()).toBe(0);
	});
});
