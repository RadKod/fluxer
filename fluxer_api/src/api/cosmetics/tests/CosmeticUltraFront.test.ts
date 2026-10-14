// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {fromUltraFrontMap, toUltraFrontMap} from '@app/api/cosmetics/CosmeticService';
import {EntityAssetService} from '@app/api/infrastructure/EntityAssetService';
import {phraseBlocklistCache} from '@app/api/middleware/PhraseBlocklistCache';
import {getAdminRepository, getCosmeticService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {TestMediaService} from '@app/api/test/TestMediaService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');
// Each part is a distinct PNG (a trailing byte makes a new hash); the spy answers 288×576 for them and marks the loop
// animated. The plain PNG (the main image) keeps the 128×128 still answer of the test media service.
const part = (tag: number) => Buffer.concat([PNG_BYTES, Buffer.from([tag])]).toString('base64');
const IDLE_TAG = 250;
const FRONT = {closed: part(1), open: [part(1), part(2), part(3)], idle: part(IDLE_TAG)};

interface HalfMetadata {
	width?: number;
	height?: number;
	animated?: (tag: number) => boolean;
	failOnCall?: number;
}

function halfMetadata({
	width = 288,
	height = 576,
	animated = (tag) => tag === IDLE_TAG,
	failOnCall,
}: HalfMetadata = {}) {
	const original = TestMediaService.prototype.getMetadata;
	let calls = 0;
	return vi.spyOn(TestMediaService.prototype, 'getMetadata').mockImplementation(async function (
		this: TestMediaService,
		request,
	) {
		const metadata = await original.call(this, request);
		if (request.type !== 'base64') return metadata;
		const bytes = Buffer.from(request.base64, 'base64');
		if (bytes.length <= PNG_BYTES.length) return metadata;
		calls++;
		if (calls === failOnCall) return null;
		return metadata && {...metadata, width, height, animated: animated(bytes.at(-1) ?? 0)};
	});
}

describe('ultra decorations drawn in front', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let user: TestAccount;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.COSMETICS_MANAGE,
		]);
		user = await createTestAccount(harness);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function createItem(body: Record<string, unknown>): Promise<CosmeticItemResponse> {
		return createBuilder<CosmeticItemResponse>(harness, admin.token)
			.post('/admin/cosmetics/items')
			.body({asset: PNG, ...body})
			.expect(200)
			.execute();
	}

	const createWings = () => createItem({type: 'avatar_ultra', name: 'Angel Wings', availability: 'owned'});

	function patch(item: CosmeticItemResponse, body: Record<string, unknown>) {
		return createBuilder<CosmeticItemResponse>(harness, admin.token)
			.patch(`/admin/cosmetics/items/${item.id}`)
			.body(body);
	}

	async function readById(item: CosmeticItemResponse) {
		const byId = await createBuilder<Array<CosmeticItemResponse>>(harness, user.token)
			.get(`/cosmetics/items?ids=${item.id}`)
			.expect(200)
			.execute();
		return byId.find((entry) => entry.id === item.id);
	}

	async function readEverywhere(item: CosmeticItemResponse) {
		const adminList = await createBuilder<Array<CosmeticItemResponse>>(harness, admin.token)
			.get('/admin/cosmetics/items')
			.expect(200)
			.execute();
		const catalog = await createBuilder<Array<CosmeticItemResponse>>(harness, user.token)
			.get('/cosmetics/catalog?type=avatar_ultra')
			.expect(200)
			.execute();
		return [
			adminList.find((entry) => entry.id === item.id)?.ultra_front,
			catalog.find((entry) => entry.id === item.id)?.ultra_front,
			(await readById(item))?.ultra_front,
		];
	}

	it('stores the front parts and answers them in the admin list, the catalog and by ID', async () => {
		const item = await createWings();
		halfMetadata();

		const updated = await patch(item, {ultra_front: FRONT}).expect(200).execute();

		const front = updated.ultra_front;
		expect(front?.open).toHaveLength(3);
		expect(front?.closed).toBe(front?.open[0]);
		expect(new Set(front?.open).size).toBe(3);
		expect(front?.idle).toMatch(/^a_[0-9a-f]{8}$/);
		expect(updated.asset).toBe(item.asset);
		expect(await readEverywhere(item)).toEqual([front, front, front]);
	});

	it('keeps the front when another field changes', async () => {
		const item = await createWings();
		halfMetadata();
		const {ultra_front: front} = await patch(item, {ultra_front: FRONT}).expect(200).execute();

		const renamed = await patch(item, {name: 'Melek Kanadı'}).expect(200).execute();

		expect(front?.open).toHaveLength(3);
		expect(renamed.ultra_front).toEqual(front);
	});

	it('null draws the item behind again', async () => {
		const item = await createWings();
		halfMetadata();
		await patch(item, {ultra_front: FRONT}).expect(200).execute();

		const reset = await patch(item, {ultra_front: null}).expect(200).execute();

		expect(reset.ultra_front).toBeNull();
		expect(await readEverywhere(item)).toEqual([null, null, null]);
	});

	it('refuses a front on a frame', async () => {
		const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});
		halfMetadata();
		await patch(frame, {ultra_front: FRONT}).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();
	});

	it('refuses a part that is not twice as tall as wide', async () => {
		const item = await createWings();
		halfMetadata({width: 288, height: 288});

		await patch(item, {ultra_front: FRONT}).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();

		expect((await readById(item))?.ultra_front).toBeNull();
	});

	it('refuses a still loop and a moving closed frame', async () => {
		const item = await createWings();
		const still = halfMetadata({animated: () => false});
		await patch(item, {ultra_front: FRONT}).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();
		still.mockRestore();
		halfMetadata({animated: () => true});
		await patch(item, {ultra_front: FRONT}).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();

		expect((await readById(item))?.ultra_front).toBeNull();
	});

	it('refuses opening frames above 500 KB together before storing anything', async () => {
		const item = await createWings();
		halfMetadata();
		const prepare = vi.spyOn(EntityAssetService.prototype, 'prepareCosmeticAssetUpload');
		const frame = Buffer.concat([PNG_BYTES, Buffer.alloc(60 * 1024)]).toString('base64');

		const {json} = await patch(item, {ultra_front: {...FRONT, open: Array(9).fill(frame)}})
			.expect(400, APIErrorCodes.INVALID_FORM_BODY)
			.executeWithResponse();

		expect(JSON.stringify(json)).toContain(ValidationErrorCodes.IMAGE_SIZE_EXCEEDS_LIMIT);
		expect(prepare).not.toHaveBeenCalled();
	});

	it('a failed part takes back the parts it already stored', async () => {
		const item = await createWings();
		halfMetadata({failOnCall: 3});
		const rollback = vi.spyOn(EntityAssetService.prototype, 'rollbackAssetUpload');

		await patch(item, {ultra_front: FRONT, name: 'Half written'})
			.expect(400, APIErrorCodes.INVALID_FORM_BODY)
			.execute();

		expect(rollback).toHaveBeenCalledTimes(2);
		expect(new Set(rollback.mock.calls.map(([upload]) => upload.newHash)).size).toBe(1);
		const stored = await readById(item);
		expect(stored?.ultra_front).toBeNull();
		expect(stored?.name).toBe('Angel Wings');
	});

	it('a failed row write takes back every new part', async () => {
		const item = await createWings();
		halfMetadata();
		const rollback = vi.spyOn(EntityAssetService.prototype, 'rollbackAssetUpload');
		vi.spyOn(CosmeticRepository.prototype, 'putItem').mockRejectedValueOnce(new Error('row write failed'));

		await patch(item, {ultra_front: FRONT}).expect(500).execute();

		expect(rollback).toHaveBeenCalledTimes(5);
		expect(new Set(rollback.mock.calls.map(([upload]) => upload.newHash)).size).toBe(4);
		expect((await readById(item))?.ultra_front).toBeNull();
	});

	it('a failed row write never deletes parts the item still uses', async () => {
		const item = await createWings();
		halfMetadata();
		const {ultra_front: front} = await patch(item, {ultra_front: FRONT}).expect(200).execute();
		const rollback = vi.spyOn(EntityAssetService.prototype, 'rollbackAssetUpload');
		vi.spyOn(CosmeticRepository.prototype, 'putItem').mockRejectedValueOnce(new Error('row write failed'));

		await patch(item, {ultra_front: FRONT}).expect(500).execute();

		expect(front?.open).toHaveLength(3);
		expect(rollback).not.toHaveBeenCalled();
		expect((await readById(item))?.ultra_front).toEqual(front);
	});

	// Runs `during` once, inside the first part upload of the next request, then lets that upload go on.
	function duringFirstUpload(during: () => Promise<void>) {
		const prepare = EntityAssetService.prototype.prepareCosmeticAssetUpload;
		vi.spyOn(EntityAssetService.prototype, 'prepareCosmeticAssetUpload').mockImplementationOnce(async function (
			this: EntityAssetService,
			...args
		) {
			await during();
			return prepare.apply(this, args);
		});
	}

	it('keeps a take-off-sale that lands while the parts upload', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Angel Wings', availability: 'free'});
		halfMetadata();
		duringFirstUpload(() => getCosmeticService().retireItem(BigInt(item.id)));

		const updated = await patch(item, {ultra_front: FRONT}).expect(200).execute();

		expect(updated.availability).toBe('owned');
		expect((await readById(item))?.availability).toBe('owned');
	});

	it('a failed row write keeps the parts another save wrote while this one uploaded', async () => {
		const item = await createWings();
		halfMetadata();
		const rollback = vi.spyOn(EntityAssetService.prototype, 'rollbackAssetUpload');
		duringFirstUpload(async () => {
			await getCosmeticService().updateItem(BigInt(item.id), {ultra_front: FRONT});
			vi.spyOn(CosmeticRepository.prototype, 'putItem').mockRejectedValueOnce(new Error('row write failed'));
		});

		await patch(item, {ultra_front: FRONT}).expect(500).execute();

		expect(rollback).not.toHaveBeenCalled();
		expect((await readById(item))?.ultra_front?.open).toHaveLength(3);
	});

	it('a refused part never deletes a main image that wearers still use', async () => {
		const item = await createWings();
		// The item moves to a new image; accounts that put it on before keep item.asset.
		await patch(item, {asset: part(9)})
			.expect(200)
			.execute();
		halfMetadata({failOnCall: 2});
		const rollback = vi.spyOn(EntityAssetService.prototype, 'rollbackAssetUpload');

		await patch(item, {asset: PNG, ultra_front: FRONT}).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();

		expect(rollback.mock.calls.map(([upload]) => upload.newHash)).not.toContain(item.asset);
	});

	it('saves images whose base64 holds a blocked phrase, while the name is still screened', async () => {
		const item = await createWings();
		halfMetadata();
		// Every PNG part starts with iVBORw0KGgo, so the phrase sits in the base64 of the image and of each part.
		phraseBlocklistCache.add('ivbor');
		try {
			await patch(item, {asset: PNG, ultra_front: FRONT}).expect(200).execute();
			await patch(item, {name: 'Ivbor Wings'}).expect(403, APIErrorCodes.CONTENT_BLOCKED).execute();
		} finally {
			phraseBlocklistCache.remove('ivbor');
		}
	});

	it('an ultra item without a front answers null', async () => {
		const ultra = await createWings();
		const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});

		expect(ultra.ultra_front).toBeNull();
		expect(frame.ultra_front).toBeNull();
		expect(await readEverywhere(ultra)).toEqual([null, null, null]);
	});

	it('puts an item taken off sale back in the catalog', async () => {
		const item = await createWings();
		await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${item.id}`).expect(204).execute();
		const listCatalog = () =>
			createBuilder<Array<CosmeticItemResponse>>(harness, user.token)
				.get('/cosmetics/catalog?type=avatar_ultra')
				.expect(200)
				.execute();
		expect(await listCatalog()).toEqual([]);

		const relisted = await patch(item, {on_sale: true}).expect(200).execute();

		expect(relisted.availability).toBe('owned');
		expect((await listCatalog()).map((entry) => entry.id)).toEqual([item.id]);
	});

	it('keeps the new parts when cache eviction throws after the write', async () => {
		const item = await createWings();
		halfMetadata();
		const rollback = vi.spyOn(EntityAssetService.prototype, 'rollbackAssetUpload');
		const {catalogCache} = getCosmeticService() as unknown as {catalogCache: Map<string, unknown>};
		vi.spyOn(catalogCache, 'delete').mockImplementationOnce(() => {
			throw new Error('eviction failed');
		});

		await patch(item, {ultra_front: FRONT}).expect(500).execute();

		expect(rollback).not.toHaveBeenCalled();
		expect((await readById(item))?.ultra_front?.open).toHaveLength(3);
	});

	async function auditEntriesOf(item: CosmeticItemResponse) {
		const logs = await getAdminRepository().listAllAuditLogsPaginated(100000);
		return logs
			.filter((log) => log.targetType === 'cosmetic_item' && log.targetId.toString() === item.id)
			.map((log) => ({action: log.action, fields: log.metadata.get('fields')}));
	}

	it('records the front in the audit fields', async () => {
		const item = await createWings();
		halfMetadata();

		await patch(item, {ultra_front: FRONT}).expect(200).execute();

		expect(await auditEntriesOf(item)).toContainEqual({action: 'update_cosmetic_item', fields: 'ultra_front'});
	});

	it('logs putting an item back on sale as relist_cosmetic_item, the counterpart of retire_cosmetic_item', async () => {
		const item = await createWings();
		await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${item.id}`).expect(204).execute();

		await patch(item, {on_sale: true}).expect(200).execute();

		const entries = (await auditEntriesOf(item)).filter((entry) => entry.action !== 'create_cosmetic_item');
		expect(entries).toEqual(
			expect.arrayContaining([
				{action: 'retire_cosmetic_item', fields: undefined},
				{action: 'relist_cosmetic_item', fields: 'on_sale'},
			]),
		);
		expect(entries).toHaveLength(2);
	});

	it('logs the other fields of a relist as update_cosmetic_item too', async () => {
		const item = await createWings();
		halfMetadata();
		await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${item.id}`).expect(204).execute();

		await patch(item, {ultra_front: FRONT, on_sale: true}).expect(200).execute();

		const entries = (await auditEntriesOf(item)).filter(
			(entry) => entry.action !== 'create_cosmetic_item' && entry.action !== 'retire_cosmetic_item',
		);
		expect(entries).toEqual(
			expect.arrayContaining([
				{action: 'update_cosmetic_item', fields: 'ultra_front,on_sale'},
				{action: 'relist_cosmetic_item', fields: 'ultra_front,on_sale'},
			]),
		);
		expect(entries).toHaveLength(2);
	});
});

describe('ultra front map', () => {
	it('maps the front to open_00.. keys and back, and drops a set without two frames', () => {
		const map = toUltraFrontMap({closed: 'c', open: ['c', 'o1', 'o2'], idle: 'a_i'});
		expect(Object.fromEntries(map)).toEqual({closed: 'c', idle: 'a_i', open_00: 'c', open_01: 'o1', open_02: 'o2'});
		expect(fromUltraFrontMap(map)).toEqual({closed: 'c', open: ['c', 'o1', 'o2'], idle: 'a_i'});

		expect(
			fromUltraFrontMap(
				new Map([
					['closed', 'c'],
					['idle', 'i'],
					['open_00', 'c'],
				]),
			),
		).toBeNull();
		expect(
			fromUltraFrontMap(
				new Map([
					['idle', 'i'],
					['open_00', 'c'],
					['open_01', 'd'],
				]),
			),
		).toBeNull();
		expect(
			fromUltraFrontMap(
				new Map([
					['closed', 'c'],
					['open_00', 'c'],
					['open_01', 'd'],
				]),
			),
		).toBeNull();
		expect(
			fromUltraFrontMap(
				new Map([
					['closed', 'c'],
					['idle', 'i'],
					['open_00', 'c'],
					['open_01', 'd'],
					['open_03', 'f'],
				]),
			)?.open,
		).toEqual(['c', 'd']);
		expect(fromUltraFrontMap(null)).toBeNull();
		expect(fromUltraFrontMap(undefined)).toBeNull();
	});

	it('reads at most thirty frames', () => {
		const map = toUltraFrontMap({closed: 'c', open: Array.from({length: 30}, (_, i) => `f${i}`), idle: 'i'});
		map.set('open_30', 'extra');
		expect(fromUltraFrontMap(map)?.open).toHaveLength(30);
		expect(map.get('open_29')).toBe('f29');
	});
});
