// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {IntegrationRateLimitConfigs} from '@app/api/rate_limit_configs/IntegrationRateLimitConfig';
import {ms} from 'itty-time';

// Bucket names must not contain ":<route param>": RateLimitMiddleware substitutes route params into them, so a
// "shop:code:get" bucket on /shop/codes/:code would become one bucket per guessed code.
export const ShopRateLimitConfigs = {
	SHOP_CATALOG: {
		bucket: 'shop:catalog',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	SHOP_QUOTE: {
		bucket: 'shop:quote',
		config: {limit: 60, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	SHOP_ORDER_CREATE: {
		bucket: 'shop:order:create',
		config: {limit: 3, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	SHOP_ORDER_CREATE_DAY: {
		bucket: 'shop:order:create:day',
		config: {limit: 20, windowMs: ms('1 day')},
	} as RouteRateLimitConfig,
	SHOP_ORDER_GET: {
		bucket: 'shop:order:get',
		config: {limit: 60, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	SHOP_CODE_GET: {
		bucket: 'shop:gift:get',
		config: IntegrationRateLimitConfigs.GIFT_CODE_GET.config,
	} as RouteRateLimitConfig,
	// Payriff's servers and returning browsers carry no session, so this counts per IP.
	PAYRIFF_CALLBACK: {
		bucket: 'payriff:callback',
		config: {limit: 600, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	ADMIN_SHOP_VIEW: {
		bucket: 'admin:shop:view',
		config: {limit: 60, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	ADMIN_SHOP_MANAGE: {
		bucket: 'admin:shop:manage',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
} as const;
