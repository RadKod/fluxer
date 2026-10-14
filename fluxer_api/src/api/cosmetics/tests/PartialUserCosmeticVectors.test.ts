// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {UserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {hasPartialUserFieldsChanged, mapUserToPartialResponse} from '@app/api/user/UserMappers';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

// The same vectors drive the Rust users service (fluxer_users api_partial_includes_cosmetics) and the gateway
// (user_utils eunit), so a cosmetic field one of the three drops or leaves out instead of null fails somewhere.
const VECTORS_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../fluxer_common/src/testdata/partial_user_cosmetic_vectors.json',
);

interface PartialUserCosmeticVector {
	name: string;
	row: Record<string, string | number | boolean | null>;
	partial: Record<string, unknown>;
}

const BIGINT_COLUMNS = new Set(['user_id', 'flags', 'avatar_decoration_id', 'avatar_ultra_id', 'nameplate_id']);

function readVectors(): Array<PartialUserCosmeticVector> {
	const parsed: unknown = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(`no partial user cosmetic vectors in ${VECTORS_PATH}`);
	}
	return parsed as Array<PartialUserCosmeticVector>;
}

function userFromRow(row: PartialUserCosmeticVector['row']): User {
	const converted = Object.fromEntries(
		Object.entries(row).map(([column, value]) => [
			column,
			BIGINT_COLUMNS.has(column) && typeof value === 'number' ? BigInt(value) : value,
		]),
	);
	return new User({...EMPTY_USER_ROW, ...converted, user_id: BigInt(row.user_id as number) as UserID});
}

const vectors = readVectors();

describe('partial user cosmetic vectors', () => {
	// The mapper resolves the animated avatar entitlement through the limit config the harness installs.
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it.each(vectors.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
		const mapped = JSON.parse(JSON.stringify(mapUserToPartialResponse(userFromRow(vector.row))));
		// Micup: API identity generations extend the shared cosmetic payload without changing its fields.
		expect(mapped).toStrictEqual({...vector.partial, identity_version: '0'});
	});

	it('counts a change of a worn cosmetic as a partial user change, and nothing else as one', () => {
		const users = vectors.map((vector) => userFromRow(vector.row));
		const [both, nameplateOnly, none, halfWritten, , ultraHalfWritten] = users;
		expect(hasPartialUserFieldsChanged(both!, nameplateOnly!)).toBe(true);
		expect(hasPartialUserFieldsChanged(nameplateOnly!, none!)).toBe(true);
		expect(hasPartialUserFieldsChanged(none!, halfWritten!)).toBe(false);
		expect(hasPartialUserFieldsChanged(none!, ultraHalfWritten!)).toBe(false);
		expect(hasPartialUserFieldsChanged(both!, userFromRow(vectors[0]!.row))).toBe(false);
	});

	it('counts a change of the ultra decoration alone as a partial user change', () => {
		const ultraAndFrame = userFromRow(vectors[4]!.row);
		const frameOnly = userFromRow({...vectors[4]!.row, avatar_ultra_id: null, avatar_ultra_asset: null});
		expect(hasPartialUserFieldsChanged(frameOnly, ultraAndFrame)).toBe(true);
		expect(hasPartialUserFieldsChanged(ultraAndFrame, frameOnly)).toBe(true);
	});

	it('sends a null ultra decoration for a deleted account', () => {
		const deleted = new User({
			...EMPTY_USER_ROW,
			user_id: 42n as UserID,
			username: 'ada',
			discriminator: 7,
			flags: UserFlags.DELETED,
			avatar_ultra_id: 3003n,
			avatar_ultra_asset: 'a_7c8d9e0f',
		});
		expect(mapUserToPartialResponse(deleted)).toHaveProperty('avatar_ultra_data', null);
	});
});
