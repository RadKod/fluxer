// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {decideProfileView, type ProfileBond} from '@app/api/user/profile/ProfileAccessRules';
import type {ProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import {profileViewer} from '@app/api/user/profile/ProfileViewer';
import type {Context} from 'hono';
import {describe, expect, it} from 'vitest';

const L = 'limited';
// [bond, everyone, guilds, close, only_me] for a viewer whose stranger standing holds.
// Mutual follows are close; a weak bond opens nothing more than a stranger's view.
const WITH_STANDING: Array<[ProfileBond, ...Array<string | null>]> = [
	['close', 'full', 'full', 'full', L],
	['guild', 'full', 'full', L, L],
	['weak', 'public', L, L, L],
	['none', 'public', null, null, null],
];
const WITHOUT_STANDING: Array<[ProfileBond, ...Array<string | null>]> = [
	['close', 'full', 'full', 'full', L],
	['guild', 'full', 'full', L, L],
	['weak', L, L, L, L],
	['none', null, null, null, null],
];
const AUDIENCES: Array<ProfileAudience> = ['everyone', 'guilds', 'close', 'only_me'];
const rows = (table: typeof WITH_STANDING) =>
	table.flatMap(([bond, ...views]) => AUDIENCES.map((audience, i) => [audience, bond, views[i]] as const));

describe('the profile access table (Kapı 2 Tablo 1)', () => {
	it.each(rows(WITH_STANDING))('%s / %s → %s with standing', (audience, bond, view) => {
		expect(decideProfileView({audience, bond, blocked: false, bot: false, strangerOk: true})).toBe(view);
	});
	it.each(rows(WITHOUT_STANDING))('%s / %s → %s without standing', (audience, bond, view) => {
		expect(decideProfileView({audience, bond, blocked: false, bot: false, strangerOk: false})).toBe(view);
	});
	it.each(AUDIENCES)(
		'a block either way leaves a bonded viewer the limited profile and a stranger nothing (%s)',
		(audience) => {
			expect(decideProfileView({audience, bond: 'guild', blocked: true, bot: false, strangerOk: true})).toBe(L);
			expect(decideProfileView({audience, bond: 'none', blocked: true, bot: false, strangerOk: true})).toBeNull();
		},
	);
	it('keeps bot profiles open as today (R-G)', () => {
		expect(decideProfileView({audience: 'only_me', bond: 'none', blocked: false, bot: true, strangerOk: false})).toBe(
			'full',
		);
	});
});

describe('the profile viewer (Kapı 2 Ş3, Ş10)', () => {
	const contextOf = (authTokenType: string, isBot = false) => {
		const values: Record<string, unknown> = {user: {isBot} as User, authTokenType};
		return {get: (key: string) => values[key]} as unknown as Context<HonoEnv>;
	};
	it('takes only a session of a non-bot account as a human who may be a stranger', () => {
		expect(profileViewer(contextOf('session')).human).toBe(true);
		expect(profileViewer(contextOf('session', true)).human).toBe(false);
		for (const type of ['bearer', 'bot', 'admin_api_key']) expect(profileViewer(contextOf(type)).human).toBe(false);
	});
	it('spends the stranger budget only when the route asks', () => {
		expect(profileViewer(contextOf('session')).countStranger).toBe(false);
		expect(profileViewer(contextOf('session'), {countStranger: true}).countStranger).toBe(true);
	});
});
