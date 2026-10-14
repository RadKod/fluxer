// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	getProfileAvatarDecorationBounds,
	getProfileAvatarLeft,
} from '@app/features/user/constants/UserProfileSurfaceGeometry';
import type {User} from '@app/features/user/models/User';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const ultra = vi.hoisted(() => ({
	front: null as unknown,
	layout: null as null | {profile: {width: number; height: number; offset_x: number; offset_y: number}},
}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {frontFor: () => ultra.front, layoutFor: () => ultra.layout},
}));

const user = (decoration = false, hasUltra = false) =>
	({avatarDecoration: decoration ? {} : null, avatarUltra: hasUltra ? {item_id: '7'} : null}) as User;

describe('profile decoration clearance', () => {
	beforeEach(() => {
		ultra.front = null;
		ultra.layout = null;
	});

	it('keeps the avatar border and a normal frame in the reserved bounds', () => {
		expect(getProfileAvatarDecorationBounds(user(), 100, 4)).toEqual({left: -4, top: -4, right: 104, bottom: 104});
		const frame = getProfileAvatarDecorationBounds(user(true), 100, 4);
		expect(frame.left).toBeCloseTo(-10);
		expect(frame.bottom).toBeCloseTo(110);
	});

	it('reserves the entire default profile ultra canvas', () => {
		const bounds = getProfileAvatarDecorationBounds(user(false, true), 100, 4);
		expect(bounds.right - bounds.left).toBeCloseTo(346.847073631);
		expect(bounds.bottom - bounds.top).toBeCloseTo(346.847073631);
	});

	it('includes offset custom underlays and the fixed front canvas together', () => {
		ultra.front = {};
		ultra.layout = {profile: {width: 2, height: 4, offset_x: 1, offset_y: -0.5}};
		const bounds = getProfileAvatarDecorationBounds(user(true, true), 100, 4);
		expect(bounds.left).toBeCloseTo(-123.4);
		expect(bounds.top).toBeCloseTo(-204.027690371);
		expect(bounds.right).toBeCloseTo(252.013845185);
		expect(bounds.bottom).toBeCloseTo(223.4);
	});

	it('keeps custom underlay clearance after the front falls back', () => {
		ultra.layout = {profile: {width: 2, height: 4, offset_x: 1, offset_y: -0.5}};
		const bounds = getProfileAvatarDecorationBounds(user(false, true), 100, 4);
		expect(bounds.left).toBe(-4);
		expect(bounds.top).toBeCloseTo(-204.027690371);
		expect(bounds.right).toBeCloseTo(252.013845185);
		expect(bounds.bottom).toBeCloseTo(204.027690371);
	});

	it.each([
		{containerWidth: 300, size: 80, border: 3.2, edgePadding: 10},
		{containerWidth: 600, size: 120, border: 4.8, edgePadding: 16},
	])('keeps the avatar clickable inside a $containerWidth px card with extreme custom offsets', (geometry) => {
		ultra.layout = {profile: {width: 3.4, height: 3.4, offset_x: -3, offset_y: 0}};
		const bounds = getProfileAvatarDecorationBounds(user(false, true), geometry.size, geometry.border);
		const left = getProfileAvatarLeft({decorationLeft: bounds.left, ...geometry});
		expect(left).toBeGreaterThanOrEqual(geometry.edgePadding);
		expect(left + geometry.size + 2 * geometry.border).toBeCloseTo(geometry.containerWidth - geometry.edgePadding);
		expect(bounds.right - bounds.left).toBeGreaterThan(geometry.containerWidth);
	});

	it('keeps the original default ultra placement when its button fits inside the card', () => {
		const bounds = getProfileAvatarDecorationBounds(user(false, true), 80, 3.2);
		expect(
			getProfileAvatarLeft({decorationLeft: bounds.left, size: 80, border: 3.2, edgePadding: 10, containerWidth: 300}),
		).toBeCloseTo(105.538829452);
	});
});
