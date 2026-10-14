// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {GUILD_ID, responseFor, settingsResponse} from '@app/features/micupbot/testing/MicupBotTestData';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/core', () => ({
	i18n: {
		_: (descriptor: {message: string}, values: Record<string, unknown> = {}) =>
			descriptor.message.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token)),
	},
}));
vi.mock('@lingui/react/macro', async () => {
	const {i18n} = await import('@lingui/core');
	return {useLingui: () => ({i18n})};
});
const http = {
	get: vi.fn<(path: string, options?: unknown) => Promise<{body: unknown}>>(),
	patch: vi.fn(),
	put: vi.fn(),
	post: vi.fn(),
	delete: vi.fn(),
};
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
const {default: store} = await import('./MicupBotSettings');
function harness() {
	vi.resetAllMocks();
	store.close();
	http.get.mockImplementation(async (path: string) => ({body: responseFor(path)}));
	return {http, store};
}
afterEach(() => vi.restoreAllMocks());
describe('MicupBotSettings', () => {
	it('loads settings, automod, panels, rewards and the leaderboard', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		expect(store.data).toEqual(settingsResponse());
		expect(store.automod?.rules).toHaveLength(6);
		expect(store.panels?.panels).toEqual([]);
		expect(store.rewards?.rewards).toEqual([]);
		expect(store.leaderboard?.entries).toEqual([]);
		expect(http.get.mock.calls.some(([path]) => path.includes('/warnings/'))).toBe(false);
		expect(http.get).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/leaderboard`, {query: {limit: 10}});
	});
	it('saves only the changed settings fields', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		http.patch.mockResolvedValue({body: settingsResponse()});
		await store.updateSettings({...settingsResponse().settings, welcome_enabled: true});
		expect(http.patch).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/settings`, {body: {welcome_enabled: true}});
	});
	it('keeps the API error message', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		http.patch.mockRejectedValue(
			new HttpError({method: 'PATCH', path: '/', status: 429, body: {message: 'Wait 60 seconds.'}}),
		);
		expect(await store.updateSettings({commands_enabled: true})).toBe(false);
		expect(store.error).toBe('Wait 60 seconds.');
	});
	it('ignores responses from a previously opened community', async () => {
		const {http, store} = harness();
		let finish!: (value: {body: unknown}) => void;
		http.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const opening = store.open(GUILD_ID);
		store.close();
		await store.open('1485064866382176263');
		finish({body: settingsResponse({feature_enabled: false})});
		await opening;
		expect(store.data?.feature_enabled).toBe(true);
	});

	it('refreshes the leaderboard after enabling levels', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		http.patch.mockResolvedValue({
			body: settingsResponse({settings: {...settingsResponse().settings, levels_enabled: true}}),
		});
		http.get.mockResolvedValue({body: {levels_enabled: true, total: 0, entries: []}});
		await store.updateSettings({levels_enabled: true});
		expect(store.leaderboard?.levels_enabled).toBe(true);
	});

	it('rejects an oversized role selection before sending a request', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		expect(
			await store.updateSettings({
				autorole_ids: Array.from({length: 6}, (_, i) => String(BigInt(GUILD_ID) + BigInt(i))),
			}),
		).toBe(false);
		expect(http.patch).not.toHaveBeenCalled();
	});

	it('updates panels, automod and rewards through their typed endpoints', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		const input = {
			channel_id: GUILD_ID,
			mode: 'normal' as const,
			title: 'Choose a role',
			entries: [{emoji: {name: '✅'}, role_id: GUILD_ID}],
		};
		http.post.mockResolvedValue({body: {...input, message_id: 'panel', description: null, created_at: '2026-10-02'}});
		expect(await store.createPanel(input)).toBe(true);
		expect(store.panels?.panels).toHaveLength(1);
		expect(http.post).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/reaction-roles`, {body: input});
		expect(await store.deletePanel('panel')).toBe(true);
		expect(store.panels?.panels).toHaveLength(0);
		expect(http.delete).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/reaction-roles/panel`);
		http.put.mockResolvedValueOnce({body: {rules: []}}).mockResolvedValueOnce({body: {rewards: [], max_rewards: 25}});
		expect(await store.updateAutomod({rules: []})).toBe(true);
		expect(await store.updateRewards({rewards: []})).toBe(true);
		expect(http.put).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/automod`, {body: {rules: []}});
		expect(http.put).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/level-rewards`, {body: {rewards: []}});
	});

	it('ignores warning responses after changing members and deletes only the selected member warnings', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		let finish!: (value: {body: unknown}) => void;
		http.get.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const old = store.loadWarnings('first');
		http.get.mockResolvedValue({
			body: {warnings: [{id: 'current', moderator_id: 'mod', reason: 'Reason', created_at: '2026-10-02'}]},
		});
		await store.loadWarnings('second');
		finish({body: {warnings: [{id: 'stale'}]}});
		await old;
		expect(store.warnings?.warnings[0]?.id).toBe('current');
		await store.removeWarning('current');
		expect(http.delete).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/warnings/second/current`);
		expect(store.warnings?.warnings).toEqual([]);
		await store.removeWarning();
		expect(http.delete).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/warnings/second`);
	});
	it('shows loaded settings while the public application name is still pending', async () => {
		const {http, store} = harness();
		let finish!: (value: {body: unknown}) => void;
		http.get.mockImplementation(async (path) =>
			path.endsWith('/public')
				? new Promise((resolve) => {
						finish = resolve;
					})
				: {body: responseFor(path)},
		);
		const opening = store.open(GUILD_ID);
		await vi.waitFor(() => expect(store.data).not.toBeNull());
		const loading = store.loading;
		finish({body: {name: 'Public name'}});
		await opening;
		expect(loading).toBe(false);
		expect(store.applicationName).toBe('Public name');
	});
	it('uses a loading error when settings cannot be fetched', async () => {
		const {http, store} = harness();
		http.get.mockRejectedValueOnce(new Error('offline'));
		await store.open(GUILD_ID);
		expect(store.error).toBe('Failed to load');
		expect(store.loading).toBe(false);
	});
	it('uses a loading error when warnings cannot be fetched', async () => {
		const {http, store} = harness();
		await store.open(GUILD_ID);
		http.get.mockRejectedValueOnce(new Error('offline'));
		await store.loadWarnings('123');
		expect(store.error).toBe('Failed to load');
		expect(store.warningsLoading).toBe(false);
	});
	it('preserves the API message when loading fails', async () => {
		const {http, store} = harness();
		http.get.mockRejectedValueOnce(
			new HttpError({method: 'GET', path: '/', status: 403, body: {message: 'Access denied.'}}),
		);
		await store.open(GUILD_ID);
		expect(store.error).toBe('Access denied.');
	});
});
