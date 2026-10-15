// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGuildID, type UserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {LimitConfigService, resetGlobalLimitConfigServiceForTesting} from '@app/api/limits/LimitConfigService';
import {GuildMember} from '@app/api/models/GuildMember';
import {User} from '@app/api/models/User';
import {
	hasPartialUserFieldsChanged,
	mapGuildMemberToProfileResponse,
	mapUserToPartialResponse,
	mapUserToPrivateResponse,
	mapUserToProfileResponse,
} from '@app/api/user/UserMappers';
import {UserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {NameStyle, ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {KVCacheProvider} from '@pkgs/cache/src/providers/KVCacheProvider';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

// The same vectors drive the Rust users service (to_api_partial), so a read rule only one side changes fails somewhere.
const VECTORS_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../fluxer_common/src/testdata/plus_appearance_vectors.json',
);

interface PlusAppearanceVector {
	name: string;
	row: {
		flags: number;
		bot: boolean;
		premium_type: number | null;
		premium_flags: number | null;
		name_font: number | null;
		name_color: number | null;
		name_color_2: number | null;
		theme_primary_color: number | null;
		theme_accent_color: number | null;
	};
	name_style: NameStyle | null;
	theme_colors: ThemeColors | null;
}

function readVectors(): Array<PlusAppearanceVector> {
	const parsed: unknown = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(`no Plus appearance vectors in ${VECTORS_PATH}`);
	}
	return parsed as Array<PlusAppearanceVector>;
}

function user(overrides: Partial<UserRow> = {}): User {
	return new User({
		...EMPTY_USER_ROW,
		user_id: 1174109840998400001n as UserID,
		username: 'ada',
		discriminator: 7,
		flags: 0n,
		...overrides,
	});
}

function userFromRow(row: PlusAppearanceVector['row']): User {
	return user({...row, flags: BigInt(row.flags)});
}

const STYLED: Partial<UserRow> = {
	premium_type: UserPremiumTypes.SUBSCRIPTION,
	name_font: 6,
	name_color: 0xffffff,
	name_color_2: 0x7b5cff,
	theme_primary_color: 0x1e1b4b,
	theme_accent_color: 0x07a3b2,
};

const vectors = readVectors();

describe('Plus appearance read rule', () => {
	beforeAll(() => {
		new LimitConfigService(
			new InstanceConfigRepository(),
			new KVCacheProvider({client: new MockKVProvider()}),
		).setAsGlobalInstance();
	});

	afterAll(() => {
		resetGlobalLimitConfigServiceForTesting();
	});

	it.each(vectors.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
		const subject = userFromRow(vector.row);
		const partial = mapUserToPartialResponse(subject);
		expect(partial).toHaveProperty('name_style', vector.name_style);
		expect(partial).not.toHaveProperty('theme_colors');
		const own = mapUserToPrivateResponse(subject);
		expect(own).toHaveProperty('name_style', vector.name_style);
		expect(own).toHaveProperty('theme_colors', vector.theme_colors);
		expect(mapUserToProfileResponse(subject)).toHaveProperty('theme_colors', vector.theme_colors);
		expect(mapUserToProfileResponse(subject, {restrictProfile: true})).toHaveProperty(
			'theme_colors',
			vector.theme_colors,
		);
	});

	it('sends a null name style and no theme for a hidden profile, and keeps both for the owner', () => {
		const hidden = user({...STYLED, flags: UserFlags.PROFILE_HIDDEN});
		expect(mapUserToPartialResponse(hidden)).toHaveProperty('name_style', null);
		expect(mapUserToProfileResponse(hidden)).toHaveProperty('theme_colors', null);
		const own = mapUserToPrivateResponse(hidden);
		expect(own.name_style).toEqual({font_id: 6, colors: [0xffffff, 0x7b5cff]});
		expect(own.theme_colors).toEqual([0x1e1b4b, 0x07a3b2]);
	});

	it('sends a null name style for a deleted account', () => {
		const deleted = user({...STYLED, flags: UserFlags.DELETED});
		expect(mapUserToPartialResponse(deleted)).toHaveProperty('name_style', null);
		expect(mapUserToPrivateResponse(deleted)).toHaveProperty('name_style', null);
	});

	it('counts a name style change as a partial user change and a theme change as none', () => {
		const styled = user(STYLED);
		expect(hasPartialUserFieldsChanged(styled, user({...STYLED, name_font: 7}))).toBe(true);
		expect(hasPartialUserFieldsChanged(styled, user({...STYLED, name_color: 0xfafafa}))).toBe(true);
		expect(hasPartialUserFieldsChanged(styled, user({...STYLED, name_color_2: null}))).toBe(true);
		expect(hasPartialUserFieldsChanged(styled, user({...STYLED, name_font: null}))).toBe(true);
		expect(hasPartialUserFieldsChanged(user({...STYLED, name_font: null}), styled)).toBe(true);
		expect(hasPartialUserFieldsChanged(styled, user({...STYLED, premium_type: null}))).toBe(true);
		expect(hasPartialUserFieldsChanged(styled, user(STYLED))).toBe(false);
		expect(hasPartialUserFieldsChanged(styled, user({...STYLED, theme_primary_color: 0}))).toBe(false);
		expect(hasPartialUserFieldsChanged(user({name_font: 3, name_color: 1}), user({name_font: 4, name_color: 2}))).toBe(
			false,
		);
	});

	it('keeps the theme out of the guild member profile', () => {
		const member = new GuildMember({
			guild_id: createGuildID(5n),
			user_id: 1174109840998400001n as UserID,
			joined_at: new Date(),
			nick: null,
			avatar_hash: null,
			banner_hash: null,
			bio: 'member bio',
			pronouns: null,
			accent_color: 12,
			join_source_type: null,
			source_invite_code: null,
			inviter_id: null,
			deaf: false,
			mute: false,
			communication_disabled_until: null,
			role_ids: null,
			is_premium_sanitized: false,
			temporary: false,
			profile_flags: null,
			version: 1,
		});
		for (const options of [undefined, {restrictProfile: true}, {hidden: true}]) {
			expect(mapGuildMemberToProfileResponse(member, options)).not.toHaveProperty('theme_colors');
		}
	});
});
