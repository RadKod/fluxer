// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const CosmeticRateLimitConfigs = {
	COSMETIC_CATALOG: {
		bucket: 'cosmetics:catalog',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	COSMETIC_ITEMS: {
		bucket: 'cosmetics:items',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	COSMETIC_LIST_OWN: {
		bucket: 'cosmetics:list_own',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	// Every change reaches each guild the account is in as GUILD_MEMBER_UPDATE, so wearing is kept rare.
	COSMETIC_EQUIP: {
		bucket: 'cosmetics:equip',
		config: {limit: 5, windowMs: ms('10 minutes')},
	} as RouteRateLimitConfig,
	ADMIN_COSMETIC_LIST: {
		bucket: 'admin:cosmetics:list',
		config: {limit: 60, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	ADMIN_COSMETIC_MANAGE: {
		bucket: 'admin:cosmetics:manage',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
} as const;
