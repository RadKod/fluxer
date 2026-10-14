// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {createUserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {UserAccountRequestService} from '@app/api/user/services/UserAccountRequestService';
import {UserUsernamePromptResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test('server retry preserves the first-day right for the client/server delay counterexample', async () => {
	vi.useFakeTimers();
	const id = createUserID(1000000000000000000n);
	const start = Date.parse('2026-10-01T00:00:00Z');
	const serverDelay = createHash('sha256').update(`${id}:1`).digest().readUInt32BE(0) % (6 * 3600000 + 1);
	vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
		state: 'selecting',
		epoch: 1,
		started_at: new Date(start).toISOString(),
		forced_at: '2026-10-08T00:00:00Z',
	});
	const set = vi.spyOn(getKVClient(), 'set').mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
	const service = new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never);
	const user = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
	vi.setSystemTime(start + 13262526);
	const early = await service.getUsernamePrompt(user);
	expect(early).toEqual({show: false, retry_after_ms: serverDelay - 13262526});
	expect(UserUsernamePromptResponse.parse(early)).toEqual(early);
	expect(set).not.toHaveBeenCalled();
	vi.setSystemTime(start + serverDelay);
	expect(await service.getUsernamePrompt(user)).toEqual({show: true});
	expect(await service.getUsernamePrompt(user)).toEqual({show: false});
	expect(set).toHaveBeenCalledTimes(2);
	expect(set).toHaveBeenCalledWith(`uprompt:${id}:2026-10-01`, '1', 'EX', 172800, 'NX');
});

test('server spreads the next Istanbul day and keeps a late first-day deadline across midnight', async () => {
	vi.useFakeTimers();
	const id = createUserID(1000000000000000000n);
	const start = Date.parse('2026-10-01T20:30:00Z');
	const delay = createHash('sha256').update(`${id}:1`).digest().readUInt32BE(0) % (6 * 3600000 + 1);
	vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
		state: 'selecting',
		epoch: 1,
		started_at: new Date(start).toISOString(),
		forced_at: '2026-10-08T00:00:00Z',
	});
	const set = vi.spyOn(getKVClient(), 'set').mockResolvedValue('OK');
	const service = new UserAccountRequestService({} as never, {} as never, {} as never, {} as never, {} as never);
	const user = new User({...EMPTY_USER_ROW, user_id: id, username: 'legacy_name', discriminator: 1234});
	vi.setSystemTime(Date.parse('2026-10-01T21:00:00Z'));
	expect(await service.getUsernamePrompt(user)).toEqual({show: false, retry_after_ms: start + delay - Date.now()});
	vi.setSystemTime(start + delay);
	expect(await service.getUsernamePrompt(user)).toEqual({show: true});
	vi.setSystemTime(Date.parse('2026-10-02T21:00:00Z'));
	expect(await service.getUsernamePrompt(user)).toEqual({show: false, retry_after_ms: delay});
	expect(set).toHaveBeenCalledOnce();
});
