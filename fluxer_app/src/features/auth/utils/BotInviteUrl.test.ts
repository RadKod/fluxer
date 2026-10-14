// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {webAppBaseUrl: 'https://app.example.test'}}));
const {buildBotInviteUrl} = await import('./BotInviteUrl');

describe('BotInviteUrl', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('builds the guild invite with guild_id and disable_guild_select', async () => {
		const url = new URL(buildBotInviteUrl({applicationId: '123', guildId: '456', permissions: '17910848'}));
		expect(url.origin).toBe(location.origin);
		expect(url.pathname).toBe('/oauth2/authorize');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: '123',
			scope: 'bot',
			permissions: '17910848',
			guild_id: '456',
			disable_guild_select: 'true',
		});
	});
	it('without a guild it leaves the community choice to the user', () => {
		const url = new URL(buildBotInviteUrl({applicationId: '123', permissions: '17910848'}));
		expect(url.searchParams.has('guild_id')).toBe(false);
		expect(url.searchParams.has('disable_guild_select')).toBe(false);
	});
	it('uses the configured web origin in a desktop location without an HTTP origin', () => {
		vi.stubGlobal('location', {origin: 'null', protocol: 'file:'});
		expect(new URL(buildBotInviteUrl({applicationId: '123', guildId: '456', permissions: '17910848'})).origin).toBe(
			'https://app.example.test',
		);
	});
});
