// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {CreateShopOrderRequest} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';
import type {
	ShopCatalogResponse,
	ShopCodeResponse,
	ShopOrderResponse,
	ShopQuoteResponse,
} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';

export async function fetchCatalog(): Promise<ShopCatalogResponse> {
	const response = await http.get<ShopCatalogResponse>(Endpoints.SHOP_CATALOG);
	return response.body;
}

export async function fetchQuote(sku: string): Promise<ShopQuoteResponse> {
	const response = await http.get<ShopQuoteResponse>(Endpoints.SHOP_QUOTE, {query: {sku}});
	return response.body;
}

// The client names the product and nothing else: the server prices every order itself.
export async function createOrder(sku: string): Promise<ShopOrderResponse> {
	const body: CreateShopOrderRequest = {sku};
	const response = await http.post<ShopOrderResponse>(Endpoints.SHOP_ORDERS, {body});
	return response.body;
}

// Reads our own order record; the server asks Payriff, the client never does.
export async function fetchOrder(orderId: string): Promise<ShopOrderResponse> {
	const response = await http.get<ShopOrderResponse>(Endpoints.SHOP_ORDER(orderId));
	return response.body;
}

export async function fetchCode(code: string): Promise<ShopCodeResponse> {
	const response = await http.get<ShopCodeResponse>(Endpoints.SHOP_CODE(code));
	return response.body;
}
