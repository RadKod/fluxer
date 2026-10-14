// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildBoostResponse, UserBoostSlotResponse} from '@fluxer/schema/src/domains/boost/BoostResponseSchemas';
import type React from 'react';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const guildState = vi.hoisted(() => ({guilds: {} as Record<string, unknown>}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/guild/models/GuildRole', () => ({GuildRole: class {}}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({noteText: () => {}}));
vi.mock('@app/features/guild/state/Guilds', async () => {
	const {Guild} = await import('@app/features/guild/models/Guild');
	return {
		default: {
			getGuild: (id: string) => guildState.guilds[id],
			handleGuildUpdate: (guild: ConstructorParameters<typeof Guild>[0]) => {
				guildState.guilds[guild.id] = new Guild(guild);
			},
		},
	};
});

vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	modal: (render: () => React.ReactElement) => render,
	pop: vi.fn(),
	push: vi.fn(),
}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const {GUILD_BOOSTS_PAGE_SIZE} = await import('@app/features/boost/commands/GuildBoostCommands');
const {default: GuildBoosts} = await import('@app/features/boost/state/GuildBoosts');
const {Guild} = await import('@app/features/guild/models/Guild');

const GUILD_ID = '1485064866382176262';

function boost(id: number): GuildBoostResponse {
	return {
		id: String(id),
		guild_id: GUILD_ID,
		user: {
			id: `u${id}`,
			username: `user${id}`,
			discriminator: '0000',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		created_at: '2026-09-24T00:00:00.000Z',
	};
}

function page(from: number, size: number): Array<GuildBoostResponse> {
	return Array.from({length: size}, (_, index) => boost(from - index));
}

function slot(id: string, guildId: string | null, boostId: string | null = null): UserBoostSlotResponse {
	return {id, guild_id: guildId, boost_id: boostId, assigned_at: guildId ? '2026-09-24T00:00:00.000Z' : null};
}

function respond(
	boosts: Array<GuildBoostResponse>,
	slots: Array<UserBoostSlotResponse>,
	guild: {premium_tier?: number; premium_subscription_count?: number} = {},
) {
	vi.mocked(http.get).mockImplementation(async (url: unknown) => {
		if (url === '/users/@me/boost-slots') return {body: slots} as never;
		if (url === `/guilds/${GUILD_ID}`) return {body: {id: GUILD_ID, ...guild}} as never;
		return {body: boosts} as never;
	});
}

function boostListCalls() {
	return vi.mocked(http.get).mock.calls.filter(([url]) => url === `/guilds/${GUILD_ID}/boosts`);
}

describe('GuildBoosts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		GuildBoosts.close();
		guildState.guilds = {};
	});

	it('shows the level the server reports for the community, not one counted from its boosts', async () => {
		respond([], [], {premium_tier: 1, premium_subscription_count: 20});
		await GuildBoosts.open(GUILD_ID);
		expect(GuildBoosts.ready).toBe(true);
		expect(GuildBoosts.status).toEqual(expect.objectContaining({level: 1, count: 20}));
	});

	it('asks for the first page with the page limit and no cursor', async () => {
		respond(page(500, GUILD_BOOSTS_PAGE_SIZE), []);
		await GuildBoosts.open(GUILD_ID);
		expect(GUILD_BOOSTS_PAGE_SIZE).toBeLessThanOrEqual(100);
		expect(boostListCalls()).toEqual([[`/guilds/${GUILD_ID}/boosts`, {query: {limit: GUILD_BOOSTS_PAGE_SIZE}}]]);
		expect(GuildBoosts.hasMore).toBe(true);
		expect(GuildBoosts.hasPrevious).toBe(false);
	});

	it('pages with the last boost as the before cursor and holds only the current page', async () => {
		const first = page(500, GUILD_BOOSTS_PAGE_SIZE);
		respond(first, []);
		await GuildBoosts.open(GUILD_ID);
		respond(page(400, GUILD_BOOSTS_PAGE_SIZE), []);
		await GuildBoosts.nextPage();
		respond(page(300, 10), []);
		await GuildBoosts.nextPage();
		expect(boostListCalls().map(([, options]) => options)).toEqual([
			{query: {limit: GUILD_BOOSTS_PAGE_SIZE}},
			{query: {limit: GUILD_BOOSTS_PAGE_SIZE, before: first.at(-1)?.id}},
			{query: {limit: GUILD_BOOSTS_PAGE_SIZE, before: '301'}},
		]);
		expect(GuildBoosts.page.map((entry) => entry.id)).toEqual(page(300, 10).map((entry) => entry.id));
		expect(GuildBoosts.hasMore).toBe(false);
	});

	it('goes back by fetching the earlier cursor again', async () => {
		const first = page(500, GUILD_BOOSTS_PAGE_SIZE);
		respond(first, []);
		await GuildBoosts.open(GUILD_ID);
		respond(page(400, GUILD_BOOSTS_PAGE_SIZE), []);
		await GuildBoosts.nextPage();
		respond(first, []);
		await GuildBoosts.previousPage();
		expect(boostListCalls().at(-1)?.[1]).toEqual({query: {limit: GUILD_BOOSTS_PAGE_SIZE}});
		expect(GuildBoosts.page[0]?.id).toBe('500');
		expect(GuildBoosts.hasPrevious).toBe(false);
	});

	it('spends a free slot on the community', async () => {
		respond([], [slot('s1', 'other-guild', 'b0'), slot('s2', null)]);
		await GuildBoosts.open(GUILD_ID);
		vi.mocked(http.put).mockResolvedValue({body: boost(1)} as never);
		await GuildBoosts.boost();
		expect(http.put).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/boosts`, {body: {slot_id: 's2'}});
		expect(ModalCommands.push).not.toHaveBeenCalled();
	});

	it('sends a member without a free slot to the premium settings instead of boosting', async () => {
		respond([], [slot('s1', 'other-guild', 'b0')]);
		await GuildBoosts.open(GUILD_ID);
		await GuildBoosts.boost();
		expect(http.put).not.toHaveBeenCalled();
		expect(ModalCommands.pop).toHaveBeenCalledOnce();
		const render = vi.mocked(ModalCommands.push).mock.calls[0]?.[0] as unknown as () => React.ReactElement<{
			initialTab: string;
		}>;
		expect(render().props.initialTab).toBe('plutonium');
	});

	it('removes only the boosts of the member on this community', async () => {
		respond([], [slot('s1', GUILD_ID, 'b1'), slot('s2', 'other-guild', 'b2')]);
		await GuildBoosts.open(GUILD_ID);
		expect(GuildBoosts.ownBoostIds).toEqual(['b1']);
		vi.mocked(http.delete).mockResolvedValue({body: null} as never);
		await GuildBoosts.removeBoost('b1');
		expect(http.delete).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/boosts/b1`);
	});

	it('keeps the header count fresh after a boost that does not change the level, preserving guild fields', async () => {
		guildState.guilds[GUILD_ID] = new Guild({
			id: GUILD_ID,
			name: 'A long community name',
			icon: 'icon',
			vanity_url_code: null,
			owner_id: '1',
			system_channel_id: null,
			features: ['TEST_FEATURE'],
			premium_tier: 0,
			premium_subscription_count: 0,
			joined_at: '2026-09-24T00:00:00.000Z',
		});
		respond([], [slot('s1', null)], {premium_tier: 0, premium_subscription_count: 0});
		await GuildBoosts.open(GUILD_ID);
		vi.mocked(http.put).mockImplementation(async () => {
			respond([boost(1)], [slot('s1', GUILD_ID, '1')], {premium_tier: 0, premium_subscription_count: 1});
			return {body: boost(1)} as never;
		});
		await GuildBoosts.boost();
		GuildBoosts.close();
		const updated = guildState.guilds[GUILD_ID] as InstanceType<typeof Guild>;
		expect(updated.premiumSubscriptionCount).toBe(1);
		expect(updated.premiumTier).toBe(0);
		expect(updated.name).toBe('A long community name');
		expect(updated.icon).toBe('icon');
		expect(updated.features.has('TEST_FEATURE')).toBe(true);
		expect(updated.joinedAt).toBe('2026-09-24T00:00:00.000Z');
	});

	it('ignores an older count response after reopening the same community', async () => {
		guildState.guilds[GUILD_ID] = new Guild({
			id: GUILD_ID,
			name: 'Micup',
			icon: null,
			vanity_url_code: null,
			owner_id: '1',
			system_channel_id: null,
			features: [],
			premium_tier: 0,
			premium_subscription_count: 0,
		});
		let releaseOldCount!: (value: never) => void;
		vi.mocked(http.get).mockImplementation(async (url: unknown) => {
			if (url === `/guilds/${GUILD_ID}`)
				return await new Promise<never>((resolve) => {
					releaseOldCount = resolve;
				});
			return {body: []} as never;
		});
		const oldOpen = GuildBoosts.open(GUILD_ID);
		respond([], [], {premium_tier: 0, premium_subscription_count: 1});
		await GuildBoosts.open(GUILD_ID);
		releaseOldCount({body: {id: GUILD_ID, premium_tier: 0, premium_subscription_count: 0}} as never);
		await oldOpen;
		expect(GuildBoosts.status?.count).toBe(1);
		expect((guildState.guilds[GUILD_ID] as InstanceType<typeof Guild>).premiumSubscriptionCount).toBe(1);
	});
});
