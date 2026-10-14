// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {NatsUsersServiceClient} from '@app/api/infrastructure/UsersServiceClient';
import type {NatsConnection} from '@nats-io/transport-node';
import type {INatsConnectionManager} from '@pkgs/nats/src/INatsConnectionManager';
import {describe, expect, it} from 'vitest';

class WireManager implements INatsConnectionManager {
	readonly requests: Array<string> = [];
	constructor(private readonly responses: Array<string | Error>) {}
	async connect(): Promise<void> {}
	async drain(): Promise<void> {}
	isClosed(): boolean {
		return false;
	}
	getConnection(): NatsConnection {
		return {
			request: async (_subject: string, bytes: Uint8Array) => {
				this.requests.push(new TextDecoder().decode(bytes));
				const reply = this.responses.shift();
				if (reply instanceof Error) throw reply;
				return {data: new TextEncoder().encode(reply)};
			},
		} as unknown as NatsConnection;
	}
}

const id = createUserID(1174109840998400002n);
const other = createUserID(1174109840998400003n);
const since = 1720000000000;
const reply = (userId = id, cutoff: number | null = since) =>
	`{"FoundPartials":[{"user_id":${userId},"content_hidden_since":${cutoff}}]}`;
function lookup(client: NatsUsersServiceClient, ids: Array<UserID>): Promise<Map<UserID, Date | null>> {
	return (
		client as NatsUsersServiceClient & {getContentHiddenSince(ids: Array<UserID>): Promise<Map<UserID, Date | null>>}
	).getContentHiddenSince(ids);
}

describe('private users content visibility wire boundary', () => {
	it('preserves exact numeric snowflakes beyond 2^53 in both directions', async () => {
		const manager = new WireManager([reply()]);
		const result = await lookup(new NatsUsersServiceClient(manager), [id, id]);
		expect(manager.requests).toEqual([`{"op":"GetPartialsByIds","user_ids":[${id}]}`]);
		expect(result).toEqual(new Map([[id, new Date(since)]]));
	});
	it('accepts baseline omitted/null cutoff and leaves absent users absent', async () => {
		const manager = new WireManager([`{"FoundPartials":[{"user_id":${id}}]}`, reply(id, null), '{"FoundPartials":[]}']);
		const client = new NatsUsersServiceClient(manager);
		expect(await lookup(client, [id])).toEqual(new Map([[id, null]]));
		expect(await lookup(client, [id])).toEqual(new Map([[id, null]]));
		expect(await lookup(client, [id])).toEqual(new Map());
	});
	it.each([0n, -1n, 9223372036854775808n])('rejects invalid internal request id %s before I/O', async (value) => {
		const manager = new WireManager([]);
		await expect(lookup(new NatsUsersServiceClient(manager), [createUserID(value)])).rejects.toThrow();
		expect(manager.requests).toEqual([]);
	});
	it.each([
		`{"FoundPartials":[{"user_id":"${id}"}]}`,
		'{"FoundPartials":[{"user_id":1.25}]}',
		'{"FoundPartials":[{"user_id":1e18}]}',
		'{"FoundPartials":[{"user_id":9223372036854775808}]}',
		reply(other),
		`{"FoundPartials":[{"user_id":${id}},{"user_id":${id}}]}`,
		`{"FoundPartials":[{"user_id":${id},"content_hidden_since":"${since}"}]}`,
		`{"FoundPartials":[{"user_id":${id},"content_hidden_since":9007199254740993}]}`,
		`{"FoundPartials":[{"user_id":${id},"content_hidden_since":1.5}]}`,
		'{"FoundPartials":{}}',
		'not-json',
	])('rejects malformed or unrequested metadata %#', async (wire) => {
		await expect(lookup(new NatsUsersServiceClient(new WireManager([wire])), [id])).rejects.toThrow();
	});
	it('coalesces overlapping requests and retries failures without a completed cache', async () => {
		const manager = new WireManager([reply(), new Error('timeout'), reply(id, null)]);
		const client = new NatsUsersServiceClient(manager);
		const [first, second] = await Promise.all([lookup(client, [id]), lookup(client, [id])]);
		expect(first).toEqual(second);
		expect(manager.requests).toHaveLength(1);
		await expect(lookup(client, [id])).rejects.toThrow('timeout');
		expect(await lookup(client, [id])).toEqual(new Map([[id, null]]));
		expect(manager.requests).toHaveLength(3);
	});

	it('bounds metadata batches even when inflight coalescing is disabled', async () => {
		const manager = new WireManager(['{"FoundPartials":[]}', '{"FoundPartials":[]}']);
		const ids = Array.from({length: 1001}, (_, index) => createUserID(BigInt(index + 1)));
		expect(await lookup(new NatsUsersServiceClient(manager, 6000, 'svc.users', 0), ids)).toEqual(new Map());
		expect(manager.requests.map((wire) => (JSON.parse(wire) as {user_ids: Array<number>}).user_ids.length)).toEqual([
			1000, 1,
		]);
	});
});
