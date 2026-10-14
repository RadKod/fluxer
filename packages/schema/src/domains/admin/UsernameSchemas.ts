// SPDX-License-Identifier: AGPL-3.0-or-later

import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {UsernameLookupType} from '@fluxer/schema/src/primitives/UserValidators';
import {z} from 'zod';

export const UsernameTierModeSchema = z.enum(['locked', 'for_sale', 'public']);
export const UsernameHeldManifestSchema = z
	.array(
		z
			.string()
			.min(1)
			.max(32)
			.regex(/^[a-z0-9_]+$/),
	)
	.max(1000)
	.refine((values) => new Set(values).size === values.length, {message: 'Held names must be unique'});
export const UsernameTiersSchema = z
	.object({
		'1': UsernameTierModeSchema,
		'2': UsernameTierModeSchema,
		'3': UsernameTierModeSchema,
	})
	.strict();

export const UsernamePolicyUpdateRequest = z
	.object({
		tiers: UsernameTiersSchema,
		held_manifest: UsernameHeldManifestSchema.optional(),
		admission: z
			.object({global_per_second: z.number().int().min(0), paused: z.boolean()})
			.strict()
			.optional(),
	})
	.strict();
export const UsernamePolicyResponse = z.object({
	revision: z.number().int().min(0),
	tiers: UsernameTiersSchema,
	dictionary_gen: z.number().int().min(0),
	dictionary_hash: z.string().nullable(),
	next_dictionary_gen: z.number().int().min(1),
	admission: z.object({global_per_second: z.number().int().min(0), paused: z.boolean()}),
	held_manifest: UsernameHeldManifestSchema.nullable(),
});

export const UsernameDictionaryScopeSchema = z.enum(['uname_exact', 'uname_contains', 'uname_allow']);
export const UsernameDictionaryUpdateRequest = z
	.object({
		scope: UsernameDictionaryScopeSchema,
		add: z
			.array(
				z
					.string()
					.trim()
					.toLowerCase()
					.regex(/^[a-z0-9]+$/)
					.min(1)
					.max(32),
			)
			.max(20000)
			.default([]),
		remove: z
			.array(
				z
					.string()
					.trim()
					.toLowerCase()
					.regex(/^[a-z0-9]+$/)
					.min(1)
					.max(32),
			)
			.max(20000)
			.default([]),
	})
	.strict()
	.refine((value) => value.add.length + value.remove.length > 0, {message: 'A dictionary change is required'});
export const UsernameDictionaryResponse = z.object({
	dictionary_gen: z.number().int().min(0),
	hash: z.string(),
	count: z.number().int().min(0).max(20000),
	counts: z.object({uname_exact: z.number().int(), uname_contains: z.number().int(), uname_allow: z.number().int()}),
	entries: z.object({
		uname_exact: z.array(z.string()),
		uname_contains: z.array(z.string()),
		uname_allow: z.array(z.string()),
	}),
});

const UsernameReservationName = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(32)
	.regex(/^[a-z0-9_]+$/);
export const UsernameReserveRequest = z
	.object({
		username: UsernameReservationName,
		note: z.string().trim().max(1000).default(''),
	})
	.strict();
export const UsernameUnreserveRequest = z.object({username: UsernameReservationName}).strict();
export const UsernameAssignRequest = z.object({username: UsernameLookupType, user_id: SnowflakeType}).strict();
export const UsernameReselectRequest = z.object({ban_name: z.boolean()}).strict();
export const UsernameClaimResponse = z.union([
	z.object({ok: z.literal(true), username: z.string(), noop: z.boolean()}),
	z.object({ok: z.literal(false), code: z.string(), available_at: z.iso.datetime().optional()}),
]);

export const UsernameMigrationPrepareRequest = z.object({processes_ready: z.literal(true)}).strict();
const EvidenceCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const UsernameGuildCapacityDeclarationSchema = z
	.object({
		max_guild_members: EvidenceCount,
		max_guild_online: EvidenceCount,
		source: z.string().trim().min(1).max(1000),
		observed_at: z.iso.datetime(),
	})
	.strict()
	.refine((value) => value.max_guild_online <= value.max_guild_members, {
		message: 'Online count exceeds guild member count',
	});
export const UsernameStoredGuildCapacitySchema = UsernameGuildCapacityDeclarationSchema.safeExtend({
	epoch: EvidenceCount,
	admin_id: z.string().regex(/^\d+$/),
});
export const UsernameMigrationStartRequest = z
	.object({
		epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		mobile_published: z.literal(true),
		mobile_version: z.string().trim().min(1).max(100),
		guild_capacity: UsernameGuildCapacityDeclarationSchema,
	})
	.strict();
export const UsernameMigrationRollbackRequest = z
	.object({epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)})
	.strict();
export const UsernameMigrationResponse = z.object({
	state: z.enum(['legacy', 'preparing', 'selecting']),
	epoch: z.number().int().min(0),
	preparing_at: z.iso.datetime().nullable(),
	started_at: z.iso.datetime().nullable(),
	forced_at: z.iso.datetime().nullable(),
});

export const UsernameHoldsProofSchema = z.object({
	policy_revision: EvidenceCount,
	checked_at: z.iso.datetime(),
	held: EvidenceCount,
	assigned: EvidenceCount,
	missing: z.array(z.string()).max(1000),
});
export const UsernameMigrationInspectionResponse = z.object({
	migration: UsernameMigrationResponse,
	scan: z
		.object({epoch: EvidenceCount, scanned: EvidenceCount, found: EvidenceCount, done_at: z.iso.datetime().nullable()})
		.nullable(),
	holds: z.object({required: EvidenceCount.nullable(), ready: z.boolean(), proof: UsernameHoldsProofSchema.nullable()}),
	capacity: z.object({
		available: z.boolean(),
		ready: z.boolean(),
		proof: z
			.object({
				epoch: EvidenceCount,
				policy_revision: EvidenceCount,
				total_accounts: EvidenceCount.nullable(),
				guild_capacity: UsernameStoredGuildCapacitySchema.nullable(),
				holds: UsernameHoldsProofSchema.nullable(),
			})
			.nullable(),
	}),
});

export const UsernameReservationListQuery = z
	.object({
		bucket: z.coerce.number().int().min(0).max(1023),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		cursor: z
			.string()
			.regex(/^[a-z0-9_]{1,32}$/)
			.optional(),
	})
	.strict();
export const UsernameReservationListResponse = z.object({
	bucket: z.number().int().min(0).max(1023),
	items: z
		.array(
			z.object({
				username: z.string(),
				state: z.enum(['held', 'pending']),
				user_id: z.string().regex(/^\d+$/).nullable(),
				owned_gen: z.string().regex(/^\d+$/).nullable(),
				held_by: z.string().regex(/^\d+$/).nullable(),
				note: z.string().nullable(),
				blocked_until: z.iso.datetime().nullable(),
				updated_at: z.iso.datetime(),
				index_ts: z.string().regex(/^\d+$/),
			}),
		)
		.max(100),
	next_cursor: z.string().nullable(),
});
