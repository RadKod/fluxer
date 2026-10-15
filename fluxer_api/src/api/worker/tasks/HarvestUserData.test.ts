// SPDX-License-Identifier: AGPL-3.0-or-later

import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	type ChannelID,
	createChannelID,
	createGuildID,
	createMessageID,
	createUserID,
	type GuildID,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {ThreadMember} from '@app/api/models/ThreadMember';
import {User} from '@app/api/models/User';
import {mapStorePurchaseToResponse} from '@app/api/store_billing/StoreBillingMappers';
import {buildStorePurchaseRow} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import * as harvestTask from '@app/api/worker/tasks/HarvestUserData';
import {buildUserDataJson, collectThreadMemberships, harvestMessages} from '@app/api/worker/tasks/HarvestUserData';
import {createArchiveJsonBuffer} from '@app/api/worker/utils/ArchiveJson';
import {afterEach, describe, expect, it, vi} from 'vitest';

const tainted = vi.hoisted(() => new Set<string>());

vi.mock('@app/api/experiment/ChannelThreadsGate', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/api/experiment/ChannelThreadsGate')>()),
	isTainted: async (guildId: bigint) => tainted.has(guildId.toString()),
}));

const AUTHOR = createUserID(1000000000000000000n);

function makeRepository(refs: Array<{channelId: ChannelID; messageId: MessageID}>, missing = new Set<string>()) {
	let pages = 0;
	return {
		pages: () => pages,
		listMessagesByAuthor: async (_userId: typeof AUTHOR, limit: number, lastMessageId?: MessageID) => {
			pages++;
			const start = lastMessageId ? refs.findIndex((r) => r.messageId === lastMessageId) + 1 : 0;
			return refs.slice(start, start + limit);
		},
		getMessage: async (_channelId: ChannelID, messageId: MessageID) =>
			missing.has(messageId.toString()) ? null : {content: `body ${messageId.toString()}`, attachments: undefined},
	};
}

function refsAcross(channelCount: number, perChannel: number) {
	const out: Array<{channelId: ChannelID; messageId: MessageID}> = [];
	let id = 1500000000000000000n;
	for (let c = 0; c < channelCount; c++) {
		const channelId = createChannelID(2000000000000000000n + BigInt(c));
		for (let m = 0; m < perChannel; m++) {
			out.push({channelId, messageId: createMessageID(id)});
			id += 1n;
		}
	}
	return out;
}

describe('harvestMessages', () => {
	it('reads past a single page instead of stopping at one query', async () => {
		const refs = refsAcross(1, 2500);
		const repo = makeRepository(refs);
		const result = await harvestMessages(repo, AUTHOR, Date.now(), null);
		expect(result.totalMessages).toBe(2500);
		expect(repo.pages()).toBeGreaterThan(1);
	});

	it('groups every message under its own channel', async () => {
		const repo = makeRepository(refsAcross(3, 4));
		const result = await harvestMessages(repo, AUTHOR, Date.now(), null);
		expect(result.channelMessagesMap.size).toBe(3);
		for (const messages of result.channelMessagesMap.values()) {
			expect(messages).toHaveLength(4);
		}
		expect(result.totalMessages).toBe(12);
	});

	it('leaves out a message the repository cannot return', async () => {
		const refs = refsAcross(1, 5);
		const repo = makeRepository(refs, new Set([refs[2].messageId.toString()]));
		const result = await harvestMessages(repo, AUTHOR, Date.now(), null);
		expect(result.totalMessages).toBe(4);
	});

	it('returns an empty map for an account with no messages', async () => {
		const repo = makeRepository([]);
		const result = await harvestMessages(repo, AUTHOR, Date.now(), null);
		expect(result.totalMessages).toBe(0);
		expect(result.channelMessagesMap.size).toBe(0);
	});
});

function userDataParams(overrides: Partial<Parameters<typeof buildUserDataJson>[0]> = {}) {
	return {
		user: new User({...EMPTY_USER_ROW, user_id: AUTHOR, username: 'exporter', discriminator: 1}),
		userId: AUTHOR,
		productName: 'Fluxer',
		authSessions: [],
		relationships: [],
		userNotes: new Map(),
		userSettings: null,
		guildMemberships: [],
		guildSettings: [],
		savedMessages: [],
		privateChannels: [],
		favoriteMemes: [],
		pushSubscriptions: [],
		webAuthnCredentials: [],
		mfaBackupCodes: [],
		recoveryKitCreatedAt: null,
		createdGiftCodes: [],
		payments: [],
		storePurchases: [],
		threadMemberships: [],
		oauthClients: [],
		connections: [],
		pinnedDms: [],
		authorizedIps: [],
		activityData: {last_active_at: null, last_active_ip: null},
		...overrides,
	};
}

describe('buildUserDataJson', () => {
	it('exports the store purchases in their public shape', () => {
		const purchase = buildStorePurchaseRow({user_id: AUTHOR});
		const data = buildUserDataJson(userDataParams({storePurchases: [purchase]}));
		expect(data.store_purchases).toEqual([mapStorePurchaseToResponse(purchase)]);
	});

	it('exports when the recovery kit was created and nothing else about it', () => {
		const createdAt = new Date('2026-10-01T12:00:00.000Z');
		const data = buildUserDataJson(userDataParams({recoveryKitCreatedAt: createdAt}));
		expect(data.recovery_kit).toEqual({created_at: '2026-10-01T12:00:00.000Z'});
	});

	it('leaves the recovery kit out when the account has none', () => {
		const data = buildUserDataJson(userDataParams());
		expect('recovery_kit' in data).toBe(false);
	});

	it('exports the stored name style and profile theme even without active Plus', () => {
		const user = new User({
			...EMPTY_USER_ROW,
			user_id: AUTHOR,
			username: 'exporter',
			discriminator: 1,
			premium_type: null,
			name_font: 6,
			name_color: 0xffffff,
			name_color_2: null,
			theme_primary_color: 0,
			theme_accent_color: 0x07a3b2,
		});
		const data = buildUserDataJson(userDataParams({user}));
		expect(data.user).toMatchObject({
			name_font: 6,
			name_color: 0xffffff,
			name_color_2: null,
			theme_primary_color: 0,
			theme_accent_color: 0x07a3b2,
		});
	});
});

describe('collectThreadMemberships', () => {
	const guildId = createGuildID(1400000000000000000n);
	const threadId = createChannelID(1400000000000000010n);
	const member = new ThreadMember({
		thread_id: threadId,
		user_id: AUTHOR,
		guild_id: guildId,
		parent_id: createChannelID(1400000000000000001n),
		join_timestamp: new Date('2026-09-27T00:00:00.000Z'),
		flags: 1,
		muted: false,
		mute_config: null,
	});
	let reads = 0;
	const threads = {
		listJoinedThreadIdsPage: async (_userId: UserID, id: GuildID) => {
			reads++;
			return {threadIds: id === guildId ? [threadId] : [], cursor: null};
		},
		getMember: async () => member,
	};
	afterEach(() => {
		reads = 0;
		tainted.clear();
	});

	it('collects the joined thread memberships of every tainted guild and skips the rest', async () => {
		tainted.add(guildId.toString());
		const collected: Array<ThreadMember> = [];
		await collectThreadMemberships(threads, AUTHOR, [guildId, createGuildID(1400000000000000002n)], async (page) => {
			collected.push(...page);
		});
		expect(collected).toEqual([member]);
		expect(reads).toBe(1);
	});

	function pagedThreads(
		count: number,
		readMember = async (id: ChannelID) => new ThreadMember({...member.toRow(), thread_id: id}),
	) {
		const ids = Array.from({length: count}, (_, index) => createChannelID(threadId + BigInt(index)));
		const cursors: Array<string | null | undefined> = [];
		return {
			cursors,
			listJoinedThreadIds: async () => ids,
			listJoinedThreadIdsPage: async (
				_userId: UserID,
				_guildId: GuildID,
				opts: {limit: number; cursor?: string | null},
			) => {
				cursors.push(opts.cursor);
				const start = Number(opts.cursor ?? 0);
				const end = Math.min(start + opts.limit, ids.length);
				return {threadIds: ids.slice(start, end), cursor: end < ids.length ? String(end) : null};
			},
			getMember: async (id: ChannelID) => readMember(id),
		};
	}

	it('emits a large membership history in bounded pages with an opaque cursor', async () => {
		tainted.add(guildId.toString());
		const repo = pagedThreads(2505);
		const pages: Array<Array<ThreadMember>> = [];
		await collectThreadMemberships(repo, AUTHOR, [guildId], async (page) => {
			pages.push(page);
		});
		expect(pages.map((page) => page.length)).toEqual([1000, 1000, 505]);
		expect(repo.cursors).toEqual([undefined, '1000', '2000']);
		expect(pages.flat().map((entry) => entry.threadId)).toEqual(
			Array.from({length: 2505}, (_, index) => createChannelID(threadId + BigInt(index))),
		);
	});

	it('shares one read concurrency bound across simultaneous exports', async () => {
		tainted.add(guildId.toString());
		let active = 0;
		let maximum = 0;
		let count = 0;
		const repo = pagedThreads(1050, async (id) => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active--;
			return new ThreadMember({...member.toRow(), thread_id: id});
		});
		await Promise.all(
			Array.from({length: 3}, () =>
				collectThreadMemberships(repo, AUTHOR, [guildId], async (page) => {
					count += page.length;
				}),
			),
		);
		expect(maximum).toBeLessThanOrEqual(10);
		expect(count).toBe(3150);
	});

	it('awaits each output page before reading the next page', async () => {
		tainted.add(guildId.toString());
		const repo = pagedThreads(2001);
		let outputPages = 0;
		await collectThreadMemberships(repo, AUTHOR, [guildId], async () => {
			outputPages++;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(repo.cursors).toHaveLength(outputPages);
		});
		expect(outputPages).toBe(3);
	});

	it('follows a cursor even when Cassandra returns an empty intermediate page', async () => {
		tainted.add(guildId.toString());
		const repo = pagedThreads(1);
		repo.listJoinedThreadIdsPage = async (_userId, _guildId, opts) =>
			opts.cursor ? {threadIds: [threadId], cursor: null} : {threadIds: [], cursor: 'resume'};
		const output: Array<ThreadMember> = [];
		await collectThreadMemberships(repo, AUTHOR, [guildId], async (page) => {
			output.push(...page);
		});
		expect(output).toEqual([member]);
	});

	it('releases the shared read slots after a membership read fails', async () => {
		tainted.add(guildId.toString());
		const broken = pagedThreads(30, async () => {
			throw new Error('membership read failed');
		});
		await expect(collectThreadMemberships(broken, AUTHOR, [guildId], async () => {})).rejects.toThrow(
			'membership read failed',
		);
		let count = 0;
		await collectThreadMemberships(pagedThreads(30), AUTHOR, [guildId], async (page) => {
			count += page.length;
		});
		expect(count).toBe(30);
	});

	it('stages paged memberships in user.json with the existing JSON shape and ASCII escaping', async () => {
		tainted.add(guildId.toString());
		expect(typeof harvestTask.writeUserDataJson).toBe('function');
		const directory = await mkdtemp(path.join(os.tmpdir(), 'fluxer-harvest-test-'));
		try {
			const file = path.join(directory, 'user.json');
			const metadata = buildUserDataJson(userDataParams());
			metadata.user.username = 'çağrı';
			await harvestTask.writeUserDataJson(file, createArchiveJsonBuffer(metadata), threads, AUTHOR, [guildId]);
			const text = await readFile(file, 'utf8');
			expect(text).toMatch(/\\u00e7/);
			expect(JSON.parse(text)).toEqual({
				...metadata,
				thread_memberships: [
					{
						thread_id: threadId.toString(),
						guild_id: guildId.toString(),
						parent_id: member.parentId.toString(),
						join_timestamp: member.joinTimestamp.toISOString(),
						flags: member.flags,
						muted: member.muted,
					},
				],
			});
		} finally {
			await rm(directory, {recursive: true, force: true});
		}
	});

	it('omits an empty membership array and closes the staged file after a read failure', async () => {
		tainted.add(guildId.toString());
		expect(typeof harvestTask.writeUserDataJson).toBe('function');
		const directory = await mkdtemp(path.join(os.tmpdir(), 'fluxer-harvest-test-'));
		try {
			const file = path.join(directory, 'user.json');
			const metadata = buildUserDataJson(userDataParams());
			await harvestTask.writeUserDataJson(file, createArchiveJsonBuffer(metadata), pagedThreads(0), AUTHOR, [guildId]);
			expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(metadata);
			const broken = pagedThreads(1, async () => {
				throw new Error('membership unavailable');
			});
			await expect(
				harvestTask.writeUserDataJson(file, createArchiveJsonBuffer(metadata), broken, AUTHOR, [guildId]),
			).rejects.toThrow('membership unavailable');
		} finally {
			await rm(directory, {recursive: true, force: true});
		}
	});
});
