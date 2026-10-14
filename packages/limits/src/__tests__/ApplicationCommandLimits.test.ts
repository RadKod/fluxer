// SPDX-License-Identifier: AGPL-3.0-or-later

import {LIMIT_KEY_METADATA, LIMIT_KEY_SCOPES, LIMIT_KEYS} from '@fluxer/constants/src/LimitConfigMetadata';
import {DEFAULT_FREE_LIMITS, DEFAULT_PREMIUM_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import {resolveLimits} from '@fluxer/limits/src/LimitResolver';
import {describe, expect, test} from 'vitest';

describe('application command feature limit', () => {
	test('registers a user scope toggle', () => {
		expect(LIMIT_KEYS).toContain('feature_app_commands');
		expect(LIMIT_KEY_SCOPES.feature_app_commands).toBe('user');
		expect(LIMIT_KEY_METADATA.feature_app_commands).toMatchObject({
			key: 'feature_app_commands',
			category: 'features',
			scope: 'user',
			isToggle: true,
		});
	});

	test('keeps free and premium defaults disabled', () => {
		expect(DEFAULT_FREE_LIMITS.feature_app_commands).toBe(0);
		expect(DEFAULT_PREMIUM_LIMITS.feature_app_commands).toBe(0);
	});

	test.each([{traits: []}, {traits: ['premium']}, {traits: ['cohort']}])(
		'does not enable commands for traits $traits without an override',
		({traits}) => {
			const result = resolveLimits(
				{traitDefinitions: ['premium', 'cohort'], rules: []},
				{
					traits: new Set(traits),
					guildFeatures: new Set(),
				},
			);
			expect(result.limits.feature_app_commands).toBe(0);
		},
	);

	test('allows an explicit user cohort override', () => {
		const snapshot = {
			traitDefinitions: ['app_commands_pilot'],
			rules: [{id: 'pilot', filters: {traits: ['app_commands_pilot']}, limits: {feature_app_commands: 1}}],
		};
		const ctx = {traits: new Set(['app_commands_pilot']), guildFeatures: new Set<string>()};
		expect(resolveLimits(snapshot, ctx).limits.feature_app_commands).toBe(1);
		expect(resolveLimits(snapshot, {...ctx, traits: new Set<string>()}).limits.feature_app_commands).toBe(0);
	});
});
