// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW, type RelationshipRow} from '@app/api/database/types/UserTypes';
import * as ServiceRegistry from '@app/api/middleware/ServiceRegistry';
import {getCacheService, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {Relationship} from '@app/api/models/Relationship';
import {User} from '@app/api/models/User';
import {UsernameClaims} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {UserRelationshipRequestService} from '@app/api/user/services/UserRelationshipRequestService';
import {UserRelationshipService} from '@app/api/user/services/UserRelationshipService';
import {UsernameOwnershipRepository} from '@app/api/user/username/UsernameOwnershipRepository';
import {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {UserPermissionUtils} from '@app/api/utils/UserPermissionUtils';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {FriendRequestByTagRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {Hono} from 'hono';
import {afterEach, expect, test, vi} from 'vitest';

const transport = vi.hoisted(() => ({post: vi.fn()}));
vi.mock('../../../../../fluxer_app/src/features/platform/transport/RestTransport', () => ({http: transport}));
vi.mock('../../../../../fluxer_app/src/features/app/constants/Endpoints', () => ({
	Endpoints: {USER_RELATIONSHIPS: '/users/@me/relationships'},
}));
vi.mock('../../../../../fluxer_app/src/features/platform/utils/AppLogger', () => ({
	Logger: class {
		error() {}
	},
}));

afterEach(() => {
	vi.restoreAllMocks();
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});

test.each(['ayse', '@ayse', 'Ayse#1234'])(
	'client %s reaches the real friend service with selected/legacy resolution',
	async (input) => {
		const commandPath = new URL(
			'../../../../../fluxer_app/src/features/relationship/commands/RelationshipCommands.ts',
			import.meta.url,
		).href;
		const parserPath = new URL('../../../../../fluxer_app/src/features/user/utils/UserTagUtils.ts', import.meta.url)
			.href;
		const {sendFriendRequestByTag} = await import(commandPath);
		const {parseUserTagInput} = await import(parserPath);
		const requesterId = createUserID(1000000000000000001n);
		const selectedId = createUserID(1000000000000000002n);
		const legacyId = createUserID(1000000000000000003n);
		const requester = new User({
			...EMPTY_USER_ROW,
			user_id: requesterId,
			username: 'requester',
			username_state: 'selected',
			discriminator: 0,
			email: 'sender@example.test',
			email_verified: true,
			password_hash: 'test-hash',
		});
		const selected = new User({
			...EMPTY_USER_ROW,
			user_id: selectedId,
			username: 'ayse',
			username_state: 'selected',
			discriminator: 0,
			email: 'selected@example.test',
			email_verified: true,
			password_hash: 'test-hash',
		});
		const legacy = new User({
			...EMPTY_USER_ROW,
			user_id: legacyId,
			username: 'Ayse',
			discriminator: 1234,
			email: 'legacy@example.test',
			email_verified: true,
			password_hash: 'test-hash',
		});
		const users = new Map([
			[requesterId, requester],
			[selectedId, selected],
			[legacyId, legacy],
		]);
		const rows: Array<RelationshipRow> = [];
		const lookup = vi.fn(
			async (name: string, discriminator: number) =>
				[...users.values()].find((user) => user.username === name && user.discriminator === discriminator) ?? null,
		);
		const repository = {
			findUnique: async (id: typeof requesterId) => users.get(id) ?? null,
			findByUsernameDiscriminator: lookup,
			getRelationship: async () => null,
			findSettings: async () => null,
			hasReachedRelationshipLimit: async () => false,
			upsertRelationship: async (row: RelationshipRow) => {
				rows.push(row);
				return new Relationship(row);
			},
		};
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		await executeQuery(
			UsernameClaims.upsertAll({
				username: 'ayse',
				state: 'assigned',
				user_id: selectedId,
				owned_gen: 1n,
				op_id: null,
				prev_state: null,
				prev_blocked_until: null,
				from_hold: false,
				held_by: null,
				updated_at: new Date(),
				blocked_until: null,
				note: null,
				index_ts: 0n,
				version: 1,
			}),
		);
		const claims = new UsernameOwnershipRepository();
		const readClaim = vi.spyOn(claims, 'readClaim');
		const ownership = new UsernameOwnershipService({
			repository: claims,
			policy: {} as never,
			propagate: async () => {},
			neutralDiscriminator: async () => 1234,
		});
		vi.spyOn(ServiceRegistry, 'getUsernameOwnershipService').mockReturnValue(ownership);
		vi.spyOn(getCacheService(), 'get').mockResolvedValue(null);
		vi.spyOn(getInstanceConfigRepository(), 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'selecting',
			epoch: 1,
			started_at: null,
			forced_at: null,
		});
		vi.spyOn(getInstanceConfigRepository(), 'getInstancePolicyConfig').mockResolvedValue({
			direct_messages_disabled: false,
		} as never);
		const gateway = {dispatchPresence: vi.fn(async () => {})};
		const cache = {
			getUserPartialResponse: async (id: typeof requesterId) => ({
				id: id.toString(),
				username: users.get(id)!.username,
				discriminator: users.get(id)!.discriminator.toString().padStart(4, '0'),
			}),
		};
		const service = new UserRelationshipService(
			{services: {users: repository, gateway}} as never,
			new UserPermissionUtils(repository as never, {} as never),
			{getConfigSnapshot: () => ({traitDefinitions: [], rules: []})} as never,
		);
		const requestService = new UserRelationshipRequestService(service, {} as never, cache as never);
		const app = new Hono();
		app.post('/users/@me/relationships', async (ctx) =>
			ctx.json(
				await requestService.sendFriendRequestByTag({
					userId: requesterId,
					data: FriendRequestByTagRequest.parse(await ctx.req.json()),
					requestCache: {} as never,
				}),
			),
		);
		let body: Record<string, unknown> = {};
		transport.post.mockImplementation(async (url: string, options: {body: Record<string, unknown>}) => {
			body = JSON.parse(JSON.stringify(options.body));
			const response = await app.request(url, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
			return {body: await response.json()};
		});
		const parsed = parseUserTagInput(input)!;
		await sendFriendRequestByTag(parsed[0], parsed[1]);
		const tagged = input.includes('#');
		expect(body).toEqual(tagged ? {username: 'Ayse', discriminator: '1234'} : {username: 'ayse'});
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			source_user_id: requesterId,
			target_user_id: tagged ? legacyId : selectedId,
			type: RelationshipTypes.OUTGOING_REQUEST,
		});
		expect(rows[1]).toMatchObject({
			source_user_id: tagged ? legacyId : selectedId,
			target_user_id: requesterId,
			type: RelationshipTypes.INCOMING_REQUEST,
		});
		if (tagged) {
			expect(lookup).toHaveBeenCalledWith('Ayse', 1234);
			expect(readClaim).not.toHaveBeenCalled();
		} else {
			expect(readClaim).toHaveBeenCalledWith('ayse');
			expect(lookup).not.toHaveBeenCalled();
		}
		expect(gateway.dispatchPresence).toHaveBeenCalledTimes(2);
	},
);
