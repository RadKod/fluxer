// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {
	CosmeticCatalogResponse,
	CosmeticItemListResponse,
	EquippedCosmeticsResponse,
	UserCosmeticsResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';

// The settings tab shows every type at once, so one untyped request replaces three typed ones.
export async function fetchCatalog(): Promise<CosmeticCatalogResponse> {
	const response = await http.get<CosmeticCatalogResponse>(Endpoints.COSMETICS_CATALOG);
	return response.body;
}

// Point reads by ID, items taken off sale included; the server takes at most 50 IDs.
export async function fetchItems(ids: ReadonlyArray<string>): Promise<CosmeticItemListResponse> {
	const response = await http.get<CosmeticItemListResponse>(Endpoints.COSMETICS_ITEMS, {query: {ids: ids.join(',')}});
	return response.body;
}

export async function fetchUserCosmetics(): Promise<UserCosmeticsResponse> {
	const response = await http.get<UserCosmeticsResponse>(Endpoints.USER_COSMETICS);
	return response.body;
}

// Snowflakes go out as strings; the shared request schema types them as parsed (bigint).
export type EquipCosmeticsBody = Partial<
	Record<'avatar_decoration_id' | 'avatar_ultra_id' | 'profile_effect_id' | 'nameplate_id', string | null>
>;

// The worn avatar decoration, ultra decoration and nameplate come back through USER_UPDATE, like every other user field.
export async function equip(changes: EquipCosmeticsBody): Promise<EquippedCosmeticsResponse> {
	const response = await http.put<EquippedCosmeticsResponse>(Endpoints.USER_COSMETICS_EQUIPPED, {body: changes});
	return response.body;
}
