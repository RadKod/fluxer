// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	GatewayRolloutConfigSchema,
	GatewayRolloutConfigUpdateRequest,
} from '@fluxer/schema/src/domains/admin/GatewayRolloutSchemas';
import {describe, expect, test} from 'vitest';

describe('gateway rollout schemas', () => {
	test('legacy_config_is_disabled', () => {
		expect(GatewayRolloutConfigSchema.parse({})).toMatchObject({game_activity_enabled: false, game_activity_epoch: 0});
	});
	test('epoch_is_server_owned_and_increments_on_transition', () => {
		expect(GatewayRolloutConfigUpdateRequest.safeParse({game_activity_epoch: 100}).success).toBe(false);
		expect(GatewayRolloutConfigUpdateRequest.parse({game_activity_enabled: true})).toEqual({
			game_activity_enabled: true,
		});
	});
	test('epoch_rejects_negative_fractional_and_unsafe_values', () => {
		for (const game_activity_epoch of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			expect(GatewayRolloutConfigSchema.safeParse({game_activity_epoch}).success).toBe(false);
		}
	});
	test('full config applies defaults for omitted values', () => {
		expect(GatewayRolloutConfigSchema.parse({})).toMatchObject({
			session_rollout_percentage: 100,
			session_rollout_mode: 'modulo',
			rpc_request_timeout_ms: 10000,
			gateway_dispatch_relay_shards: 32,
			gateway_dispatch_relay_max_queue: 50000,
			voice_e2ee_scope: 'guild_feature_only',
		});
	});
	test('update request remains partial and does not inject defaults', () => {
		expect(
			GatewayRolloutConfigUpdateRequest.parse({
				rpc_request_timeout_ms: 5000,
				gateway_dispatch_relay_shards: 16,
			}),
		).toEqual({
			rpc_request_timeout_ms: 5000,
			gateway_dispatch_relay_shards: 16,
		});
	});
	test('patch accepts connection capacity with game activity while rejecting server-owned and unknown fields', () => {
		const patch = {max_connections: 18000, game_activity_enabled: true};
		expect(GatewayRolloutConfigUpdateRequest.parse(patch)).toEqual(patch);
		expect(GatewayRolloutConfigUpdateRequest.safeParse({...patch, game_activity_epoch: 1}).success).toBe(false);
		expect(GatewayRolloutConfigUpdateRequest.safeParse({...patch, unsupported: true}).success).toBe(false);
	});
	test('voice e2ee scope accepts only known modes', () => {
		expect(GatewayRolloutConfigUpdateRequest.parse({voice_e2ee_scope: 'platform_wide'})).toEqual({
			voice_e2ee_scope: 'platform_wide',
		});
		expect(() => GatewayRolloutConfigUpdateRequest.parse({voice_e2ee_scope: 'guilds'})).toThrow();
	});
	test('connection cap defaults to env without adding a default to patches', () => {
		expect(GatewayRolloutConfigSchema.parse({}).max_connections).toBe(0);
		expect(GatewayRolloutConfigUpdateRequest.parse({})).toEqual({});
	});
	test.each([0, 1, 200000])('connection cap accepts %s in full configs and patches', (value) => {
		expect(GatewayRolloutConfigSchema.parse({max_connections: value}).max_connections).toBe(value);
		expect(GatewayRolloutConfigUpdateRequest.parse({max_connections: value})).toEqual({max_connections: value});
	});
	test.each([-1, 200001, 1.5, '18000', null, Number.NaN, Number.POSITIVE_INFINITY])(
		'connection cap rejects %s in full configs and patches',
		(value) => {
			expect(() => GatewayRolloutConfigSchema.parse({max_connections: value})).toThrow();
			expect(() => GatewayRolloutConfigUpdateRequest.parse({max_connections: value})).toThrow();
		},
	);
});
