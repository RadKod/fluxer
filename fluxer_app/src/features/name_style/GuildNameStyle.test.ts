// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/features/user/models/User';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const ROLES = {everyone: {color: 0}, mod: {color: 0xe74c3c}};
const getGuild = vi.fn(() => ({roles: ROLES}));

vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild}}));

const {guildNameStyleProps} = await import('@app/features/name_style/GuildNameStyle');
const {resolveNameStyleView} = await import('@app/features/name_style/NameStyle');

const STYLE: NameStyle = {font_id: 6, colors: [0xffffff]};
const styled = (nameStyle: NameStyle | null) => ({id: '7', nameStyle}) as unknown as User;

describe('guildNameStyleProps', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("draws the whole style, checked against the guild's roles", () => {
		const props = guildNameStyleProps(styled(STYLE), 'g1');
		expect(props).toEqual({nameStyle: STYLE, guildRoles: ROLES});
		expect(props).not.toHaveProperty('fontOnly');
		expect(resolveNameStyleView(props.nameStyle, props)).toMatchObject({fontKey: expect.any(String), solid: '#ffffff'});
	});

	it("drops the colours where they could pass for one of the guild's coloured roles", () => {
		const near: NameStyle = {font_id: 6, colors: [0xe8503f]};
		const props = guildNameStyleProps(styled(near), 'g1');
		expect(resolveNameStyleView(props.nameStyle, props)).toMatchObject({solid: null, gradient: null});
	});

	it('reads no store for a name without a style', () => {
		expect(guildNameStyleProps(styled(null), 'g1')).toEqual({nameStyle: null, guildRoles: undefined});
		expect(getGuild).not.toHaveBeenCalled();
	});
});
