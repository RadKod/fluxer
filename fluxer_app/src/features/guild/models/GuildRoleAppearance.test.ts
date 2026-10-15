// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildRole as WireGuildRole} from '@fluxer/schema/src/domains/guild/GuildRoleSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({noteText: () => {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: () => ({id: '1'})}}));
vi.mock('@app/features/user/models/User', () => ({User: class {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: vi.fn()}}));

const {GuildRole} = await import('@app/features/guild/models/GuildRole');
const {GuildMember} = await import('@app/features/member/models/GuildMember');
const {default: Guilds} = await import('@app/features/guild/state/Guilds');

function role(extra: Partial<WireGuildRole> = {}) {
	return new GuildRole('10', {
		id: '20',
		name: 'Role',
		color: 0x112233,
		position: 1,
		permissions: '0',
		hoist: false,
		mentionable: false,
		...extra,
	});
}

function member(roles: Array<InstanceType<typeof GuildRole>>) {
	vi.mocked(Guilds.getGuild).mockReturnValue({roles: Object.fromEntries(roles.map((r) => [r.id, r]))} as never);
	return new GuildMember('10', {
		user: {id: '1'} as never,
		roles: roles.filter((r) => r.id !== '10').map((r) => r.id),
		joined_at: '2026-01-01T00:00:00.000Z',
	});
}

describe('Guild role appearance data', () => {
	it('defaults omitted appearance to null', () => {
		expect(role()).toMatchObject({colorSecondary: null, iconEmojiId: null, unicodeEmoji: null});
	});

	it('roundtrips appearance through unrelated updates and JSON', () => {
		const original = role({color_secondary: 0, icon_emoji_id: '30', unicode_emoji: null});
		const updated = original.withUpdates({name: 'Renamed'});
		expect(updated).toMatchObject({colorSecondary: 0, iconEmojiId: '30', unicodeEmoji: null});
		expect(updated.toJSON()).toMatchObject({color_secondary: 0, icon_emoji_id: '30', unicode_emoji: null});
		expect(new GuildRole('10', updated.toJSON()).toJSON()).toEqual(updated.toJSON());
	});

	it.each([{color_secondary: 0x445566}, {icon_emoji_id: '30'}, {unicode_emoji: '🎉'}])(
		'detects changed appearance %j',
		(appearance) => {
			expect(role().toJSON()).not.toEqual(role(appearance).toJSON());
		},
	);

	it('preserves undefined and clears explicit null for every appearance field', () => {
		const original = role({color_secondary: 0x445566, icon_emoji_id: '30', unicode_emoji: '🎉'});
		expect(
			original.withUpdates({color_secondary: undefined, icon_emoji_id: undefined, unicode_emoji: undefined}).toJSON(),
		).toEqual(original.toJSON());
		expect(
			original.withUpdates({color_secondary: null, icon_emoji_id: null, unicode_emoji: null}).toJSON(),
		).toMatchObject({
			color_secondary: null,
			icon_emoji_id: null,
			unicode_emoji: null,
		});
	});
});

describe('Guild member appearance role selection', () => {
	beforeEach(() => vi.mocked(Guilds.getGuild).mockReset());

	it('takes both colors from the highest colored role and chooses icons independently', () => {
		const highest = role({id: '40', position: 3, color: 0, unicode_emoji: '🎉'});
		const colored = role({id: '30', position: 2, color_secondary: null});
		const lower = role({id: '20', position: 1, color_secondary: 0xff0000, icon_emoji_id: '50'});
		const record = member([lower, highest, colored]);
		expect(record.getColorRole()).toBe(colored);
		expect(record.getColorRole()?.colorSecondary).toBeNull();
		expect(record.getIconRole()).toBe(highest);
		expect(record.getColorString()).toBe('rgb(17, 34, 51)');
	});

	it('uses the existing snowflake tie break', () => {
		const older = role({id: '20', position: 2, icon_emoji_id: '50'});
		const newer = role({id: '30', position: 2, unicode_emoji: '🎉'});
		const record = member([newer, older]);
		expect(record.getColorRole()).toBe(older);
		expect(record.getIconRole()).toBe(older);
	});

	it('falls back to everyone and reads current role state after updates', () => {
		const everyone = role({id: '10', position: 0, color_secondary: 0, unicode_emoji: '🎉'});
		const record = member([everyone, role({color: 0})]);
		expect(record.getColorRole()).toBe(everyone);
		expect(record.getIconRole()).toBe(everyone);
		vi.mocked(Guilds.getGuild).mockReturnValue(undefined);
		expect(record.getColorRole()).toBeUndefined();
		expect(record.getIconRole()).toBeUndefined();
		expect(record.getColorString()).toBeUndefined();
	});
});
