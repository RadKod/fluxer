// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {type ApplicationID, createApplicationID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {BatchBuilder, fetchMany, fetchOne} from '@app/api/database/CassandraQueryExecution';
import {buildPatchFromData, executeVersionedUpdate} from '@app/api/database/CassandraVersionedUpdate';
import type {ApplicationByOwnerRow, ApplicationRow} from '@app/api/database/types/OAuth2Types';
import {APPLICATION_COLUMNS} from '@app/api/database/types/OAuth2Types';
import {INSTANCE_CONFIG_REFRESH_CHANNEL, InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {
	OFFICIAL_APP_RESTRICTIVE_WRITE_DELAY_MS,
	officialAppEligibilityLeaseKey,
	officialAppMutationKey,
} from '@app/api/instance/OfficialAppsEligibilityConstants';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {Application} from '@app/api/models/Application';
import type {IApplicationRepository} from '@app/api/oauth/repositories/IApplicationRepository';
import {Applications, ApplicationsByOwner} from '@app/api/Tables';
import {hashPassword} from '@app/api/utils/PasswordUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ADMIN_OAUTH2_APPLICATION_ID} from '@fluxer/constants/src/Core';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {ForbiddenError} from '@fluxer/errors/src/domains/core/ForbiddenError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export {officialAppMutationKey} from '@app/api/instance/OfficialAppsEligibilityConstants';

const SELECT_APPLICATION_CQL = Applications.selectCql({
	where: Applications.where.eq('application_id'),
});
const SELECT_APPLICATION_IDS_BY_OWNER_CQL = ApplicationsByOwner.selectCql({
	columns: ['application_id'],
	where: ApplicationsByOwner.where.eq('owner_user_id'),
});
const FETCH_APPLICATIONS_BY_IDS_CQL = Applications.selectCql({
	where: Applications.where.in('application_id', 'application_ids'),
});

let cachedAdminSecretHash: string | null = null;

export function resetAdminSecretHashForTesting(): void {
	cachedAdminSecretHash = null;
}

async function getAdminSecretHash(): Promise<string | null> {
	const secret = Config.admin.oauthClientSecret;
	if (!secret) {
		return null;
	}
	if (cachedAdminSecretHash === null) {
		cachedAdminSecretHash = await hashPassword(secret);
	}
	return cachedAdminSecretHash;
}

function getAdminRedirectUri(): string {
	return `${Config.endpoints.admin}/oauth2_callback`;
}

function buildAdminApplication(secretHash: string | null): Application {
	const row: ApplicationRow = {
		application_id: createApplicationID(ADMIN_OAUTH2_APPLICATION_ID),
		owner_user_id: SYSTEM_USER_ID,
		name: 'sanalyer Admin',
		bot_user_id: null,
		bot_is_public: false,
		bot_require_code_grant: false,
		oauth2_redirect_uris: new Set<string>([getAdminRedirectUri()]),
		client_secret_hash: secretHash,
		bot_token_hash: null,
		bot_token_preview: null,
		bot_token_created_at: null,
		client_secret_created_at: null,
		version: 1,
	};
	return new Application(row);
}

export class ApplicationRepository implements IApplicationRepository {
	constructor(private readonly provider: IKVProvider | null = getKVClient()) {}

	private async withEligibilityMutation<T>(
		applicationId: ApplicationID,
		restrictive: boolean,
		write: () => Promise<T>,
	): Promise<T> {
		const provider = this.provider;
		if (!provider) throw new ServiceUnavailableError();
		const mutationId = randomUUID();
		const key = officialAppMutationKey(applicationId.toString());
		// The lease exceeds the default Cassandra timeout; abandoned markers expire after a process crash.
		if (!(await provider.acquireLock(key, mutationId, 300))) throw new ConflictError({code: APIErrorCodes.CONFLICT});
		const errors: Array<unknown> = [];
		let result: T | undefined;
		const publish = (type: string) =>
			provider.publish(
				INSTANCE_CONFIG_REFRESH_CHANNEL,
				JSON.stringify({type, application_id: applicationId.toString(), mutation_id: mutationId}),
			);
		try {
			await publish('application_invalidate');
			const current =
				restrictive &&
				((await InstanceConfigRepository.isOfficialAppCandidate(applicationId.toString())) ||
					(await provider.get(officialAppEligibilityLeaseKey(applicationId.toString()))))
					? await this.getApplication(applicationId)
					: null;
			// Pubsub has no delivery acknowledgement: expire every public discovery lease before restricting access.
			if (current?.botIsPublic && current.botUserId !== null)
				await new Promise((resolve) => setTimeout(resolve, OFFICIAL_APP_RESTRICTIVE_WRITE_DELAY_MS));
			if ((await provider.get(key)) !== mutationId) throw new ConflictError({code: APIErrorCodes.CONFLICT});
			result = await write();
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				await provider.releaseLock(key, mutationId);
				await publish('application_refresh');
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, 'Failed to write application or refresh eligibility');
		return result as T;
	}
	async getApplication(applicationId: ApplicationID): Promise<Application | null> {
		if (applicationId === createApplicationID(ADMIN_OAUTH2_APPLICATION_ID)) {
			const secretHash = await getAdminSecretHash();
			if (secretHash === null) {
				return null;
			}
			return buildAdminApplication(secretHash);
		}
		const row = await fetchOne<ApplicationRow>(SELECT_APPLICATION_CQL, {application_id: applicationId});
		return row ? new Application(row) : null;
	}

	async listApplicationsByOwner(ownerUserId: UserID): Promise<Array<Application>> {
		const ids = await fetchMany<ApplicationByOwnerRow>(SELECT_APPLICATION_IDS_BY_OWNER_CQL, {
			owner_user_id: ownerUserId,
		});
		if (ids.length === 0) {
			return [];
		}
		const rows = await fetchMany<ApplicationRow>(FETCH_APPLICATIONS_BY_IDS_CQL, {
			application_ids: ids.map((r) => r.application_id),
		});
		return rows.map((r) => new Application(r));
	}

	async upsertApplication(data: ApplicationRow, oldData?: ApplicationRow | null): Promise<Application> {
		const applicationId = data.application_id;
		if (applicationId === createApplicationID(ADMIN_OAUTH2_APPLICATION_ID)) {
			throw new ForbiddenError({
				code: APIErrorCodes.FORBIDDEN,
				message: 'Cannot modify the built-in admin OAuth2 application',
			});
		}
		const restrictive = data.bot_is_public === false || data.bot_user_id === null;
		return this.withEligibilityMutation(applicationId, restrictive, async () => {
			const result = await executeVersionedUpdate<ApplicationRow, 'application_id'>(
				async () => fetchOne<ApplicationRow>(SELECT_APPLICATION_CQL, {application_id: applicationId}),
				(current) => ({
					pk: {application_id: applicationId},
					patch: buildPatchFromData(data, current, APPLICATION_COLUMNS, ['application_id']),
				}),
				Applications,
				{initialData: oldData},
			);
			const batch = new BatchBuilder();
			batch.addPrepared(
				ApplicationsByOwner.upsertAll({
					owner_user_id: data.owner_user_id,
					application_id: data.application_id,
				}),
			);
			if (oldData && oldData.owner_user_id !== data.owner_user_id) {
				batch.addPrepared(
					ApplicationsByOwner.deleteByPk({
						owner_user_id: oldData.owner_user_id,
						application_id: data.application_id,
					}),
				);
			}
			await batch.execute();
			return new Application({...data, version: result.finalVersion});
		});
	}

	async deleteApplication(applicationId: ApplicationID): Promise<void> {
		if (applicationId === createApplicationID(ADMIN_OAUTH2_APPLICATION_ID)) {
			throw new ForbiddenError({
				code: APIErrorCodes.FORBIDDEN,
				message: 'Cannot delete the built-in admin OAuth2 application',
			});
		}
		const applicationRow = await fetchOne<ApplicationRow>(SELECT_APPLICATION_CQL, {application_id: applicationId});
		const application = applicationRow ? new Application(applicationRow) : null;
		if (!application) {
			return;
		}
		const batch = new BatchBuilder();
		batch.addPrepared(Applications.deleteByPk({application_id: applicationId}));
		batch.addPrepared(
			ApplicationsByOwner.deleteByPk({
				owner_user_id: application.ownerUserId,
				application_id: applicationId,
			}),
		);
		await this.withEligibilityMutation(applicationId, true, () => batch.execute());
	}
}
