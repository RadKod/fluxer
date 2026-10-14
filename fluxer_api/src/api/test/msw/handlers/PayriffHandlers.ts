// SPDX-License-Identifier: AGPL-3.0-or-later

import {delay, HttpResponse, http, type RequestHandler} from 'msw';

type FakePayriffOperation = 'create' | 'get';
type FakePayriffFailure = 'rate_limit' | 'server_error' | 'bad_code' | 'timeout';

interface FakePayriffOrder {
	amount: number;
	currencyType: string;
	paymentStatus: string;
}

interface FakePayriffCall {
	operation: FakePayriffOperation;
	// The order the call was about: the path ID of a get, the ID a create handed out (null when the create failed).
	providerOrderId: string | null;
	authorization: string | null;
	body: unknown;
}

const BASE_URL = 'https://payriff.test/api/v3';
const SECRET_KEY = 'payriff-test-secret-key-0123456789';

// The documented v3 order API: POST /orders and GET /orders/{id}, results in `code`.
class MswPayriffServer {
	readonly baseUrl = BASE_URL;
	readonly secretKey = SECRET_KEY;
	private readonly orders = new Map<string, FakePayriffOrder>();
	private readonly pendingFailures: Record<FakePayriffOperation, Array<FakePayriffFailure>> = {create: [], get: []};
	private recordedCalls: Array<FakePayriffCall> = [];
	private orderCounter = 1;

	reset(): void {
		this.orders.clear();
		this.pendingFailures.create = [];
		this.pendingFailures.get = [];
		this.recordedCalls = [];
		this.orderCounter = 1;
	}

	// Also seeds an order that only exists in the database (amount 0 AZN until setAmount).
	setStatus(providerOrderId: string, paymentStatus: string): void {
		this.order(providerOrderId).paymentStatus = paymentStatus;
	}

	setAmount(providerOrderId: string, amount: number, currency?: string): void {
		const order = this.order(providerOrderId);
		order.amount = amount;
		if (currency !== undefined) order.currencyType = currency;
	}

	failNext(operation: FakePayriffOperation, mode: FakePayriffFailure): void {
		this.pendingFailures[operation].push(mode);
	}

	calls(): ReadonlyArray<FakePayriffCall> {
		return [...this.recordedCalls];
	}

	createHandlers(): Array<RequestHandler> {
		return [
			http.post(`${BASE_URL}/orders`, ({request}) => this.handleCreate(request)),
			http.get(`${BASE_URL}/orders/:orderId`, ({request, params}) => this.handleGet(request, String(params.orderId))),
		];
	}

	private async handleCreate(request: Request): Promise<HttpResponse<Record<string, unknown>>> {
		const body = (await request.json()) as {amount?: unknown; currency?: unknown};
		const call: FakePayriffCall = {operation: 'create', providerOrderId: null, authorization: auth(request), body};
		this.recordedCalls.push(call);
		const failure = await this.fail('create');
		if (failure) return failure;
		const orderId = `payriff-order-${this.orderCounter}`;
		this.orders.set(orderId, {
			amount: Number(body.amount),
			currencyType: String(body.currency),
			paymentStatus: 'CREATED',
		});
		call.providerOrderId = orderId;
		return HttpResponse.json({
			code: '00000',
			message: 'Operation performed successfully',
			payload: {
				orderId,
				sessionId: orderId,
				paymentUrl: `https://pay.payriff.test/r/${orderId}?type=direct`,
				transactionId: this.orderCounter++,
			},
		});
	}

	private async handleGet(request: Request, orderId: string): Promise<HttpResponse<Record<string, unknown>>> {
		this.recordedCalls.push({operation: 'get', providerOrderId: orderId, authorization: auth(request), body: null});
		const failure = await this.fail('get');
		if (failure) return failure;
		const order = this.orders.get(orderId);
		if (!order) return HttpResponse.json({code: '15400'}, {status: 404});
		return HttpResponse.json({
			code: '00000',
			payload: {orderId, ...order, operationType: 'PURCHASE', transactions: []},
		});
	}

	private async fail(operation: FakePayriffOperation): Promise<HttpResponse<Record<string, unknown>> | null> {
		const mode = this.pendingFailures[operation].shift();
		switch (mode) {
			case undefined:
				return null;
			case 'rate_limit':
				return HttpResponse.json({code: '15000'}, {status: 429});
			case 'server_error':
				return HttpResponse.json({code: '15000'}, {status: 500});
			case 'bad_code':
				return HttpResponse.json({code: '15000'});
			case 'timeout':
				// Longer than the client's 10 s timeout; the late answer changes no fake state.
				await delay(30_000);
				return HttpResponse.json({code: '15000'}, {status: 504});
		}
	}

	private order(providerOrderId: string): FakePayriffOrder {
		let order = this.orders.get(providerOrderId);
		if (!order) {
			order = {amount: 0, currencyType: 'AZN', paymentStatus: 'CREATED'};
			this.orders.set(providerOrderId, order);
		}
		return order;
	}
}

function auth(request: Request): string | null {
	return request.headers.get('authorization');
}

export const fakePayriffServer = new MswPayriffServer();

export function createPayriffHandlers(): Array<RequestHandler> {
	return fakePayriffServer.createHandlers();
}
