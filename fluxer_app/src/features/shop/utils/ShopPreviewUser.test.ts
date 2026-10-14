// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {UserPrivate} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => -1}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));

const {User} = await import('@app/features/user/models/User');
const {previewEffectFor, previewUserFor, previewUserForSurface} = await import(
	'@app/features/shop/utils/ShopPreviewUser'
);

function item(id: string, type: CosmeticItemResponse['type']): CosmeticItemResponse {
	return {id, type, name: `item ${id}`, description: null, asset: `hash${id}`, availability: 'owned'};
}

const WORN_FRAME = {asset: 'frame', item_id: '1'};
const WORN_ULTRA = {asset: 'wings', item_id: '2'};
const WORN_PLATE = {asset: 'plate', item_id: '3'};

const user = new User({
	id: '100',
	username: 'ayse',
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
	avatar_decoration_data: WORN_FRAME,
	avatar_ultra_data: WORN_ULTRA,
	nameplate_data: WORN_PLATE,
} as UserPrivate);

describe('ShopPreviewUser', () => {
	it('does not forward unknown cosmetic types to a preview surface', () => {
		const preview = previewUserForSurface(user, 'chat', [
			item('99', 'future_cosmetic' as CosmeticItemResponse['type']),
		]);
		expect([preview.avatarDecoration, preview.avatarUltra, preview.nameplate]).toEqual([null, null, null]);
	});
	it('keeps nameplates exclusively on member rows and avatar decorations on supported surfaces', () => {
		const items = [item('21', 'avatar_ultra'), item('22', 'avatar_decoration'), item('23', 'nameplate')];
		for (const surface of ['profile', 'chat'] as const) {
			const preview = previewUserForSurface(user, surface, items);
			expect(preview.nameplate).toBeNull();
			expect(preview.avatarUltra?.item_id).toBe('21');
			expect(preview.avatarDecoration?.item_id).toBe('22');
		}
		expect(previewUserForSurface(user, 'member_list', items).nameplate?.item_id).toBe('23');
		expect(previewUserForSurface(user, 'chat', [item('23', 'nameplate')]).nameplate).toBeNull();
		expect(user.nameplate).toEqual(WORN_PLATE);
	});
	// A shop preview shows the item alone: nothing the user wears mixes in, the ultra wings least of all.
	it('wears only the item: every worn slot starts empty', () => {
		const ultra = previewUserFor(user, item('21', 'avatar_ultra'));
		expect([ultra.avatarDecoration, ultra.avatarUltra, ultra.nameplate]).toEqual([
			null,
			{asset: 'hash21', item_id: '21'},
			null,
		]);

		const frame = previewUserFor(user, item('22', 'avatar_decoration'));
		expect([frame.avatarDecoration, frame.avatarUltra, frame.nameplate]).toEqual([
			{asset: 'hash22', item_id: '22'},
			null,
			null,
		]);

		const plate = previewUserFor(user, item('23', 'nameplate'));
		expect([plate.avatarDecoration, plate.avatarUltra, plate.nameplate]).toEqual([
			null,
			null,
			{asset: 'hash23', item_id: '23'},
		]);

		expect(user.avatarUltra).toEqual(WORN_ULTRA);
		expect(previewEffectFor(item('21', 'avatar_ultra'))).toBeNull();
	});

	it('wears several items at once, one a slot', () => {
		const set = previewUserFor(
			user,
			item('22', 'avatar_decoration'),
			item('24', 'profile_effect'),
			item('23', 'nameplate'),
		);
		expect([set.avatarDecoration, set.avatarUltra, set.nameplate]).toEqual([
			{asset: 'hash22', item_id: '22'},
			null,
			{asset: 'hash23', item_id: '23'},
		]);
	});

	it('a profile effect goes to the effect, not the user', () => {
		const effect = item('24', 'profile_effect');
		const bare = previewUserFor(user, effect);
		expect([bare.avatarDecoration, bare.avatarUltra, bare.nameplate]).toEqual([null, null, null]);
		expect(previewEffectFor(effect)).toEqual({asset: 'hash24', item_id: '24'});
	});
});
