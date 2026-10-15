// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {User} from '@app/api/models/User';
import type {UserSettings} from '@app/api/models/UserSettings';
import {decideProfileView} from '@app/api/user/profile/ProfileAccessRules';
import {resolveProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {calculateAge} from '@app/api/utils/AgeUtils';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {
	type GameActivityGrant,
	GameActivityGrantsResponse,
	GameActivityPairPolicyAck,
	GameActivityPolicyAck,
	GameActivityPolicyState,
} from '@fluxer/schema/src/domains/rpc/RpcSchemas';

export const GAME_ACTIVITY_MIN_AGE = 15;

export type GameActivityAccount = Pick<User, 'isBot' | 'isSystem' | 'dateOfBirth'>;
type GameActivityVisibility = NonNullable<UserSettings['gameActivityVisibility']>;

export function isGameActivityEligible(user: Pick<User, 'isBot' | 'isSystem' | 'dateOfBirth'>): boolean {
	if (user.isBot || user.isSystem || !user.dateOfBirth) return false;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(user.dateOfBirth);
	if (!match) return false;
	const [, year, month, day] = match.map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day &&
		calculateAge(user.dateOfBirth) >= GAME_ACTIVITY_MIN_AGE
	);
}

export function effectiveGameActivityVisibility(
	user: GameActivityAccount | null,
	settings: UserSettings | null,
): GameActivityVisibility {
	if (!user || !settings || !isGameActivityEligible(user)) return 'off';
	if (settings.gameActivityVisibilitySource === 'default') return settings.gameActivityVisibility ?? 'everyone';
	if (settings.gameActivityVisibilitySource === 'user') return settings.gameActivityVisibility ?? 'off';
	return settings.gameActivityVisibility === 'friends' ? 'friends' : 'off';
}

export function isGameActivityDefaultPending(user: GameActivityAccount | null, settings: UserSettings | null): boolean {
	return !!user && !!settings && settings.gameActivityVisibilitySource == null && isGameActivityEligible(user);
}

export function gameActivityPolicyState(
	user: Pick<User, 'isBot' | 'isSystem' | 'dateOfBirth'>,
	settings: UserSettings | null,
) {
	return GameActivityPolicyState.parse({
		policy_revision: (settings?.gameActivityPolicyRevision ?? 0n).toString(),
		visibility: effectiveGameActivityVisibility(user, settings),
		eligible_16_plus: isGameActivityEligible(user),
		effective_profile_audience: resolveProfileAudience(settings?.profilePrivacy, user.dateOfBirth),
	});
}

export type GameActivityPolicyFence = Pick<GameActivityPolicyAck, 'request_id' | 'owner_epoch' | 'policy_revision'>;
export interface GameActivityPairFence extends GameActivityPairPolicyAck {
	owner_id: string;
	viewer_id: string;
}

interface GameActivityPolicyDeps {
	users: Pick<UserRepository, 'findUnique' | 'findSettings' | 'getRelationship' | 'getIncomingRelationship'>;
	gateway: Pick<IGatewayService, 'gameActivityPolicy' | 'gameActivityPairPolicy'>;
}

export class GameActivityPolicyService {
	constructor(private readonly deps: GameActivityPolicyDeps) {}

	async getGrants(viewerId: UserID, targets: Array<UserID>, requestNonce: string) {
		if (targets.length < 1 || targets.length > 100 || !requestNonce || requestNonce.length > 128)
			throw new Error('Invalid game activity grant batch');
		const viewer = await this.deps.users.findUnique(viewerId);
		const grants: Array<GameActivityGrant> = [];
		for (let offset = 0; offset < targets.length; offset += 10) {
			grants.push(
				...(await Promise.all(
					targets.slice(offset, offset + 10).map(async (ownerId) => {
						const [owner, settings, outwardFriend, inwardFriend, outwardBlock, inwardBlock] = await Promise.all([
							this.deps.users.findUnique(ownerId),
							this.deps.users.findSettings(ownerId, {authoritative: true}),
							this.deps.users.getRelationship(viewerId, ownerId, RelationshipTypes.FRIEND),
							this.deps.users.getRelationship(ownerId, viewerId, RelationshipTypes.FRIEND),
							this.deps.users.getRelationship(viewerId, ownerId, RelationshipTypes.BLOCKED),
							this.deps.users.getIncomingRelationship(viewerId, ownerId, RelationshipTypes.BLOCKED),
						]);
						const state = owner
							? gameActivityPolicyState(owner, settings)
							: ({
									policy_revision: '0',
									visibility: 'off',
									eligible_16_plus: false,
									effective_profile_audience: 'only_me',
								} as const);
						const friend = outwardFriend !== null && inwardFriend !== null && viewerId !== ownerId;
						const blocked = outwardBlock !== null || inwardBlock !== null;
						const profileView = owner
							? decideProfileView({
									audience: state.effective_profile_audience,
									bond: friend ? 'close' : 'none',
									blocked,
									bot: owner.isBot,
									strangerOk: false,
								})
							: null;
						return {
							owner_id: ownerId.toString(),
							policy_revision: state.policy_revision,
							eligible_16_plus: state.eligible_16_plus,
							effective_profile_audience: state.effective_profile_audience,
							friend,
							blocked,
							profile_view: profileView,
							allowed:
								!!viewer &&
								!viewer.isBot &&
								!viewer.isSystem &&
								(state.visibility === 'friends' || state.visibility === 'everyone') &&
								state.eligible_16_plus &&
								friend &&
								!blocked &&
								profileView === 'full',
						};
					}),
				)),
			);
		}
		return GameActivityGrantsResponse.parse({request_nonce: requestNonce, grants});
	}

	async fenceUserPolicy(
		userId: UserID,
		_currentSettings: UserSettings | null,
		options?: {recoverable?: boolean; expectedPolicyRevision?: bigint},
	): Promise<GameActivityPolicyFence> {
		const [user, currentSettings] = await Promise.all([
			this.deps.users.findUnique(userId),
			this.deps.users.findSettings(userId, {authoritative: true}),
		]);
		if (!user) throw new UnknownUserError();
		if (
			options?.expectedPolicyRevision !== undefined &&
			(currentSettings?.gameActivityPolicyRevision ?? 0n) !== options.expectedPolicyRevision
		)
			throw new ServiceUnavailableError();
		const request = {
			user_id: userId.toString(),
			owner_epoch: null,
			phase: 'fence' as const,
			request_id: randomUUID(),
			recoverable: options?.recoverable === true,
			...gameActivityPolicyState(user, currentSettings),
		};
		const ack = GameActivityPolicyAck.parse(await this.deps.gateway.gameActivityPolicy(request));
		if (
			ack.request_id !== request.request_id ||
			ack.phase !== 'fence' ||
			ack.policy_revision !== request.policy_revision
		)
			throw new Error('Game activity fence acknowledgement mismatch');
		return ack;
	}

	async applyUserPolicy(userId: UserID, fence: GameActivityPolicyFence, settings: UserSettings | null): Promise<void> {
		const user = await this.deps.users.findUnique(userId);
		if (!user) throw new UnknownUserError();
		const request = {
			user_id: userId.toString(),
			owner_epoch: fence.owner_epoch,
			request_id: fence.request_id,
			phase: 'apply' as const,
			...gameActivityPolicyState(user, settings),
		};
		const ack = GameActivityPolicyAck.parse(await this.deps.gateway.gameActivityPolicy(request));
		if (
			ack.request_id !== request.request_id ||
			ack.policy_revision !== request.policy_revision ||
			ack.phase !== 'apply'
		)
			throw new Error('Game activity apply acknowledgement mismatch');
	}

	async fencePair(userId: UserID, targetId: UserID): Promise<Array<GameActivityPairFence>> {
		return Promise.all(
			[
				[userId, targetId],
				[targetId, userId],
			].map(async ([owner, viewer]) => {
				const request = {
					owner_id: owner.toString(),
					viewer_id: viewer.toString(),
					phase: 'fence' as const,
					request_id: randomUUID(),
				};
				const ack = GameActivityPairPolicyAck.parse(await this.deps.gateway.gameActivityPairPolicy(request));
				if (ack.request_id !== request.request_id || ack.phase !== 'fence')
					throw new Error('Game activity pair fence acknowledgement mismatch');
				return {...ack, owner_id: request.owner_id, viewer_id: request.viewer_id};
			}),
		);
	}

	async applyPair(fences: Array<GameActivityPairFence>): Promise<void> {
		await Promise.all(
			fences.map(async (fence) => {
				const ownerId = createUserID(BigInt(fence.owner_id));
				const viewerId = createUserID(BigInt(fence.viewer_id));
				const [outwardBlock, inwardBlock] = await Promise.all([
					this.deps.users.getRelationship(viewerId, ownerId, RelationshipTypes.BLOCKED),
					this.deps.users.getIncomingRelationship(viewerId, ownerId, RelationshipTypes.BLOCKED),
				]);
				const request = {
					owner_id: fence.owner_id,
					viewer_id: fence.viewer_id,
					phase: 'apply' as const,
					request_id: fence.request_id,
					owner_epoch: fence.owner_epoch,
					pair_generation: fence.pair_generation,
					blocked: outwardBlock !== null || inwardBlock !== null,
				};
				const ack = GameActivityPairPolicyAck.parse(await this.deps.gateway.gameActivityPairPolicy(request));
				if (
					ack.request_id !== fence.request_id ||
					ack.owner_epoch !== fence.owner_epoch ||
					ack.pair_generation !== fence.pair_generation ||
					ack.phase !== 'apply'
				)
					throw new Error('Game activity pair apply acknowledgement mismatch');
			}),
		);
	}
}
