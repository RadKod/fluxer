// SPDX-License-Identifier: AGPL-3.0-or-later
import type {UserID} from '@app/api/BrandedTypes';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import {getDiscriminatorService, getUserCacheService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {BaseUserUpdatePropagator} from '@app/api/user/services/BaseUserUpdatePropagator';
import {propagatePartialUserChange} from '@app/api/user/services/PartialUserChangePropagation';
import {
	UsernameOwnershipService,
	UsernameOwnershipUnavailableError,
} from '@app/api/user/username/UsernameOwnershipService';
import {UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {enqueueUsernameReindex} from '@app/api/worker/tasks/ReindexUserGuildMembers';
import {UsernameAdmission, type UsernameScriptExecutor} from '@app/api/worker/tasks/UsernameAdmission';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

interface PropagationDependencies {
	readUser: (userId: UserID) => Promise<User | null>;
	dispatchUserUpdate: (user: User) => Promise<void>;
	propagatePartialUserChange: (user: User) => Promise<void>;
	enqueue: (userId: UserID, generation: bigint) => Promise<void>;
}

export async function propagateUsernameOwnership(deps: PropagationDependencies, userId: UserID): Promise<void> {
	const user = await deps.readUser(userId);
	if (!user) throw new UsernameOwnershipUnavailableError();
	await deps.dispatchUserUpdate(user);
	await deps.propagatePartialUserChange(user);
	// Micup: keep the reindex job generation tied to the dispatched projection during concurrent renames.
	await deps.enqueue(userId, user.identityVersion);
}

export function createUsernameOwnershipRuntime(deps: {
	kv: UsernameScriptExecutor;
	worker: IWorkerService;
}): UsernameOwnershipService {
	if (!deps.kv || !deps.worker || typeof deps.worker.addJob !== 'function' || typeof deps.kv.evalScript !== 'function')
		throw new UsernameOwnershipUnavailableError();
	const admission = new UsernameAdmission(deps.kv);
	const policy = new UsernamePolicyService();
	const service = new UsernameOwnershipService({
		policy,
		admit: (snapshot) => admission.admit(snapshot),
		propagate: (userId) =>
			propagateUsernameOwnership(
				{
					readUser: (id) => getUserRepository().findUnique(id),
					dispatchUserUpdate: (user) =>
						new BaseUserUpdatePropagator({
							userCacheService: getUserCacheService(),
							gatewayService: getGatewayService(),
						}).dispatchUserUpdate(user),
					propagatePartialUserChange: (user) =>
						propagatePartialUserChange({userCacheService: getUserCacheService(), usernameOwnership: true}, user),
					enqueue: (id, generation) => enqueueUsernameReindex(deps.worker, id, generation),
				},
				userId,
			),
		neutralDiscriminator: async (userId) => {
			// Micup: TEMPORARY shared native discriminator pool; approved per-user neutral identity must replace it before exhaustion.
			const user = await getUserRepository().findUnique(userId);
			if (!user) throw new UsernameOwnershipUnavailableError();
			const result = await getDiscriminatorService().generateDiscriminator({username: 'kullanici', user});
			if (!result.available || !Number.isInteger(result.discriminator) || result.discriminator <= 0)
				throw new UsernameOwnershipUnavailableError();
			return result.discriminator;
		},
	});
	return service;
}
