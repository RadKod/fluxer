// SPDX-License-Identifier: AGPL-3.0-or-later
import {describe, expect, it, vi} from 'vitest';

const singleton = vi.hoisted(() => {
	vi.resetModules();
	return {getInstanceConfigRepository: vi.fn()};
});
vi.mock('@app/api/instance/InstanceConfigRepository', () => ({InstanceConfigRepository: class {}}));
vi.mock('@app/api/middleware/ProfileSubstringBlocklistCache', () => ({profileSubstringBlocklistCache: {}}));
vi.mock('@app/api/middleware/ServiceSingletons', () => singleton);

import {createUserID} from '@app/api/BrandedTypes';
import type {UsernameMigrationConfig} from '@app/api/instance/AccountIdentityModeCache';
import type {UsernamePolicyConfig} from '@app/api/instance/InstanceConfigRepository';
import {UsernameLookupType, UsernameType} from '@fluxer/schema/src/primitives/UserValidators';
import * as policy from '../UsernamePolicyService';

const actor = {kind: 'human' as const, userId: createUserID(1n)};
const bot = {kind: 'bot' as const, userId: null};
const entries = {uname_exact: ['admin'], uname_contains: ['fuck'], uname_allow: []};
function harness() {
	const dictionary = policy.compileUsernameDictionary(7, entries);
	const config: UsernamePolicyConfig = {
		revision: 4,
		tiers: {'1': 'locked', '2': 'for_sale', '3': 'public'},
		dictionary_gen: 7,
		previous_dictionary_gen: 0,
		dictionary_hash: dictionary.manifest.hash,
		next_dictionary_gen: 8,
		admission: {global_per_second: 200, paused: false},
		held_manifest: null,
	};
	const migration: UsernameMigrationConfig = {
		state: 'selecting',
		epoch: 2,
		started_at: '2026-10-01T00:00:00Z',
		forced_at: '2026-10-08T00:00:00Z',
	};
	const source = {
		getUsernamePolicyConfig: vi.fn(async () => config),
		getUsernameMigrationConfig: vi.fn(async () => migration),
		readUsernamePolicyConfig: vi.fn(async () => config),
		readUsernameMigrationConfig: vi.fn(async () => migration),
		openUsernameReserveMutation: vi.fn(async () => null),
		readUsernameReserveFence: vi.fn(async () => ({version: 0, pending: false})),
		closeUsernameReserveMutation: vi.fn(async () => {}),
	};
	const cache = {
		getUsernameDictionary: vi.fn((): policy.UsernameDictionary | null => dictionary),
		loadUsernameDictionary: vi.fn(async () => dictionary),
	};
	const service = new policy.UsernamePolicyService(source, cache);
	return {service, source, cache, config, dictionary, migration};
}
describe('username policy', () => {
	it('has a policy service', () => expect(policy.UsernamePolicyService).toBeTypeOf('function'));
	it.each([actor, bot])(
		'keeps upstream validation in legacy without a published dictionary for $kind',
		async (subject) => {
			const {service, cache, config, migration} = harness();
			config.dictionary_gen = 0;
			config.dictionary_hash = null;
			migration.state = 'legacy';
			migration.started_at = null;
			migration.forced_at = null;
			for (const name of ['a', 'ab', 'admin', 'fuck', 'ordinary']) {
				expect(await service.prevalidate(name, subject, false)).toBeNull();
			}
			const snap = await service.readAuthoritative();
			expect(snap.dictionary.gen).toBe(0);
			for (const name of ['a', 'ab', 'admin', 'fuck', 'ordinary']) {
				expect(service.check(name, subject, false, snap, null)).toBeNull();
			}
			expect(await service.prevalidate('bad.name', subject, false)).toBe('INVALID');
			expect(await service.prevalidate('micup', subject, false)).toBe('RESERVED_TERM');
			expect(cache.getUsernameDictionary).not.toHaveBeenCalled();
			expect(cache.loadUsernameDictionary).not.toHaveBeenCalled();
		},
	);
	it.each(['legacy', 'preparing', 'selecting'] as const)(
		'applies a published dictionary to human and bot names in %s',
		async (state) => {
			const {service, migration} = harness();
			migration.state = state;
			const snap = await service.readAuthoritative();
			for (const subject of [actor, bot]) {
				expect(await service.prevalidate('fuck', subject, false)).toBe('BLOCKED');
				expect(service.check('admin', subject, false, snap, null)).toBe('BLOCKED');
				expect(service.check('a', subject, false, snap, null)).toBe('REQUIRES_ENTITLEMENT');
			}
		},
	);
	it.each(['preparing', 'selecting'] as const)('fails closed without a dictionary in %s', async (state) => {
		const {service, config, migration} = harness();
		config.dictionary_gen = 0;
		config.dictionary_hash = null;
		migration.state = state;
		for (const subject of [actor, bot]) {
			expect(await service.prevalidate('ordinary', subject, false)).toBe('UNAVAILABLE');
		}
		await expect(service.readAuthoritative()).rejects.toBeInstanceOf(policy.UsernameUnavailableError);
	});
	it.each(['legacy', 'preparing', 'selecting'] as const)(
		'fails closed on an unreadable published dictionary in %s',
		async (state) => {
			const {service, cache, migration} = harness();
			migration.state = state;
			cache.getUsernameDictionary.mockReturnValue(null);
			cache.loadUsernameDictionary.mockRejectedValue(new Error('offline'));
			for (const subject of [actor, bot]) {
				expect(await service.prevalidate('ordinary', subject, false)).toBe('UNAVAILABLE');
			}
			await expect(service.readAuthoritative()).rejects.toBeInstanceOf(policy.UsernameUnavailableError);
		},
	);
	it('does not assume legacy when migration is unreadable with generation zero', async () => {
		const {service, config, source} = harness();
		config.dictionary_gen = 0;
		config.dictionary_hash = null;
		source.getUsernameMigrationConfig.mockRejectedValue(new Error('offline'));
		source.readUsernameMigrationConfig.mockRejectedValue(new Error('offline'));
		expect(await service.prevalidate('ordinary', bot, false)).toBe('UNAVAILABLE');
		await expect(service.readAuthoritative()).rejects.toBeInstanceOf(policy.UsernameUnavailableError);
	});
	it('default constructors share the configured hot config repository instead of creating database readers', async () => {
		const {source, cache} = harness();
		singleton.getInstanceConfigRepository.mockReturnValue(source);
		const first = new policy.UsernamePolicyService(undefined, cache);
		const second = new policy.UsernamePolicyService(undefined, cache);
		expect(await first.prevalidate('ordinary', actor, false)).toBeNull();
		expect(await second.prevalidate('ordinary', actor, false)).toBeNull();
		expect(singleton.getInstanceConfigRepository).toHaveBeenCalledTimes(2);
		expect(source.getUsernamePolicyConfig).toHaveBeenCalledTimes(2);
		expect(source.readUsernamePolicyConfig).not.toHaveBeenCalled();
		expect(cache.loadUsernameDictionary).not.toHaveBeenCalled();
	});
	it('delegates validation to the shared self/bot and admin schemas', async () => {
		const {service} = harness();
		const snap = await service.readAuthoritative();
		const self = vi.spyOn(UsernameType, 'safeParse');
		const admin = vi.spyOn(UsernameLookupType, 'safeParse');
		try {
			service.check('ordinary', actor, false, snap, null);
			expect(self).toHaveBeenCalledWith('ordinary');
			service.check('micup', actor, true, snap, null);
			expect(admin).toHaveBeenCalledWith('micup');
			service.check('ordinary', bot, false, snap, null);
			expect(self).toHaveBeenCalledTimes(2);
			service.check('micup', bot, true, snap, null);
			expect(admin).toHaveBeenCalledTimes(2);
		} finally {
			self.mockRestore();
			admin.mockRestore();
		}
	});
	it('authoritative reads use strict config paths and verify dictionary pointer hash', async () => {
		const {service, source, cache} = harness();
		const snap = await service.readAuthoritative();
		expect(source.readUsernamePolicyConfig).toHaveBeenCalledOnce();
		expect(source.readUsernameMigrationConfig).toHaveBeenCalledOnce();
		expect(source.getUsernamePolicyConfig).not.toHaveBeenCalled();
		expect(cache.loadUsernameDictionary).toHaveBeenCalledWith(7, expect.any(String));
		expect(snap.migration.forcedAt).toEqual(new Date('2026-10-08T00:00:00Z'));
	});
	it.each(['policy', 'identity', 'dictionary', 'hash', 'generation'] as const)(
		'fails closed when authoritative %s fails',
		async (failure) => {
			const {service, source, cache, config} = harness();
			if (failure === 'policy') source.readUsernamePolicyConfig.mockRejectedValueOnce(new Error('offline'));
			if (failure === 'identity') source.readUsernameMigrationConfig.mockRejectedValueOnce(new Error('offline'));
			if (failure === 'dictionary') cache.loadUsernameDictionary.mockRejectedValueOnce(new Error('offline'));
			if (failure === 'hash') config.dictionary_hash = '0'.repeat(64);
			if (failure === 'generation') config.dictionary_gen = 8;
			await expect(service.readAuthoritative()).rejects.toBeInstanceOf(policy.UsernameUnavailableError);
		},
	);
	it('prevalidation uses only cached config and defers granted short-name authorization', async () => {
		const {service, source, cache} = harness();
		expect(await service.prevalidate('a', actor, false)).toBeNull();
		expect(source.readUsernamePolicyConfig).not.toHaveBeenCalled();
		expect(cache.loadUsernameDictionary).not.toHaveBeenCalled();
		const snap = await service.readAuthoritative();
		expect(service.check('a', actor, false, snap, 'a')).toBeNull();
	});
	it('cache outages are unavailable, never silently allowed', async () => {
		const {service, source} = harness();
		source.getUsernamePolicyConfig.mockRejectedValueOnce(new Error('offline'));
		expect(await service.prevalidate('ordinary', actor, false)).toBe('UNAVAILABLE');
	});
	it('loads a cold dictionary once using the cached pointer so prevalidation cannot deadlock startup', async () => {
		const {service, source, cache} = harness();
		cache.getUsernameDictionary.mockReturnValueOnce(null);
		expect(await service.prevalidate('ordinary', actor, false)).toBeNull();
		expect(cache.loadUsernameDictionary).toHaveBeenCalledWith(7, expect.any(String));
		expect(source.readUsernamePolicyConfig).not.toHaveBeenCalled();
	});
	it('checks format, reserved brand, filters, all tiers, grants and bots without a staff filter exemption', async () => {
		const {service} = harness();
		const snap = await service.readAuthoritative();
		for (const name of ['', 'Upper', 'bad.name', 'a'.repeat(33)])
			expect(service.check(name, actor, false, snap, null)).toBe('INVALID');
		for (const name of ['micup', 'm1cup', 'rnicup', 'everyone', 'here', 'fluxerabc'])
			expect(service.check(name, actor, false, snap, null)).toBe('RESERVED_TERM');
		expect(service.check('micup', actor, true, snap, null)).toBeNull();
		expect(service.check('admin', actor, true, snap, null)).toBe('BLOCKED');
		expect(service.check('fuck', actor, true, snap, null)).toBe('BLOCKED');
		expect(service.check('a', actor, false, snap, null)).toBe('REQUIRES_ENTITLEMENT');
		expect(service.check('ab', actor, false, snap, 'xy')).toBe('REQUIRES_ENTITLEMENT');
		expect(service.check('ab', actor, false, snap, 'ab')).toBeNull();
		expect(service.check('abc', actor, false, snap, null)).toBeNull();
		expect(service.check('a', actor, true, snap, null)).toBeNull();
		expect(service.check('a', bot, true, snap, null)).toBe('REQUIRES_ENTITLEMENT');
		expect(service.check('micup', bot, true, snap, null)).toBeNull();
	});
});
