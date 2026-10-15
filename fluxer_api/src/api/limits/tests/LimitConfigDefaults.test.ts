// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	buildStoredLimitConfig,
	createDefaultLimitConfig,
	mergeWithCurrentDefaults,
	readStoredLimitOverrides,
	sanitizeLimitConfigForInstance,
} from '@app/api/constants/LimitConfig';
import {guildBoostFeatures, guildBoostTier} from '@app/api/guild/boost/GuildBoostLevels';
import {GuildFeatures, getMaxVoiceChannelBitrate} from '@fluxer/constants/src/GuildConstants';
import {LIMIT_CATEGORY_LABELS, LIMIT_KEY_METADATA, LIMIT_KEYS} from '@fluxer/constants/src/LimitConfigMetadata';
import {MAX_GUILD_MEMBERS_VERY_LARGE_GUILD} from '@fluxer/constants/src/LimitConstants';
import {DEFAULT_RESTRICTED_LIMITS, DEFAULT_STOCK_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import {resolveLimits} from '@fluxer/limits/src/LimitResolver';
import type {LimitConfigSnapshot, LimitRule} from '@fluxer/limits/src/LimitTypes';
import {LimitConfigGetResponse, LimitConfigUpdateRequest} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {describe, expect, test} from 'vitest';

describe('Limit config storage', () => {
	const mirror = {selfHosted: true, premiumMode: 'mirror'} as const;
	const everyone = {selfHosted: true, premiumMode: 'everyone'} as const;
	const hosted = {selfHosted: false, premiumMode: 'everyone'} as const;
	const modeKeys = LIMIT_KEYS.filter((key) => DEFAULT_STOCK_LIMITS[key] !== DEFAULT_RESTRICTED_LIMITS[key]);

	function defaultRuleConfig(rule: Omit<LimitRule, 'id'>): LimitConfigSnapshot {
		return {traitDefinitions: [], rules: [{id: 'default', ...rule}]};
	}

	function fullConfig(options: {selfHosted: boolean; premiumMode: 'mirror' | 'everyone'}): LimitConfigSnapshot {
		const {traitDefinitions, rules} = createDefaultLimitConfig(options);
		return {traitDefinitions, rules};
	}

	function withLimits(config: LimitConfigSnapshot, ruleId: string, limits: LimitRule['limits']): LimitConfigSnapshot {
		return {
			traitDefinitions: config.traitDefinitions,
			rules: config.rules.map((rule) => (rule.id === ruleId ? {...rule, limits: {...rule.limits, ...limits}} : rule)),
		};
	}

	function load(stored: LimitConfigSnapshot, options: typeof mirror | typeof everyone): LimitConfigSnapshot {
		const overrides = readStoredLimitOverrides(structuredClone(stored), options);
		return mergeWithCurrentDefaults(sanitizeLimitConfigForInstance(overrides, options), options);
	}

	function limitsOf(config: LimitConfigSnapshot, ruleId: string): LimitRule['limits'] | undefined {
		return config.rules.find((rule) => rule.id === ruleId)?.limits;
	}

	test('built-in rules keep only values that differ from the defaults', () => {
		const stored = buildStoredLimitConfig(
			{
				traitDefinitions: ['premium', 'vip'],
				rules: [
					{id: 'premium', filters: {traits: ['premium']}, limits: {...DEFAULT_STOCK_LIMITS, max_guilds: 250}},
					{id: 'default', limits: {...DEFAULT_RESTRICTED_LIMITS}, modifiedFields: ['max_guilds']},
					{id: 'vip', filters: {traits: ['vip']}, limits: {max_guilds: 100}},
				],
			},
			null,
			mirror,
		);
		expect(stored.rules).toEqual([
			{id: 'premium', filters: {traits: ['premium']}, limits: {max_guilds: 250}},
			{id: 'default', limits: {}},
			{id: 'vip', filters: {traits: ['vip']}, limits: {max_guilds: 100}},
		]);
	});

	test('hosted instances keep storing whole rules', () => {
		const submitted = withLimits(fullConfig(hosted), 'default', {max_guilds: 150});
		const stored = buildStoredLimitConfig(submitted, null, hosted);
		expect(stored).toEqual(mergeWithCurrentDefaults(submitted, hosted));
		expect(limitsOf(stored, 'default')).toEqual({...DEFAULT_RESTRICTED_LIMITS, max_guilds: 150});
		expect(readStoredLimitOverrides(stored, hosted)).toBe(stored);
	});

	test('a whole default rule saved under the other premium model keeps only its edits', () => {
		const stored = defaultRuleConfig({
			limits: {...DEFAULT_RESTRICTED_LIMITS, max_guilds: 150, max_bio_length: 300},
			modifiedFields: ['max_guilds', 'max_bio_length'],
		});
		expect(readStoredLimitOverrides(stored, everyone).rules).toEqual([
			{id: 'default', limits: {max_guilds: 150, max_bio_length: 300}},
		]);
	});

	test('a whole default rule saved under the current premium model keeps only its edits', () => {
		const stored = defaultRuleConfig({
			limits: {...DEFAULT_RESTRICTED_LIMITS, feature_custom_discriminator: 1},
			modifiedFields: ['feature_custom_discriminator'],
		});
		expect(readStoredLimitOverrides(stored, mirror).rules).toEqual([
			{id: 'default', limits: {feature_custom_discriminator: 1}},
		]);
	});

	test('free limits saved again after a switch to everyone are dropped', () => {
		const savedInMirror = mergeWithCurrentDefaults(fullConfig(mirror), mirror);
		const shownInEveryone = mergeWithCurrentDefaults(savedInMirror, everyone);
		expect(limitsOf(shownInEveryone, 'default')).toEqual(DEFAULT_RESTRICTED_LIMITS);
		const savedAgain = mergeWithCurrentDefaults(shownInEveryone, everyone);
		expect(savedAgain.rules.find((rule) => rule.id === 'default')?.modifiedFields).toEqual(modeKeys);
		expect(limitsOf(load(savedAgain, everyone), 'default')).toEqual(DEFAULT_STOCK_LIMITS);
		expect(limitsOf(load(savedAgain, mirror), 'default')).toEqual(DEFAULT_RESTRICTED_LIMITS);
	});

	test('free limits saved again with an edit after a switch to everyone keep only the edit', () => {
		const savedInMirror = mergeWithCurrentDefaults(
			withLimits(fullConfig(mirror), 'default', {max_guilds: 150, max_bio_length: 300}),
			mirror,
		);
		const savedAgain = mergeWithCurrentDefaults(mergeWithCurrentDefaults(savedInMirror, everyone), everyone);
		expect(savedAgain.rules.find((rule) => rule.id === 'default')?.modifiedFields).toEqual(
			LIMIT_KEYS.filter((key) => modeKeys.includes(key) || key === 'max_bio_length'),
		);
		expect(readStoredLimitOverrides(savedAgain, everyone).rules.find((rule) => rule.id === 'default')).toEqual({
			id: 'default',
			limits: {max_bio_length: 300, max_guilds: 150},
		});
	});

	test('a default rule fixed by hand after a switch is left as saved', () => {
		const stored = defaultRuleConfig({
			limits: {...DEFAULT_RESTRICTED_LIMITS, feature_custom_discriminator: 1},
			modifiedFields: modeKeys.filter((key) => key !== 'feature_custom_discriminator'),
		});
		expect(limitsOf(load(stored, everyone), 'default')).toEqual({
			...DEFAULT_RESTRICTED_LIMITS,
			feature_custom_discriminator: 1,
		});
	});

	test('premium limits saved again after a switch to mirror are dropped', () => {
		const savedInEveryone = mergeWithCurrentDefaults(fullConfig(everyone), everyone);
		const shownInMirror = mergeWithCurrentDefaults(savedInEveryone, mirror);
		expect(limitsOf(shownInMirror, 'default')).toEqual(DEFAULT_STOCK_LIMITS);
		const savedAgain = mergeWithCurrentDefaults(shownInMirror, mirror);
		const loaded = load(savedAgain, mirror);
		expect(limitsOf(loaded, 'default')).toEqual(DEFAULT_RESTRICTED_LIMITS);
		expect(limitsOf(loaded, 'premium')).toEqual(DEFAULT_STOCK_LIMITS);
		expect(loaded.traitDefinitions).toEqual(['premium']);
	});

	test('overrides saved in the current format are never reinterpreted', () => {
		const raised = buildStoredLimitConfig(
			withLimits(fullConfig(mirror), 'default', DEFAULT_STOCK_LIMITS),
			null,
			mirror,
		);
		expect(Object.keys(limitsOf(raised, 'default') ?? {})).toEqual(modeKeys);
		expect(readStoredLimitOverrides(raised, mirror)).toBe(raised);
		expect(readStoredLimitOverrides(raised, everyone)).toBe(raised);
		expect(limitsOf(load(raised, mirror), 'default')).toEqual(DEFAULT_STOCK_LIMITS);
	});

	test('an edit that matches the other premium model survives a save there', () => {
		const edits = {feature_custom_discriminator: 1, max_guilds: DEFAULT_STOCK_LIMITS.max_guilds};
		const savedInMirror = buildStoredLimitConfig(withLimits(fullConfig(mirror), 'default', edits), null, mirror);
		const savedInEveryone = buildStoredLimitConfig(
			withLimits(load(savedInMirror, everyone), 'default', {max_bio_length: 300}),
			savedInMirror,
			everyone,
		);
		expect(limitsOf(savedInEveryone, 'default')).toEqual({...edits, max_bio_length: 300});
		expect(limitsOf(load(savedInEveryone, mirror), 'default')).toEqual({
			...DEFAULT_RESTRICTED_LIMITS,
			...edits,
			max_bio_length: 300,
		});
	});

	test('a value moved back to the default stops being stored', () => {
		const savedInMirror = buildStoredLimitConfig(
			withLimits(fullConfig(mirror), 'default', {max_guilds: 150}),
			null,
			mirror,
		);
		const reverted = buildStoredLimitConfig(fullConfig(mirror), savedInMirror, mirror);
		expect(limitsOf(reverted, 'default')).toEqual({});
	});

	test('premium rule edits survive a save while everyone hides the rule', () => {
		const edits = {max_guilds: 999, feature_custom_discriminator: 0};
		const savedInMirror = buildStoredLimitConfig(withLimits(fullConfig(mirror), 'premium', edits), null, mirror);
		expect(limitsOf(load(savedInMirror, everyone), 'premium')).toBeUndefined();
		const savedInEveryone = buildStoredLimitConfig(fullConfig(everyone), savedInMirror, everyone);
		expect(savedInEveryone.traitDefinitions).toEqual(['premium']);
		expect(limitsOf(savedInEveryone, 'premium')).toEqual(edits);
		expect(limitsOf(load(savedInEveryone, mirror), 'premium')).toEqual({...DEFAULT_STOCK_LIMITS, ...edits});
	});
});

describe('Limit config defaults', () => {
	test('hosted defaults include premium, default, very large guild and boost feature rules', () => {
		const config = createDefaultLimitConfig({selfHosted: false});
		expect(config.rules.find((rule) => rule.id === 'very_large_guild')).toMatchObject({
			filters: {guildFeatures: [GuildFeatures.VERY_LARGE_GUILD]},
			limits: {max_guild_members: MAX_GUILD_MEMBERS_VERY_LARGE_GUILD},
		});
		expect(config.rules.map((rule) => rule.id)).toEqual([
			'premium',
			'default',
			'very_large_guild',
			'more_emoji',
			'more_stickers',
			'boost_level_1',
			'boost_level_2',
			'boost_level_3',
		]);
	});
	test('self-hosted defaults include default, very large guild and boost feature rules', () => {
		const config = createDefaultLimitConfig({selfHosted: true});
		expect(config.rules.find((rule) => rule.id === 'very_large_guild')).toMatchObject({
			filters: {guildFeatures: [GuildFeatures.VERY_LARGE_GUILD]},
			limits: {max_guild_members: MAX_GUILD_MEMBERS_VERY_LARGE_GUILD},
		});
		expect(config.rules.map((rule) => rule.id)).toEqual([
			'default',
			'very_large_guild',
			'more_emoji',
			'more_stickers',
			'boost_level_1',
			'boost_level_2',
			'boost_level_3',
		]);
	});
});

describe('Guild boost limit contract', () => {
	const matrix = [
		[0, 8, 720, 30, 500, 500, 500, 250, 0, 0, 25 * 1024 * 1024, 96_000],
		[1, 24, 720, 60, 1000, 500, 500, 250, 1, 0, 25 * 1024 * 1024, 128_000],
		[2, 36, 1080, 60, 1250, 1000, 600, 300, 1, 1, 50_000_000, 256_000],
		[3, 48, 1080, 60, 1500, 1250, 750, 350, 1, 1, 100_000_000, 384_000],
	];

	test.each(matrix)(
		'resolves the complete level %i product limits',
		(tier, sounds, height, fps, emojis, stickers, channels, roles, icons, gradient, fileSize, bitrate) => {
			const features = guildBoostFeatures(tier);
			const {limits} = resolveLimits(
				createDefaultLimitConfig(),
				{traits: new Set(), guildFeatures: features},
				{evaluationContext: 'guild'},
			);
			expect(limits).toMatchObject({
				max_guild_soundboard_sounds: sounds,
				max_guild_video_height: height,
				max_guild_video_fps: fps,
				max_guild_emojis: emojis,
				max_guild_stickers: stickers,
				max_guild_channels: channels,
				max_guild_roles: roles,
				feature_role_icons: icons,
				feature_role_gradient: gradient,
				max_attachment_file_size: fileSize,
			});
			expect(getMaxVoiceChannelBitrate(features)).toBe(bitrate);
			expect(features.has(GuildFeatures.ANIMATED_ICON)).toBe(tier >= 1);
			expect(features.has(GuildFeatures.ANIMATED_BANNER)).toBe(tier >= 3);
			expect(features.has(GuildFeatures.VANITY_URL)).toBe(tier >= 3);
			for (let level = 1; level <= 3; level++) {
				expect(features.has(`BOOST_LEVEL_${level}`)).toBe(tier >= level);
			}
		},
	);

	test.each([
		[0, 0],
		[1, 0],
		[2, 1],
		[6, 1],
		[7, 2],
		[13, 2],
		[14, 3],
		[99, 3],
	])('keeps %i boosts at tier %i', (boosts, tier) => {
		expect(guildBoostTier(boosts)).toBe(tier);
	});

	test('keeps personal Premium and independent operator grants above the boost tier', () => {
		const config = createDefaultLimitConfig();
		config.rules.push({id: 'operator', filters: {guildFeatures: ['OPERATOR']}, limits: {max_guild_channels: 2000}});
		const {limits} = resolveLimits(
			config,
			{traits: new Set(['premium']), guildFeatures: new Set([...guildBoostFeatures(3), 'OPERATOR'])},
			{evaluationContext: 'guild'},
		);
		expect(limits.max_attachment_file_size).toBe(500 * 1024 * 1024);
		expect(limits.max_guild_channels).toBe(2000);
		const independent = resolveLimits(
			config,
			{traits: new Set(), guildFeatures: new Set([GuildFeatures.MORE_EMOJI, GuildFeatures.MORE_STICKERS])},
			{evaluationContext: 'guild'},
		).limits;
		expect(independent.max_guild_emojis).toBe(1000);
		expect(independent.max_guild_stickers).toBe(1000);
	});

	test('does not make personal Premium grant guild role or video upgrades', () => {
		const {limits} = resolveLimits(
			createDefaultLimitConfig(),
			{traits: new Set(['premium']), guildFeatures: new Set()},
			{evaluationContext: 'guild'},
		);
		expect(limits).toMatchObject({
			feature_role_icons: 0,
			feature_role_gradient: 0,
			max_guild_soundboard_sounds: 8,
			max_guild_video_height: 720,
			max_guild_video_fps: 30,
		});
		expect(limits.feature_higher_video_quality).toBe(1);
	});

	test('roundtrips every new key through admin schemas and preserves stored overrides', () => {
		const config = createDefaultLimitConfig();
		config.rules.push({
			id: 'custom',
			filters: {guildFeatures: ['CUSTOM']},
			limits: {
				max_guild_soundboard_sounds: 64,
				max_guild_video_height: 1440,
				max_guild_video_fps: 120,
				feature_role_icons: 1,
				feature_role_gradient: 1,
			},
		});
		const request = LimitConfigUpdateRequest.parse({limit_config: config});
		const stored = JSON.parse(JSON.stringify(request.limit_config));
		const merged = mergeWithCurrentDefaults(stored);
		const response = LimitConfigGetResponse.parse({
			limit_config: merged,
			limit_config_json: JSON.stringify(merged),
			self_hosted: false,
			defaults: {},
			metadata: LIMIT_KEY_METADATA,
			categories: LIMIT_CATEGORY_LABELS,
			limit_keys: LIMIT_KEYS,
		});
		expect(response.limit_config.rules.find((rule) => rule.id === 'custom')?.limits).toEqual(
			config.rules.at(-1)?.limits,
		);
		expect(response.limit_config.rules.find((rule) => rule.id === 'custom')?.modifiedFields).toEqual(
			expect.arrayContaining([
				'max_guild_soundboard_sounds',
				'max_guild_video_height',
				'max_guild_video_fps',
				'feature_role_icons',
				'feature_role_gradient',
			]),
		);
	});
});
