// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import type {
	GuildRosterEventListResponse,
	GuildRosterEventResponse,
} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn()},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/core', () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}));
const {http} = await import('@app/features/platform/transport/RestTransport');
const {default: store} = await import('./GuildRosterEvents');

const event: GuildRosterEventResponse = {
	id: '111',
	guild_id: '222',
	name: 'Raid',
	voice_channel_id: '333',
	announce_channel_id: '444',
	mention_role_id: null,
	main_size: 10,
	sub_size: 5,
	enabled: true,
	created_at: '2026-10-02T00:00:00.000Z',
	updated_at: '2026-10-02T00:00:00.000Z',
};
const list: GuildRosterEventListResponse = {
	feature_enabled: true,
	bot: {application_id: '555', user_id: '555', in_guild: true},
	invite_permissions: '17910848',
	max_events: 10,
	events: [],
};

describe('GuildRosterEvents', () => {
	beforeEach(() => {
		store.close();
		vi.resetAllMocks();
	});
	afterEach(async () => {
		store.close();
		vi.restoreAllMocks();
	});

	it('loads, creates, updates and deletes through the endpoints', async () => {
		const get = vi.spyOn(http, 'get').mockResolvedValue({body: list} as never);
		const post = vi.spyOn(http, 'post').mockResolvedValue({body: event} as never);
		const patch = vi.spyOn(http, 'patch').mockResolvedValue({body: {...event, name: 'Dungeon'}} as never);
		const remove = vi.spyOn(http, 'delete').mockResolvedValue({body: null} as never);
		await store.open('222');
		expect(get).toHaveBeenCalledWith('/guilds/222/roster-events');
		const data = {
			name: 'Raid',
			voice_channel_id: '333',
			announce_channel_id: '444',
			main_size: 10,
			sub_size: 5,
			enabled: true,
		};
		expect(await store.create(data)).toBe(true);
		expect(post).toHaveBeenCalledWith('/guilds/222/roster-events', {body: data});
		expect(store.data?.events).toEqual([event]);
		expect(await store.update('111', {name: 'Dungeon'})).toBe(true);
		expect(patch).toHaveBeenCalledWith('/guilds/222/roster-events/111', {body: {name: 'Dungeon'}});
		expect(store.data?.events[0]?.name).toBe('Dungeon');
		expect(await store.remove('111')).toBe(true);
		expect(remove).toHaveBeenCalledWith('/guilds/222/roster-events/111');
		expect(store.data?.events).toEqual([]);
	});

	it('keeps the API error message', async () => {
		vi.spyOn(http, 'get').mockRejectedValue(
			new HttpError({
				method: 'GET',
				path: '/guilds/222/roster-events',
				status: 403,
				body: {message: 'Bu işlem için yetkiniz yok.'},
			}),
		);
		await store.open('222');
		expect(store.error).toBe('Bu işlem için yetkiniz yok.');
		expect(store.loading).toBe(false);
	});

	it('says loading failed when settings cannot be loaded', async () => {
		vi.spyOn(http, 'get').mockRejectedValue(new Error('offline'));
		await store.open('222');
		expect(store.error).toBe('Could not load event bot settings.');
	});

	it('says updating failed when a save fails without a server message', async () => {
		vi.spyOn(http, 'get').mockResolvedValue({body: list} as never);
		vi.spyOn(http, 'delete').mockRejectedValue(new Error('offline'));
		await store.open('222');
		expect(await store.remove('111')).toBe(false);
		expect(store.error).toBe('Could not update event bot settings. Please try again.');
	});

	it('ignores a late response after closing and reopening the same guild', async () => {
		let resolve!: (value: never) => void;
		vi.spyOn(http, 'get')
			.mockImplementationOnce(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			)
			.mockResolvedValue({body: list} as never);
		const first = store.open('222');
		store.close();
		await store.open('222');
		resolve({body: {...list, events: [event]}} as never);
		await first;
		expect(store.data?.events).toEqual([]);
	});
});
