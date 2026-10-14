// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	CosmeticItemCreateRequest,
	CosmeticItemIdsQuery,
	CosmeticItemUpdateRequest,
	EquipCosmeticsRequest,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticRequestSchemas';
import {
	CosmeticItemResponse,
	CosmeticItemType,
	EquippedCosmeticsResponse,
	UltraLayoutSurface,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {base64LengthForBytes} from '@fluxer/schema/src/primitives/FileValidators';
import {describe, expect, it} from 'vitest';

// The largest per-type limit (ultra decorations); EntityAssetService holds every type to its own limit.
const OUTER_CAP_BYTES = 1_228_800;
const base64Of = (bytes: number) => 'A'.repeat(4 * Math.ceil(bytes / 3));
const item = (asset: string) => ({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'premium', asset});

describe('cosmetic schemas', () => {
	it('knows ultra decorations as a fourth cosmetic type', () => {
		expect(CosmeticItemType.safeParse('avatar_ultra').success).toBe(true);
	});

	it('wears and reports an ultra decoration in its own slot next to the frame', () => {
		expect(EquipCosmeticsRequest.parse({avatar_ultra_id: '1300000000000000009'})).toHaveProperty('avatar_ultra_id');
		expect(
			EquippedCosmeticsResponse.parse({
				avatar_decoration_id: '1',
				avatar_ultra_id: '2',
				profile_effect_id: null,
				nameplate_id: null,
			}).avatar_ultra_id,
		).toBe('2');
	});

	it('carries the worn ultra decoration on the partial user', () => {
		const partial = UserPartialResponse.parse({
			id: '1',
			username: 'kanat',
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
			avatar_ultra_data: {asset: 'a_7c8d9e0f', item_id: '3003'},
		});
		expect(partial.avatar_ultra_data).toEqual({asset: 'a_7c8d9e0f', item_id: '3003'});
	});

	it('lets an image through up to the 1,638,400-character outer cap and no further', () => {
		expect(base64Of(OUTER_CAP_BYTES)).toHaveLength(1_638_400);
		expect(CosmeticItemCreateRequest.safeParse(item(base64Of(OUTER_CAP_BYTES))).success).toBe(true);
		expect(CosmeticItemCreateRequest.safeParse(item(base64Of(OUTER_CAP_BYTES + 3))).success).toBe(false);
	});

	it('holds ultra layout sizes to 0.5–6 and offsets to −3–3 avatar diameters', () => {
		const surface = {width: 2.3, height: 3.2, offset_x: 0, offset_y: -0.1};
		expect(UltraLayoutSurface.safeParse(surface).success).toBe(true);
		expect(UltraLayoutSurface.safeParse({...surface, width: 0.5, height: 6, offset_x: -3, offset_y: 3}).success).toBe(
			true,
		);
		expect(UltraLayoutSurface.safeParse({...surface, width: 0.49}).success).toBe(false);
		expect(UltraLayoutSurface.safeParse({...surface, height: 6.01}).success).toBe(false);
		expect(UltraLayoutSurface.safeParse({...surface, offset_x: -3.01}).success).toBe(false);
		expect(UltraLayoutSurface.safeParse({...surface, offset_y: 3.01}).success).toBe(false);
	});

	it('reads at most 50 item IDs at once, each inside int64', () => {
		const ids = Array.from({length: 51}, (_, i) => String(1490000000000000001n + BigInt(i)));
		expect(CosmeticItemIdsQuery.safeParse({ids: ids.slice(0, 50).join(',')}).success).toBe(true);
		expect(CosmeticItemIdsQuery.safeParse({ids: ids.join(',')}).success).toBe(false);
		expect(CosmeticItemIdsQuery.safeParse({ids: '9223372036854775807'}).success).toBe(true);
		expect(CosmeticItemIdsQuery.safeParse({ids: '1,9223372036854775808'}).success).toBe(false);
		for (const ids of ['', '0', 'abc', '1,,2', '1,']) {
			expect(CosmeticItemIdsQuery.safeParse({ids}).success).toBe(false);
		}
	});

	it('clears an ultra layout back to the fixed sizes with null', () => {
		expect(CosmeticItemUpdateRequest.parse({ultra_layout: null})).toEqual({ultra_layout: null});
	});

	it('takes an in-front set of 2 to 30 opening frames, or null', () => {
		const frame = 'AAAA';
		expect(
			CosmeticItemUpdateRequest.parse({ultra_front: {closed: frame, open: [frame, frame], idle: frame}}).ultra_front
				?.open,
		).toHaveLength(2);
		expect(CosmeticItemUpdateRequest.parse({ultra_front: null})).toEqual({ultra_front: null});
		expect(() => CosmeticItemUpdateRequest.parse({ultra_front: {closed: frame, open: [frame], idle: frame}})).toThrow();
		expect(() =>
			CosmeticItemUpdateRequest.parse({ultra_front: {closed: frame, open: Array(31).fill(frame), idle: frame}}),
		).toThrow();
	});

	it('refuses an opening frame above 64 KB before it reaches the service', () => {
		const big = 'A'.repeat(base64LengthForBytes(65_536) + 4);
		expect(() =>
			CosmeticItemUpdateRequest.parse({ultra_front: {closed: 'AAAA', open: [big, 'AAAA'], idle: 'AAAA'}}),
		).toThrow();
	});

	it('puts an item back on sale only with true', () => {
		expect(CosmeticItemUpdateRequest.parse({on_sale: true})).toEqual({on_sale: true});
		expect(() => CosmeticItemUpdateRequest.parse({on_sale: false})).toThrow();
	});

	it('answers ultra_front as optional and nullable', () => {
		const response = {id: '1', type: 'avatar_ultra', name: 'x', description: null, asset: 'h', availability: 'owned'};
		expect(CosmeticItemResponse.parse(response).ultra_front).toBeUndefined();
		expect(CosmeticItemResponse.parse({...response, ultra_front: null}).ultra_front).toBeNull();
		const front = {closed: 'c', open: ['c', 'o1'], idle: 'a_i'};
		expect(CosmeticItemResponse.parse({...response, ultra_front: front}).ultra_front).toEqual(front);
	});
});
