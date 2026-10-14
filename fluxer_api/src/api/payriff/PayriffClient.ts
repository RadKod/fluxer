// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {z} from 'zod';

export interface PayriffClientConfig {
	secretKey: string;
	baseUrl: string;
	timeoutMs: number;
}

// APPROVED is documented, PAID shows up in the order information example; both are paid.
export const PAYRIFF_PAID_STATUSES: ReadonlySet<string> = new Set(['APPROVED', 'PAID']);

export type PayriffCreateResult =
	| {kind: 'ok'; providerOrderId: string; paymentUrl: string}
	| {kind: 'rate_limited'}
	| {kind: 'failed'};
export type PayriffOrderResult =
	| {kind: 'ok'; paymentStatus: string; operationType: string; amountMinor: number; currency: string}
	| {kind: 'rate_limited'}
	| {kind: 'transient'}
	| {kind: 'not_found'};

type PayriffOperation = 'create' | 'get';

interface PayriffHttpAnswer {
	status: number;
	body: unknown;
}

const SUCCESS_CODE = '00000';
const DESCRIPTION_MAX_CHARS = 200;
const RESULT_CODE_PATTERN = /^\d{5}$/u;

// Payriff decides success by `code` alone. The payment page URL is opened by the client: https only.
const CreateOrderResponse = z.object({
	code: z.literal(SUCCESS_CODE),
	payload: z.object({orderId: z.string().min(1), paymentUrl: z.url({protocol: /^https$/u})}),
});
const GetOrderResponse = z.object({
	code: z.literal(SUCCESS_CODE),
	payload: z.object({
		paymentStatus: z.string(),
		operationType: z.string(),
		amount: z.union([
			z.number().nonnegative(),
			z
				.string()
				.regex(/^\d+(\.\d+)?$/u)
				.transform(Number),
		]),
		currencyType: z.string(),
	}),
});

// The Payriff v3 order API. A payment is only what getOrder reads; a callback is never trusted.
// Logs carry the operation, the HTTP status and Payriff's result code: never the key, a header, a body, the
// description, a URL or an error object.
export class PayriffClient {
	private readonly baseUrl: string;

	constructor(private readonly config: PayriffClientConfig) {
		// The secret key rides in the Authorization header of every request.
		if (new URL(config.baseUrl).protocol !== 'https:') {
			throw new Error('The Payriff base URL must use https');
		}
		this.baseUrl = config.baseUrl.replace(/\/+$/u, '');
	}

	// sanalyer: the currency comes from the order (TRY) instead of a fixed AZN, so a dormant Payriff never charges a
	// kuruş amount as manat; Payriff refuses currencies it does not support and the order fails as provider_error.
	async createOrder(input: {
		amountMinor: number;
		currency: string;
		description: string;
		callbackUrl: string;
	}): Promise<PayriffCreateResult> {
		const answer = await this.send('create', '/orders', {
			amount: Number((input.amountMinor / 100).toFixed(2)),
			language: 'EN',
			currency: input.currency,
			description: [...input.description].slice(0, DESCRIPTION_MAX_CHARS).join(''),
			callbackUrl: input.callbackUrl,
			cardSave: false,
			operation: 'PURCHASE',
		});
		if (answer === null) return {kind: 'failed'};
		const parsed = CreateOrderResponse.safeParse(answer.body);
		if (answer.status !== 200 || !parsed.success) {
			logFailure('create', answer);
			return answer.status === 429 ? {kind: 'rate_limited'} : {kind: 'failed'};
		}
		return {kind: 'ok', providerOrderId: parsed.data.payload.orderId, paymentUrl: parsed.data.payload.paymentUrl};
	}

	async getOrder(providerOrderId: string): Promise<PayriffOrderResult> {
		const answer = await this.send('get', `/orders/${encodeURIComponent(providerOrderId)}`);
		if (answer === null) return {kind: 'transient'};
		const parsed = GetOrderResponse.safeParse(answer.body);
		if (answer.status !== 200 || !parsed.success) {
			logFailure('get', answer);
			if (answer.status === 429) return {kind: 'rate_limited'};
			return answer.status === 404 ? {kind: 'not_found'} : {kind: 'transient'};
		}
		const {paymentStatus, operationType, amount, currencyType} = parsed.data.payload;
		return {kind: 'ok', paymentStatus, operationType, amountMinor: Math.round(amount * 100), currency: currencyType};
	}

	private async send(operation: PayriffOperation, path: string, body?: object): Promise<PayriffHttpAnswer | null> {
		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers:
					body === undefined
						? {Authorization: this.config.secretKey}
						: {Authorization: this.config.secretKey, 'Content-Type': 'application/json'},
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: 'manual',
				signal: AbortSignal.timeout(this.config.timeoutMs),
			});
			return {status: response.status, body: await response.json().catch(() => null)};
		} catch (error) {
			Logger.warn({operation, errorName: error instanceof Error ? error.name : 'unknown'}, 'Payriff request failed');
			return null;
		}
	}
}

function logFailure(operation: PayriffOperation, answer: PayriffHttpAnswer): void {
	const code = (answer.body as {code?: unknown} | null)?.code;
	const resultCode = typeof code === 'string' && RESULT_CODE_PATTERN.test(code) ? code : null;
	Logger.warn({operation, httpStatus: answer.status, resultCode}, 'Payriff request failed');
}
