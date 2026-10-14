// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {type TableEnvelope, TableGameRepository, tableGameTimerShard} from '@app/api/table_game/TableGameRepository';
import {registerTableGameMockScripts} from '@app/api/table_game/tests/TableGameMockScripts';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {TABLE_GAME_SPECTATOR_LIMIT, TABLE_GAME_TIMER_SHARDS} from '@fluxer/constants/src/TableGameConstants';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

registerTableGameMockScripts();

const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;

let channelSeq = 1000;

function lobby(channelId: string, version = 0): TableEnvelope {
	return {
		v: 1,
		version,
		guild_id: '1',
		channel_id: channelId,
		slot: 'T01',
		game: 'okey',
		speed: 'normal',
		status: 'lobby',
		players: [{position: 1, user_id: '10'}],
		disconnected: {},
		next_presence_check_at: null,
		created_at: 0,
		ended_at: null,
		result: null,
		engine: null,
	};
}

function repositoryContract(name: string, kv: () => IKVProvider) {
	describe(`TableGameRepository (${name})`, () => {
		const repo = () => new TableGameRepository(kv());
		const nextChannel = () => String(channelSeq++);

		it('create fails when the slot has a table', async () => {
			const channelId = nextChannel();
			expect(await repo().cas(lobby(channelId), null, 600)).toBe(true);
			expect(await repo().cas(lobby(channelId), null, 600)).toBe(false);
			expect((await repo().load(channelId, 'T01'))?.version).toBe(0);
		});

		it('CAS with a stale version fails', async () => {
			const channelId = nextChannel();
			await repo().cas(lobby(channelId), null, 600);
			expect(await repo().cas(lobby(channelId, 1), 0, 600)).toBe(true);
			expect(await repo().cas(lobby(channelId, 2), 0, 600)).toBe(false);
			expect(await repo().cas(lobby(channelId, 2), 1, 600)).toBe(true);
			expect((await repo().load(channelId, 'T01'))?.version).toBe(2);
		});

		it('spectator cap 50: 51st → 0, member re-add → 1', async () => {
			const channelId = nextChannel();
			for (let user = 1; user <= TABLE_GAME_SPECTATOR_LIMIT; user++) {
				expect(await repo().spectate(channelId, 'T01', String(user), TABLE_GAME_SPECTATOR_LIMIT, 600)).toBe(true);
			}
			expect(await repo().spectate(channelId, 'T01', '51', TABLE_GAME_SPECTATOR_LIMIT, 600)).toBe(false);
			expect(await repo().spectate(channelId, 'T01', '7', TABLE_GAME_SPECTATOR_LIMIT, 600)).toBe(true);
			expect((await repo().listSpectators(channelId, 'T01')).length).toBe(TABLE_GAME_SPECTATOR_LIMIT);
		});

		it('unlock deletes only when the value matches', async () => {
			const userId = nextChannel();
			expect(await repo().lockUser(userId, 'a:T01')).toBe(true);
			expect(await repo().lockUser(userId, 'b:T01')).toBe(false);
			expect(await repo().unlockUser(userId, 'b:T01')).toBe(false);
			expect(await repo().readUserLock(userId)).toBe('a:T01');
			expect(await repo().unlockUser(userId, 'a:T01')).toBe(true);
			expect(await repo().readUserLock(userId)).toBeNull();
		});

		it('timer lease is exclusive and released only by its token', async () => {
			const shard = 3;
			expect(await repo().acquireTimerLease(shard, 'one')).toBe(true);
			expect(await repo().acquireTimerLease(shard, 'two')).toBe(false);
			await repo().releaseTimerLease(shard, 'two');
			expect(await repo().acquireTimerLease(shard, 'two')).toBe(false);
			await repo().releaseTimerLease(shard, 'one');
			expect(await repo().acquireTimerLease(shard, 'two')).toBe(true);
			await repo().releaseTimerLease(shard, 'two');
		});

		it('due timers come from the member shard in deadline order and leave with clear', async () => {
			const channelId = nextChannel();
			await repo().scheduleTimer(channelId, 'T01', 5_000);
			const shard = tableGameTimerShard(`${channelId}:T01`);
			expect(await repo().dueTimers(shard, 4_999, 200)).not.toContain(`${channelId}:T01`);
			expect(await repo().dueTimers(shard, 5_000, 200)).toContain(`${channelId}:T01`);
			await repo().scheduleTimer(channelId, 'T01', null);
			expect(await repo().dueTimers(shard, 10_000, 200)).not.toContain(`${channelId}:T01`);
		});
	});
}

describe('TableGameRepository keys', () => {
	it('timer shard is stable for a member', () => {
		const shard = tableGameTimerShard('1234567890:T01');
		expect(shard).toBe(tableGameTimerShard('1234567890:T01'));
		expect(shard).toBeGreaterThanOrEqual(0);
		expect(shard).toBeLessThan(TABLE_GAME_TIMER_SHARDS);
		// sha1('1234567890:T01') starts with 'b5' → 181 % 16
		expect(shard).toBe(0xb5 % TABLE_GAME_TIMER_SHARDS);
	});
});

const mock = new MockKVProvider();
repositoryContract('mock', () => mock);

describe.skipIf(!dockerAvailable)('valkey', () => {
	const container = `fluxer-tablegame-${process.pid.toString(36)}-${Date.now().toString(36)}`;
	let client: KVClient | null = null;

	beforeAll(async () => {
		const port = await freePort();
		startDockerContainer([
			'run',
			'-d',
			'--name',
			container,
			'-p',
			`127.0.0.1:${port}:6379`,
			'valkey/valkey:9.1-alpine',
		]);
		for (let attempt = 0; attempt < 120; attempt++) {
			const probe = spawnSync('docker', ['exec', container, 'valkey-cli', 'ping'], {encoding: 'utf8'});
			if (probe.stdout?.trim() === 'PONG') break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		client = new KVClient(`redis://127.0.0.1:${port}`);
	}, 300_000);

	afterAll(() => {
		client?.close();
		spawnSync('docker', ['rm', '-f', container], {stdio: 'ignore'});
	});

	repositoryContract('valkey', () => {
		if (!client) throw new Error('valkey client is not ready');
		return client;
	});
});

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'string' || address === null) {
				reject(new Error('no port'));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}
