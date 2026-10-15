// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminRepository} from '@app/api/admin/AdminRepository';
import {ipBanCache} from '@app/api/middleware/IpBanMiddleware';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

beforeEach(() => {
	ipBanCache.resetCaches();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('IpBanCache', () => {
	it('replaces a permanent entry with the exact persisted temporary expiry', () => {
		vi.useFakeTimers({toFake: ['Date']});
		const expiry = new Date(Date.now() + 3_600_000);
		ipBanCache.ban('203.0.113.60');
		ipBanCache.replaceBan('203.0.113.60', expiry);
		expect(ipBanCache.getMatch('203.0.113.60')).toMatchObject({kind: 'temporary_24h', expiresAt: expiry});
		vi.advanceTimersByTime(3_600_001);
		expect(ipBanCache.getMatch('203.0.113.60')).toBeNull();
		ipBanCache.replaceBan('203.0.113.60', null);
		expect(ipBanCache.getMatch('203.0.113.60')).toMatchObject({kind: 'permanent', expiresAt: null});
	});
	it('builds the replacement index during refresh and clears it during reset', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const first = '2a01:e0a:d10:3333::1';
		const sibling = '2a01:e0a:d10:3333::2';
		const expiry = new Date(Date.now() + 3_600_000);
		vi.spyOn(AdminRepository.prototype, 'loadAllBannedIpEntries').mockResolvedValue([
			{ip: first, kind: 'permanent', reason: null, expiresAt: null, createdAt: null, decisionId: null},
			{ip: sibling, kind: 'permanent', reason: null, expiresAt: null, createdAt: null, decisionId: null},
		]);
		await ipBanCache.refresh();
		ipBanCache.replaceBan(first, expiry);
		expect(ipBanCache.getMatch(first)?.kind).toBe('permanent');
		ipBanCache.replaceBan(sibling, expiry);
		expect(ipBanCache.getMatch(first)?.expiresAt).toEqual(expiry);
		ipBanCache.resetCaches();
		ipBanCache.replaceBan(first, expiry);
		expect(ipBanCache.getMatch(first)?.expiresAt).toEqual(expiry);
		vi.advanceTimersByTime(3_600_001);
		expect(ipBanCache.getMatch(sibling)).toBeNull();
	});
	it('replaces a range entry without retaining its prior permanent state', () => {
		const expiry = new Date(Date.now() + 3_600_000);
		ipBanCache.ban('203.0.113.0/24');
		ipBanCache.replaceBan('203.0.113.0/24', expiry);
		expect(ipBanCache.getMatch('203.0.113.70')).toMatchObject({kind: 'temporary_24h', expiresAt: expiry});
	});
	it('retains sibling permanent bans while replacing one IPv6 entry', () => {
		vi.useFakeTimers({toFake: ['Date']});
		const first = '2a01:e0a:d10:2222::1';
		const sibling = '2a01:e0a:d10:2222::2';
		const rotated = '2a01:e0a:d10:2222::3';
		ipBanCache.ban(first);
		ipBanCache.ban(sibling);
		ipBanCache.replaceBan(first, new Date(Date.now() + 3_600_000));
		vi.advanceTimersByTime(3_600_001);
		expect(ipBanCache.getMatch(rotated)?.kind).toBe('permanent');
		ipBanCache.replaceBan(sibling, new Date(Date.now() + 3_600_000));
		vi.advanceTimersByTime(3_600_001);
		expect(ipBanCache.getMatch(rotated)).toBeNull();
	});
	it('does not remove a sibling permanent /64 ban when unbanning a temporary entry', () => {
		vi.useFakeTimers({toFake: ['Date']});
		const temporary = '2a01:e0a:d10:4444::1';
		const permanent = '2a01:e0a:d10:4444::2';
		ipBanCache.replaceBan(temporary, new Date(Date.now() + 3_600_000));
		ipBanCache.replaceBan(permanent, null);
		ipBanCache.unban(temporary);
		vi.advanceTimersByTime(3_600_001);
		expect(ipBanCache.getMatch('2a01:e0a:d10:4444::3')?.kind).toBe('permanent');
	});
	it('blocks IPv4-mapped IPv6 when a single IPv4 address is banned', () => {
		ipBanCache.ban('127.0.0.1');
		expect(ipBanCache.isBanned('127.0.0.1')).toBe(true);
		expect(ipBanCache.isBanned('::ffff:7f00:1')).toBe(true);
	});
	it('blocks IPv4-mapped IPv6 when an IPv4 range is banned', () => {
		ipBanCache.ban('127.0.0.0/24');
		expect(ipBanCache.isBanned('127.0.0.5')).toBe(true);
		expect(ipBanCache.isBanned('::ffff:7f00:5')).toBe(true);
	});
	it('blocks IPv4 clients when the IPv4-mapped IPv6 range is banned', () => {
		ipBanCache.ban('::ffff:0:0/96');
		expect(ipBanCache.isBanned('::ffff:127.0.0.1')).toBe(true);
		expect(ipBanCache.isBanned('127.0.0.1')).toBe(true);
	});
	it('blocks rotated IPv6 privacy addresses from the same /64 when a single IPv6 address is banned', () => {
		ipBanCache.ban('2a01:e0a:d10:95b0:8f54:410e:f290:1c66');
		expect(ipBanCache.isBanned('2a01:e0a:d10:95b0:01e4:53a8:d0dd:7733')).toBe(true);
	});
	it('keeps IPv4 bans exact rather than widening to /24', () => {
		ipBanCache.ban('203.0.113.42');
		expect(ipBanCache.isBanned('203.0.113.42')).toBe(true);
		expect(ipBanCache.isBanned('203.0.113.43')).toBe(false);
	});
	it('reports temporary global IP bans distinctly', () => {
		ipBanCache.banTemp('203.0.113.50', 86400);
		const match = ipBanCache.getMatch('203.0.113.50');
		expect(match?.kind).toBe('temporary_24h');
		expect(match?.expiresAt).toBeInstanceOf(Date);
	});
	it('reports permanent global IP bans distinctly', () => {
		ipBanCache.ban('203.0.113.51');
		const match = ipBanCache.getMatch('203.0.113.51');
		expect(match?.kind).toBe('permanent');
		expect(match?.expiresAt).toBe(null);
	});
	it('stops matching a temporary ban once it has expired', () => {
		vi.useFakeTimers({toFake: ['Date']});
		ipBanCache.banTemp('203.0.113.52', 3600);
		ipBanCache.banTemp('203.0.113.0/24', 3600);
		expect(ipBanCache.isBanned('203.0.113.52')).toBe(true);
		expect(ipBanCache.isBanned('203.0.113.53')).toBe(true);
		vi.advanceTimersByTime(3_600_001);
		expect(ipBanCache.getMatch('203.0.113.52')).toBe(null);
		expect(ipBanCache.getMatch('203.0.113.53')).toBe(null);
	});
	it('keeps matching a permanent ban that shares an address with an expired temporary one', () => {
		vi.useFakeTimers({toFake: ['Date']});
		ipBanCache.banTemp('203.0.113.54', 3600);
		ipBanCache.ban('203.0.113.54');
		vi.advanceTimersByTime(3_600_001);
		expect(ipBanCache.getMatch('203.0.113.54')?.kind).toBe('permanent');
	});
});
