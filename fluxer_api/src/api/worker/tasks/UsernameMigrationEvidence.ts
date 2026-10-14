// SPDX-License-Identifier: AGPL-3.0-or-later
import type {InstanceConfigRepository, UsernamePolicyConfig} from '@app/api/instance/InstanceConfigRepository';
import {UsernameOwnershipRepository} from '@app/api/user/username/UsernameOwnershipRepository';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {usernameStartCapacityReady} from '@app/api/worker/tasks/UsernameCapacityMonitor';
import {
	UsernameHeldManifestSchema,
	type UsernameHoldsProofSchema,
	UsernameStoredGuildCapacitySchema,
} from '@fluxer/schema/src/domains/admin/UsernameSchemas';
import type {z} from 'zod';

export type HoldsInspection = {
	required: number | null;
	ready: boolean;
	proof: z.infer<typeof UsernameHoldsProofSchema> | null;
};
const unavailableHolds: HoldsInspection = {required: null, ready: false, proof: null};

export async function inspectUsernameHolds(
	policy: Pick<UsernamePolicyConfig, 'held_manifest' | 'revision'>,
	claims: Pick<
		UsernameOwnershipRepository,
		'readClaim' | 'readOwner' | 'readEntitlement'
	> = new UsernameOwnershipRepository(),
	now = Date.now(),
): Promise<HoldsInspection> {
	if (policy.held_manifest === null || policy.held_manifest === undefined) return unavailableHolds;
	const manifest = UsernameHeldManifestSchema.parse(policy.held_manifest);
	let held = 0;
	let assigned = 0;
	const missing: Array<string> = [];
	await mapWithConcurrency(manifest, 8, async (name) => {
		const claim = await claims.readClaim(name);
		if (claim?.state === 'held') {
			held++;
			return;
		}
		if (claim?.state === 'assigned' && claim.user_id !== null && claim.owned_gen !== null) {
			const owner = await claims.readOwner(claim.user_id);
			if (owner?.status === 'active' && owner.username === name && owner.owned_gen === claim.owned_gen) {
				let adminAssigned = claim.from_hold || (claim.held_by !== null && claim.held_by !== undefined);
				if (!adminAssigned && name.length <= 3) {
					const entitlement = await claims.readEntitlement(claim.user_id);
					adminAssigned =
						entitlement?.source === 'admin' &&
						entitlement.username === name &&
						entitlement.bound_gen === claim.owned_gen &&
						entitlement.revoked_at === null;
				}
				if (adminAssigned) {
					assigned++;
					return;
				}
			}
		}
		missing.push(name);
	});
	return {
		required: manifest.length,
		ready: missing.length === 0,
		proof: {
			policy_revision: policy.revision,
			checked_at: new Date(now).toISOString(),
			held,
			assigned,
			missing: missing.sort(),
		},
	};
}

export function freshUsernameGuildCapacity(raw: unknown, epoch: number, now = Date.now()) {
	const parsed = UsernameStoredGuildCapacitySchema.safeParse(raw);
	if (!parsed.success) return null;
	const age = now - Date.parse(parsed.data.observed_at);
	return parsed.data.epoch === epoch && age >= 0 && age < 3_600_000 ? parsed.data : null;
}

// Micup: scan totals, the admin guild declaration and the reservation manifest gate only the start of selection.
export async function readUsernameMigrationStartEvidence(
	config: Pick<
		InstanceConfigRepository,
		| 'readUsernameMigrationConfig'
		| 'readUsernamePolicyConfig'
		| 'readUsernameMigrationScan'
		| 'readUsernameMigrationGuildCapacity'
		| 'readUsernameReserveFence'
	>,
	claims?: Pick<UsernameOwnershipRepository, 'readClaim' | 'readOwner' | 'readEntitlement'>,
	now = Date.now(),
) {
	// Micup: the reservation fence is read before any claim, so a release cannot hide behind this inspection.
	const [migration, policy, scan, guildRaw, fence] = await Promise.all([
		config.readUsernameMigrationConfig(),
		config.readUsernamePolicyConfig(),
		config.readUsernameMigrationScan(),
		config.readUsernameMigrationGuildCapacity(),
		config.readUsernameReserveFence(),
	]);
	const totalAccounts =
		scan?.epoch === migration.epoch &&
		scan.done_at !== null &&
		scan.found === 0 &&
		Number.isFinite(Date.parse(scan.done_at)) &&
		Date.parse(scan.done_at) <= now
			? scan.scanned
			: null;
	const guildCapacity = freshUsernameGuildCapacity(guildRaw, migration.epoch, now);
	const holds = fence.pending ? unavailableHolds : await inspectUsernameHolds(policy, claims, now);
	const available = totalAccounts !== null && guildCapacity !== null && holds.proof !== null;
	return {
		migration,
		policy,
		holds,
		reserveVersion: fence.version,
		capacity: {
			available,
			ready: available && usernameStartCapacityReady(totalAccounts, guildCapacity),
			proof: {
				epoch: migration.epoch,
				policy_revision: policy.revision,
				total_accounts: totalAccounts,
				guild_capacity: guildCapacity,
				holds: holds.proof,
			},
		},
	};
}
