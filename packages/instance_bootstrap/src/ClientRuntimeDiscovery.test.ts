// SPDX-License-Identifier: AGPL-3.0-or-later

import {DEPLOYED_OFFICIAL_DOCUMENT} from '@fluxer/instance_bootstrap/src/__tests__/DiscoveryFixtures';
import {projectClientRuntimeDiscovery} from '@fluxer/instance_bootstrap/src/ClientRuntimeDiscovery';
import {parseInstanceDiscoveryDocument} from '@fluxer/instance_bootstrap/src/Discovery';
import {describe, expect, it} from 'vitest';

function project(features: Record<string, unknown> = {}, appPublic: Record<string, unknown> = {}) {
	return projectClientRuntimeDiscovery(
		parseInstanceDiscoveryDocument({
			...DEPLOYED_OFFICIAL_DOCUMENT,
			features: {...DEPLOYED_OFFICIAL_DOCUMENT.features, ...features},
			app_public: {...DEPLOYED_OFFICIAL_DOCUMENT.app_public, ...appPublic},
		}),
	);
}

describe('client discovery sanalyer contract', () => {
	it('preserves migration deadlines and tiers through the canonical document and runtime projection', () => {
		const username_migration = {
			state: 'selecting' as const,
			epoch: 2,
			preparing_at: '2026-10-01T00:00:00Z',
			started_at: '2026-10-01T00:01:00Z',
			forced_at: '2026-10-08T00:01:00Z',
		};
		const username_tiers = {'1': 'locked' as const, '2': 'for_sale' as const, '3': 'public' as const};
		const document = parseInstanceDiscoveryDocument({
			...DEPLOYED_OFFICIAL_DOCUMENT,
			username_migration,
			username_tiers,
		});
		expect(document.usernameMigration).toEqual(username_migration);
		expect(document.usernameTiers).toEqual(username_tiers);
		const runtime = projectClientRuntimeDiscovery(document);
		expect(runtime.usernameMigration).toEqual(username_migration);
		expect(runtime.usernameTiers).toEqual(username_tiers);
	});

	it('keeps old discovery documents compatible when migration fields are absent', () => {
		const runtime = project();
		expect(runtime.usernameMigration).toBeUndefined();
		expect(runtime.usernameTiers).toBeUndefined();
	});

	it.each([
		{username_migration: null},
		{username_migration: {state: 'selecting', epoch: 1, started_at: null, forced_at: null}},
		{username_migration: {state: 'legacy', epoch: -1, started_at: null, forced_at: null}},
		{username_tiers: null},
		{username_tiers: {'1': 'public', '2': 'public'}},
		{username_tiers: {'1': 'premium', '2': 'locked', '3': 'locked'}},
	])('rejects malformed advertised username configuration %j', (fields) => {
		expect(() => parseInstanceDiscoveryDocument({...DEPLOYED_OFFICIAL_DOCUMENT, ...fields})).toThrow();
	});

	it('preserves typed premium and application capabilities', () => {
		const official_apps = [{application_id: '123', invite_permissions: '8'}];
		const runtime = project({premium_trial_days: 7, gift_codes_enabled: true, official_apps});
		expect(runtime.features.premium_trial_days).toBe(7);
		expect(runtime.features.gift_codes_enabled).toBe(true);
		expect(runtime.features.official_apps).toEqual(official_apps);
	});

	it('defaults capabilities that older discovery documents do not advertise', () => {
		const runtime = project();
		expect(runtime.features.premium_trial_days).toBe(0);
		expect(runtime.features.gift_codes_enabled).toBe(false);
		expect(runtime.features.official_apps).toEqual([]);
		expect(runtime.appPublic.legal.source_url).toBeNull();
		expect(runtime.appPublic.branding.premium_product_name).toBe('Plus');
	});

	it.each([-1, 1.5, '7', true])('ignores invalid trial days %j', (premium_trial_days) => {
		expect(project({premium_trial_days}).features.premium_trial_days).toBe(0);
	});

	it.each(
		[true, {}, [{application_id: 1, invite_permissions: '8'}], [{application_id: '123'}]].map((value) => [value]),
	)('ignores malformed official application lists %j', (official_apps) => {
		expect(project({official_apps}).features.official_apps).toEqual([]);
	});

	it('preserves source availability and visitor localization', () => {
		const localization = {default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul', 'Asia/Baku']};
		const runtime = project(
			{},
			{
				legal: {...DEPLOYED_OFFICIAL_DOCUMENT.app_public.legal, source_url: 'https://micup.gg/yasal/kaynak'},
				localization,
			},
		);
		expect(runtime.appPublic.legal.source_url).toBe('https://micup.gg/yasal/kaynak');
		expect(runtime.appPublic.localization).toEqual(localization);
	});

	it('refuses non-http source links and malformed localization', () => {
		const runtime = project(
			{},
			{
				legal: {...DEPLOYED_OFFICIAL_DOCUMENT.app_public.legal, source_url: 'javascript:alert(1)'},
				localization: {default_locale: 'tr', default_locale_time_zones: [false]},
			},
		);
		expect(runtime.appPublic.legal.source_url).toBeNull();
		expect(runtime.appPublic.localization).toBeUndefined();
	});
});
