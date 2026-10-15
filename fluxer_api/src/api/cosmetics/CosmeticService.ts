// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {UserID} from '@app/api/BrandedTypes';
import type {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import type {CosmeticItemRow} from '@app/api/database/types/CosmeticTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import type {
	CosmeticImageShape,
	EntityAssetService,
	PreparedAssetUpload,
} from '@app/api/infrastructure/EntityAssetService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import type {User} from '@app/api/models/User';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {propagatePartialUserChange} from '@app/api/user/services/PartialUserChangePropagation';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {dispatchUserUpdate, hasPartialUserFieldsChanged} from '@app/api/user/UserMappers';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {COSMETIC_ASSET_POLICY, ULTRA_FRONT_POLICY} from '@fluxer/constants/src/AssetFormatPolicy';
import {normalizeCosmeticSeriesName} from '@fluxer/constants/src/CosmeticSeries';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {CosmeticNotOwnedError} from '@fluxer/errors/src/domains/user/CosmeticNotOwnedError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {
	CosmeticItemCreateRequest,
	CosmeticItemUpdateRequest,
	EquipCosmeticsRequest,
	UltraFrontUpload,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticRequestSchemas';
import type {
	AdminUserCosmeticResponse,
	CosmeticAvailability,
	CosmeticItemResponse,
	CosmeticItemType,
	EquippedCosmeticsResponse,
	UltraFront,
	UltraLayout,
	UltraLayoutSurface,
	UserCosmeticsResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

interface CosmeticServiceDeps {
	repository: CosmeticRepository;
	userRepository: UserRepository;
	userCacheService: UserCacheService;
	gatewayService: IGatewayService;
	workerService: IWorkerService<WorkerTaskName>;
	entityAssetService: EntityAssetService;
	snowflakeService: ISnowflakeService;
}

// Store delivery hands purchased items over through this port; granting twice is harmless.
export interface CosmeticGrantPort {
	grantOwned(userId: UserID, itemId: bigint, source: string): Promise<void>;
}

const COSMETIC_TYPES = ['avatar_decoration', 'avatar_ultra', 'profile_effect', 'nameplate'] as const;
type CosmeticSlot = (typeof COSMETIC_TYPES)[number];
const USER_COLUMNS = {
	avatar_decoration: ['avatar_decoration_id', 'avatar_decoration_asset'],
	avatar_ultra: ['avatar_ultra_id', 'avatar_ultra_asset'],
	profile_effect: ['profile_effect_id', 'profile_effect_asset'],
	nameplate: ['nameplate_id', 'nameplate_asset'],
} as const satisfies Record<CosmeticSlot, readonly [keyof UserRow, keyof UserRow]>;
// TEMPORARY: each API process keeps the catalog for 60 s, so an admin change shows up late in other processes; move it
// to a KV-versioned cache once admins need instant catalog changes everywhere.
const CATALOG_CACHE_TTL_MS = 60_000;
// TEMPORARY: items read by ID (ultra sizes of what other accounts wear) stay 60 s in each API process, at most 5 000
// of them (the admin-curated catalog is far smaller); same upgrade path as the catalog cache above.
const ITEM_CACHE_MAX = 5_000;
// A delivery takes a few row writes; a second one for the same account and item waits up to 5 s, then is deferred.
const DELIVERY_LOCK_TTL_SECONDS = 30;
const DELIVERY_LOCK_ATTEMPTS = 100;
const DELIVERY_LOCK_RETRY_MS = 50;
const ULTRA_SURFACES = ['compact', 'voice', 'profile'] as const;
const ULTRA_FIELDS = ['width', 'height', 'offset_x', 'offset_y'] as const;

// Stored in thousandths so the map holds integers (2.30 -> 2300, -0.10 -> -100); a blank surface stores nothing.
export function toUltraLayoutMap(layout: UltraLayout | null): Map<string, number> | null {
	const map = new Map<string, number>();
	for (const surface of ULTRA_SURFACES) {
		const values = layout?.[surface];
		if (!values) continue;
		for (const field of ULTRA_FIELDS) map.set(`${surface}_${field}`, Math.round(values[field] * 1000));
	}
	return map.size > 0 ? map : null;
}

// A surface counts only with all four numbers; without any, the client keeps the fixed sizes (null).
export function fromUltraLayoutMap(map: Map<string, number> | null | undefined): UltraLayout | null {
	if (!map) return null;
	const surfaceOf = (surface: (typeof ULTRA_SURFACES)[number]): UltraLayoutSurface | null => {
		const [width, height, offsetX, offsetY] = ULTRA_FIELDS.map((field) => map.get(`${surface}_${field}`));
		if (width === undefined || height === undefined || offsetX === undefined || offsetY === undefined) return null;
		return {width: width / 1000, height: height / 1000, offset_x: offsetX / 1000, offset_y: offsetY / 1000};
	};
	const layout = {compact: surfaceOf('compact'), voice: surfaceOf('voice'), profile: surfaceOf('profile')};
	return layout.compact || layout.voice || layout.profile ? layout : null;
}

const openKey = (index: number) => `open_${String(index).padStart(2, '0')}`;

// closed, idle and open_00..open_29 (angel-wings); the frame order lives in the key.
export function toUltraFrontMap(front: UltraFront): Map<string, string> {
	return new Map<string, string>([
		['closed', front.closed],
		['idle', front.idle],
		...front.open.map((hash, index): [string, string] => [openKey(index), hash]),
	]);
}

// Frames count from open_00 up to the first gap; without the closed frame, the loop and two frames the item draws
// behind (null), as it does for a row written before the column existed.
export function fromUltraFrontMap(map: Map<string, string> | null | undefined): UltraFront | null {
	const closed = map?.get('closed');
	const idle = map?.get('idle');
	if (!map || closed === undefined || idle === undefined) return null;
	const open: Array<string> = [];
	for (let index = 0; index < ULTRA_FRONT_POLICY.maxFrames; index++) {
		const hash = map.get(openKey(index));
		if (hash === undefined) break;
		open.push(hash);
	}
	return open.length >= ULTRA_FRONT_POLICY.minFrames ? {closed, open, idle} : null;
}

type StorePart = (base64: string, errorPath: string, maxBytes: number, shape?: CosmeticImageShape) => Promise<string>;

// One part at a time (admin only, at most 32 parts). A part refused by its checks throws before its own upload; one
// whose upload is stored but not confirmed stays in storage, as in Fluxer's own uploads.
// TEMPORARY: sequential S3 puts (~5 s for 26 parts); run them 4 at a time if admin uploads time out.
async function storeUltraFront(front: UltraFrontUpload, store: StorePart): Promise<Map<string, string>> {
	const still = {height: ULTRA_FRONT_POLICY.height, animated: false};
	const closed = await store(front.closed, 'ultra_front.closed', ULTRA_FRONT_POLICY.closedMaxBytes, still);
	const open: Array<string> = [];
	for (const [index, frame] of front.open.entries()) {
		open.push(await store(frame, `ultra_front.open.${index}`, ULTRA_FRONT_POLICY.openFrameMaxBytes, still));
	}
	const idle = await store(front.idle, 'ultra_front.idle', ULTRA_FRONT_POLICY.idleMaxBytes, {
		height: ULTRA_FRONT_POLICY.height,
		animated: true,
	});
	return toUltraFrontMap({closed, open, idle});
}

// Checked before anything is stored; the request schema already stripped any data URL prefix.
function assertOpeningBudget(front: UltraFrontUpload): void {
	const bytes = front.open.reduce((sum, frame) => sum + Buffer.byteLength(frame, 'base64'), 0);
	if (bytes > ULTRA_FRONT_POLICY.openTotalMaxBytes) {
		throw InputValidationError.fromCode('ultra_front.open', ValidationErrorCodes.IMAGE_SIZE_EXCEEDS_LIMIT, {
			maxSize: ULTRA_FRONT_POLICY.openTotalMaxBytes,
		});
	}
}

function mapItem(item: Omit<CosmeticItemRow, 'version'>): CosmeticItemResponse {
	return {
		id: item.item_id.toString(),
		type: item.item_type as CosmeticItemType,
		name: item.name,
		description: item.description,
		series: item.series ?? null,
		asset: item.asset_hash,
		availability: item.availability as CosmeticAvailability,
		ultra_layout: item.item_type === 'avatar_ultra' ? fromUltraLayoutMap(item.ultra_layout) : null,
		ultra_front: item.item_type === 'avatar_ultra' ? fromUltraFrontMap(item.ultra_front) : null,
	};
}

function mapEquipped(user: User): EquippedCosmeticsResponse {
	return {
		avatar_decoration_id: user.avatarDecorationId?.toString() ?? null,
		avatar_ultra_id: user.avatarUltraId?.toString() ?? null,
		profile_effect_id: user.profileEffectId?.toString() ?? null,
		nameplate_id: user.nameplateId?.toString() ?? null,
	};
}

function wears(user: User, item: Pick<CosmeticItemRow, 'item_type' | 'item_id'>): boolean {
	const [idColumn] = USER_COLUMNS[item.item_type as CosmeticSlot];
	return user.toRow()[idColumn] === item.item_id;
}

function ownerKey(item: Pick<CosmeticItemRow, 'item_type' | 'item_id'>) {
	return `cosmetic-${item.item_type}-${item.item_id}` as const;
}

// Ultra decorations and the other cosmetic types each take their own cap from COSMETIC_ASSET_POLICY.
function assetMaxBytes(type: string): number {
	return type === 'avatar_ultra' ? COSMETIC_ASSET_POLICY.ultraMaxBytes : COSMETIC_ASSET_POLICY.maxBytes;
}

function uploadedHash(prepared: PreparedAssetUpload): string {
	if (!prepared.newHash) {
		throw new Error('Cosmetic image upload produced no hash');
	}
	return prepared.newHash;
}

export class CosmeticService implements CosmeticGrantPort {
	private readonly catalogCache = new Map<CosmeticItemType, {expiresAt: number; items: Array<CosmeticItemResponse>}>();
	private readonly itemCache = new Map<bigint, {expiresAt: number; item: CosmeticItemResponse}>();

	constructor(readonly deps: CosmeticServiceDeps) {}

	async listCatalog(type?: CosmeticItemType): Promise<Array<CosmeticItemResponse>> {
		const lists = await Promise.all((type ? [type] : COSMETIC_TYPES).map((itemType) => this.listCatalogType(itemType)));
		return lists.flat();
	}

	async listAllItems(): Promise<Array<CosmeticItemResponse>> {
		const items = await this.deps.repository.listAllItems();
		items.sort((left, right) => (left.item_id < right.item_id ? -1 : 1));
		return items.map(mapItem);
	}

	async listOwn(user: User): Promise<UserCosmeticsResponse> {
		const owned = await this.deps.repository.listOwned(user.id);
		const items = await this.deps.repository.getItems(owned.map((row) => row.item_id));
		items.sort((left, right) => (left.item_id < right.item_id ? -1 : 1));
		return {owned: items.map(mapItem), equipped: mapEquipped(user)};
	}

	async getItem(itemId: bigint): Promise<CosmeticItemResponse | null> {
		const item = await this.deps.repository.getItem(itemId);
		return item ? mapItem(item) : null;
	}

	// Point reads only (no table or catalog listing), items taken off sale included; unknown IDs are left out.
	async getItemsByIds(ids: ReadonlyArray<bigint>): Promise<Array<CosmeticItemResponse>> {
		const now = Date.now();
		const items = await Promise.all(
			[...new Set(ids)].slice(0, 50).map(async (itemId) => {
				const cached = this.itemCache.get(itemId);
				if (cached && cached.expiresAt > now) return cached.item;
				const item = await this.getItem(itemId);
				if (item) this.cacheItem(itemId, item, now);
				return item;
			}),
		);
		return items.filter((item) => item !== null);
	}

	async isOwned(userId: UserID, itemId: bigint): Promise<boolean> {
		return (await this.deps.repository.getOwned(userId, itemId)) !== null;
	}

	async equip(user: User, request: EquipCosmeticsRequest): Promise<EquippedCosmeticsResponse> {
		const patch: Partial<UserRow> = {};
		await Promise.all(
			COSMETIC_TYPES.map(async (type) => {
				const itemId = request[`${type}_id`];
				if (itemId === undefined) return;
				const [idColumn, assetColumn] = USER_COLUMNS[type];
				const item = itemId === null ? null : await this.requireWearable(user, type, itemId);
				Object.assign(patch, {[idColumn]: item?.item_id ?? null, [assetColumn]: item?.asset_hash ?? null});
			}),
		);
		const row = user.toRow();
		if (!Object.entries(patch).some(([column, value]) => row[column as keyof UserRow] !== value)) {
			return mapEquipped(user);
		}
		const updatedUser = await this.deps.userRepository.patchUpsert(user.id, patch, row);
		await dispatchUserUpdate(this.deps.gatewayService, updatedUser);
		if (hasPartialUserFieldsChanged(user, updatedUser)) {
			await propagatePartialUserChange({userCacheService: this.deps.userCacheService}, updatedUser);
		}
		return mapEquipped(updatedUser);
	}

	// Premium ended: takes off the premium items the account does not own. Runs in the worker; safe to repeat.
	async removePremiumOnlyCosmetics(userId: UserID): Promise<void> {
		const user = await this.deps.userRepository.findUnique(userId);
		if (!user || checkIsPremium(user)) return;
		const row = user.toRow();
		const patch: Partial<UserRow> = {};
		await Promise.all(
			COSMETIC_TYPES.map(async (type) => {
				const [idColumn, assetColumn] = USER_COLUMNS[type];
				const itemId = row[idColumn];
				if (itemId == null) return;
				const item = await this.deps.repository.getItem(itemId);
				if (item?.availability !== 'premium' || (await this.deps.repository.getOwned(userId, itemId))) return;
				Object.assign(patch, {[idColumn]: null, [assetColumn]: null});
			}),
		);
		if (Object.keys(patch).length === 0) return;
		const updatedUser = await this.deps.userRepository.patchUpsert(userId, patch, row);
		await dispatchUserUpdate(this.deps.gatewayService, updatedUser);
		await propagatePartialUserChange({userCacheService: this.deps.userCacheService}, updatedUser);
	}

	async grantOwned(userId: UserID, itemId: bigint, source: string): Promise<void> {
		const item = await this.requireItem(itemId);
		if (await this.deps.repository.getOwned(userId, item.item_id)) return;
		await this.deps.repository.putOwned({
			user_id: userId,
			item_id: item.item_id,
			item_type: item.item_type,
			source,
			acquired_at: new Date(),
		});
	}

	// One delivery per grant key (shop order 'payriff:<order_id>', item code 'gift:<code>'): the cosmetic_grants row is
	// the lasting proof, so a retry, a resubmitted code or a replayed order never delivers twice, nor after a take-back.
	// One delivery per account and item at a time (Fluxer's wait-and-retry lock): a second paid order for the same item
	// claims its row after the first owned it, so it answers already_owned (refund by hand) and never passes as a resumed
	// crash of its own. wear: false owns the item and leaves its slot as it is (a bundle wears its first item of a type).
	async deliverOwned(
		userId: UserID,
		itemId: bigint,
		grantKey: string,
		source: string,
		{wear = true}: {wear?: boolean} = {},
	): Promise<'delivered' | 'already_delivered' | 'already_owned'> {
		const kvClient = getKVClient();
		const lockKey = `cosmetic:deliver:${userId}:${itemId}`;
		const lockToken = randomUUID();
		for (let attempt = 0; !(await kvClient.acquireLock(lockKey, lockToken, DELIVERY_LOCK_TTL_SECONDS)); attempt++) {
			if (attempt >= DELIVERY_LOCK_ATTEMPTS) throw new ResourceLockedError();
			await delay(DELIVERY_LOCK_RETRY_MS);
		}
		try {
			return await this.deliverOwnedLocked(userId, itemId, grantKey, source, wear);
		} finally {
			await kvClient.releaseLock(lockKey, lockToken);
		}
	}

	private async deliverOwnedLocked(
		userId: UserID,
		itemId: bigint,
		grantKey: string,
		source: string,
		wear: boolean,
	): Promise<'delivered' | 'already_delivered' | 'already_owned'> {
		await this.requireLiveUser(userId);
		const item = await this.requireItem(itemId);
		await this.deps.repository.claimGrant({
			user_id: userId,
			grant_key: grantKey,
			item_id: item.item_id,
			source,
			state: 'pending',
			created_at: new Date(),
			delivered_at: null,
		});
		const grant = await this.deps.repository.getGrant(userId, grantKey);
		if (!grant || grant.state === 'delivered' || grant.state === 'revoked') return 'already_delivered';
		const owned = await this.deps.repository.getOwned(userId, item.item_id);
		// Owned since before this delivery started: paid for something the account already had (refund by hand). Owned
		// by this very delivery (same source, acquired after the row was claimed): a crash after grantOwned; finish it.
		if (owned && !(owned.source === source && owned.acquired_at.getTime() >= grant.created_at.getTime())) {
			await this.deps.repository.markGrantDelivered(userId, grantKey, new Date());
			return 'already_owned';
		}
		if (!owned) await this.grantOwned(userId, item.item_id, source);
		if (wear) await this.wearDelivered(userId, item);
		if (!(await this.deps.repository.markGrantDelivered(userId, grantKey, new Date()))) {
			// The row left 'pending' while this delivery ran. Revoked: an admin take-back won, undo what it gave. Delivered:
			// a retry of the same key that outlived this delivery's locks marked it first, and the item stays.
			if ((await this.deps.repository.getGrant(userId, grantKey))?.state === 'revoked') {
				await this.deps.repository.deleteOwned(userId, item.item_id);
				const user = await this.deps.userRepository.findUnique(userId);
				if (user) await this.takeOffIfUnwearable(user, item);
			}
			return 'already_delivered';
		}
		return 'delivered';
	}

	// Admin gift: owned, not worn, and no delivery row (it is not a purchase or a code).
	async adminGrant(userId: UserID, itemId: bigint): Promise<AdminUserCosmeticResponse> {
		const user = await this.requireLiveUser(userId);
		const item = await this.requireItem(itemId);
		const changed = !(await this.isOwned(userId, item.item_id));
		if (changed) await this.grantOwned(userId, item.item_id, 'admin');
		return {item_id: item.item_id.toString(), owned: true, equipped: wears(user, item), changed, unequipped: false};
	}

	// Pending deliveries of the item are revoked first, so a delivery that crashed half way never gives it back. The
	// user row is read again after the take-off: an equip that passed its ownership check before the delete is undone.
	async adminRevoke(userId: UserID, itemId: bigint): Promise<AdminUserCosmeticResponse> {
		const user = await this.deps.userRepository.findUnique(userId);
		if (!user) throw new UnknownUserError();
		const item = await this.requireItem(itemId);
		const pending = (await this.deps.repository.listGrants(userId)).filter(
			(grant) => grant.item_id === item.item_id && grant.state === 'pending',
		);
		await Promise.all(pending.map((grant) => this.deps.repository.revokePendingGrant(userId, grant.grant_key)));
		const changed = await this.isOwned(userId, item.item_id);
		if (changed) await this.deps.repository.deleteOwned(userId, item.item_id);
		const firstTakeOff = await this.takeOffIfUnwearable(user, item);
		const current = await this.deps.userRepository.findUnique(userId);
		const secondTakeOff = current ? await this.takeOffIfUnwearable(current, item) : false;
		return {
			item_id: item.item_id.toString(),
			owned: false,
			equipped: !secondTakeOff && current !== null && wears(current, item),
			changed,
			unequipped: firstTakeOff || secondTakeOff,
		};
	}

	async createItem(request: CosmeticItemCreateRequest): Promise<CosmeticItemResponse> {
		const itemId = await this.deps.snowflakeService.generate();
		const prepared = await this.deps.entityAssetService.prepareCosmeticAssetUpload(
			ownerKey({item_type: request.type, item_id: itemId}),
			request.asset,
			'asset',
			assetMaxBytes(request.type),
		);
		const item: CosmeticItemRow = {
			item_id: itemId,
			item_type: request.type,
			name: request.name,
			description: request.description ?? null,
			series: normalizeCosmeticSeriesName(request.series),
			asset_hash: uploadedHash(prepared),
			availability: request.availability,
			created_at: new Date(),
			ultra_layout: null,
			ultra_front: null,
			version: 1,
		};
		try {
			await this.deps.repository.putItem(item, true);
		} catch (error) {
			await this.deps.entityAssetService.rollbackAssetUpload(prepared);
			throw error;
		}
		this.catalogCache.delete(request.type);
		return mapItem(item);
	}

	// A new image gets a new hash next to the old one: accounts that wear the item keep the image they put on. The
	// in-front parts are read from the item, so wearers see a new set. Every image of the request is stored before the
	// one row write; a failure up to that write takes back what this request stored and the row does not use. Nothing
	// after the write may take anything back: the row names the new parts by then.
	async updateItem(itemId: bigint, request: CosmeticItemUpdateRequest): Promise<CosmeticItemResponse> {
		const item = await this.requireItem(itemId);
		if (request.ultra_layout !== undefined && item.item_type !== 'avatar_ultra') {
			throw InputValidationError.create('ultra_layout', 'Only ultra decorations have sizes');
		}
		if (request.ultra_front !== undefined && item.item_type !== 'avatar_ultra') {
			throw InputValidationError.create('ultra_front', 'Only ultra decorations draw in front');
		}
		if (request.ultra_front) assertOpeningBudget(request.ultra_front);
		const prepared: Array<PreparedAssetUpload> = [];
		const store: StorePart = async (base64, errorPath, maxBytes, shape) => {
			const upload = await this.deps.entityAssetService.prepareCosmeticAssetUpload(
				ownerKey(item),
				base64,
				errorPath,
				maxBytes,
				shape,
			);
			prepared.push(upload);
			return uploadedHash(upload);
		};
		let current = item;
		let updated: CosmeticItemRow;
		try {
			const front = request.ultra_front ? await storeUltraFront(request.ultra_front, store) : null;
			// Last, so a refused part never takes back a main image that wearers may still use.
			const assetHash = request.asset ? await store(request.asset, 'asset', assetMaxBytes(item.item_type)) : null;
			// The uploads take seconds: read the row again so a take-off-sale or another save in that time is kept.
			// TEMPORARY: a change between this read and the write is still lost (milliseconds); an IF version = ? write
			// closes it once several admins edit the catalog at the same time.
			current = await this.requireItem(itemId);
			updated = {
				...current,
				name: request.name ?? current.name,
				description: request.description === undefined ? current.description : request.description,
				series: request.series === undefined ? (current.series ?? null) : normalizeCosmeticSeriesName(request.series),
				availability: request.availability ?? current.availability,
				asset_hash: assetHash ?? current.asset_hash,
				// A row written before the column existed reads it as undefined, which must not be bound.
				ultra_layout:
					request.ultra_layout === undefined ? (current.ultra_layout ?? null) : toUltraLayoutMap(request.ultra_layout),
				ultra_front: request.ultra_front === undefined ? (current.ultra_front ?? null) : front,
				version: current.version + 1,
			};
			await this.deps.repository.putItem(
				updated,
				request.on_sale === true || (await this.deps.repository.isOnSale(current)),
			);
		} catch (error) {
			await this.rollbackUnused(current, prepared);
			throw error;
		}
		this.catalogCache.delete(item.item_type as CosmeticItemType);
		this.itemCache.delete(item.item_id);
		return mapItem(updated);
	}

	async retireItem(itemId: bigint): Promise<void> {
		const item = await this.requireItem(itemId);
		await this.deps.repository.takeOffSale(item);
		this.catalogCache.delete(item.item_type as CosmeticItemType);
		this.itemCache.delete(item.item_id);
	}

	// Account deletion hook: runs in the worker and may run again, so every step is safe to repeat.
	async deleteUserCosmetics(userId: UserID): Promise<void> {
		await this.deps.repository.deleteAllOwned(userId);
		const user = await this.deps.userRepository.findUnique(userId);
		if (!user) return;
		const row = user.toRow();
		const patch: Partial<UserRow> = {};
		for (const column of Object.values(USER_COLUMNS).flat()) {
			if (row[column] != null) Object.assign(patch, {[column]: null});
		}
		if (Object.keys(patch).length === 0) return;
		const updatedUser = await this.deps.userRepository.patchUpsert(userId, patch, row);
		await propagatePartialUserChange({userCacheService: this.deps.userCacheService}, updatedUser);
	}

	async harvestUserCosmetics(userId: UserID) {
		const [owned, user] = await Promise.all([
			this.deps.repository.listOwned(userId),
			this.deps.userRepository.findUnique(userId),
		]);
		const items = new Map(
			(await this.deps.repository.getItems(owned.map((row) => row.item_id))).map((item) => [item.item_id, item]),
		);
		return {
			owned: owned.map((row) => ({
				item_id: row.item_id.toString(),
				type: row.item_type,
				name: items.get(row.item_id)?.name ?? null,
				source: row.source,
				acquired_at: row.acquired_at.toISOString(),
			})),
			equipped: user
				? mapEquipped(user)
				: {avatar_decoration_id: null, avatar_ultra_id: null, profile_effect_id: null, nameplate_id: null},
		};
	}

	private async listCatalogType(type: CosmeticItemType): Promise<Array<CosmeticItemResponse>> {
		const cached = this.catalogCache.get(type);
		if (cached && cached.expiresAt > Date.now()) return cached.items;
		const items = (await this.deps.repository.listCatalog(type)).map(mapItem);
		this.catalogCache.set(type, {expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, items});
		return items;
	}

	private cacheItem(itemId: bigint, item: CosmeticItemResponse, now: number): void {
		if (this.itemCache.size >= ITEM_CACHE_MAX) {
			const oldest = this.itemCache.keys().next();
			if (!oldest.done) this.itemCache.delete(oldest.value);
		}
		this.itemCache.set(itemId, {expiresAt: now + CATALOG_CACHE_TTL_MS, item});
	}

	// Same bytes make the same object key, so an object the stored row still names is never deleted.
	private async rollbackUnused(item: CosmeticItemRow, prepared: ReadonlyArray<PreparedAssetUpload>): Promise<void> {
		const bare = (hash: string) => (hash.startsWith('a_') ? hash.slice(2) : hash);
		const inUse = new Set([item.asset_hash, ...(item.ultra_front?.values() ?? [])].map(bare));
		await Promise.all(
			prepared
				.filter((upload) => upload.newHash && !inUse.has(bare(upload.newHash)))
				.map((upload) => this.deps.entityAssetService.rollbackAssetUpload(upload)),
		);
	}

	private async requireLiveUser(userId: UserID): Promise<User> {
		const user = await this.deps.userRepository.findUnique(userId);
		if (!user || (user.flags & UserFlags.DELETED) !== 0n) throw new UnknownUserError();
		return user;
	}

	// A delivered item goes on in its own slot, without the equip rate limit; nothing is written if it is already on.
	private async wearDelivered(userId: UserID, item: CosmeticItemRow): Promise<void> {
		const user = await this.deps.userRepository.findUnique(userId);
		if (!user || wears(user, item)) return;
		const [idColumn, assetColumn] = USER_COLUMNS[item.item_type as CosmeticSlot];
		await this.writeSlot(user, {[idColumn]: item.item_id, [assetColumn]: item.asset_hash});
	}

	private async takeOffIfUnwearable(user: User, item: CosmeticItemRow): Promise<boolean> {
		if (!wears(user, item)) return false;
		if (item.availability === 'free' || (item.availability === 'premium' && checkIsPremium(user))) return false;
		const [idColumn, assetColumn] = USER_COLUMNS[item.item_type as CosmeticSlot];
		await this.writeSlot(user, {[idColumn]: null, [assetColumn]: null});
		return true;
	}

	private async writeSlot(user: User, patch: Partial<UserRow>): Promise<void> {
		const updatedUser = await this.deps.userRepository.patchUpsert(user.id, patch, user.toRow());
		await dispatchUserUpdate(this.deps.gatewayService, updatedUser);
		if (hasPartialUserFieldsChanged(user, updatedUser)) {
			await propagatePartialUserChange({userCacheService: this.deps.userCacheService}, updatedUser);
		}
	}

	private async requireItem(itemId: bigint): Promise<CosmeticItemRow> {
		const item = await this.deps.repository.getItem(itemId);
		if (!item) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		return item;
	}

	// Unknown items, items of another type and items the account may not wear all answer the same, so the answer
	// says nothing about which item IDs exist.
	private async requireWearable(user: User, type: CosmeticSlot, itemId: bigint): Promise<CosmeticItemRow> {
		const item = await this.deps.repository.getItem(itemId);
		if (!item || item.item_type !== type) throw new CosmeticNotOwnedError();
		if (item.availability === 'free') return item;
		if (item.availability === 'premium' && checkIsPremium(user)) return item;
		if (await this.deps.repository.getOwned(user.id, item.item_id)) return item;
		throw new CosmeticNotOwnedError();
	}
}
