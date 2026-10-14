// SPDX-License-Identifier: AGPL-3.0-or-later

import {GatewayRpcClient} from '@app/api/infrastructure/GatewayRpcClient';
import {GatewayRpcMethodError, GatewayRpcMethodErrorCodes} from '@app/api/infrastructure/GatewayRpcError';
import {GatewayService} from '@app/api/infrastructure/GatewayService';
import {BadGatewayError} from '@fluxer/errors/src/domains/core/BadGatewayError';
import {GatewayTimeoutError} from '@fluxer/errors/src/domains/core/GatewayTimeoutError';
import type {GameActivityPolicyAck, GameActivityPolicyRequest} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {afterEach, describe, expect, it, vi} from 'vitest';

const request: GameActivityPolicyRequest = {
	user_id: '2',
	owner_epoch: 'previous-owner',
	request_id: 'persisted-close',
	phase: 'apply',
	policy_revision: '1',
	visibility: 'off',
	eligible_16_plus: true,
	effective_profile_audience: 'everyone',
};
const ack: GameActivityPolicyAck = {
	owner_epoch: 'replacement-owner',
	request_id: request.request_id,
	phase: request.phase,
	policy_revision: request.policy_revision,
	revoked_sessions: 0,
};

function serviceReturning(call: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
	GatewayRpcClient.createForTests({call, async destroy() {}});
	return new GatewayService();
}

afterEach(async () => {
	await GatewayRpcClient.resetForTests();
	vi.useRealTimers();
});

describe('game activity policy acknowledgements', () => {
	it('accepts the current owner epoch for a persisted user policy apply', async () => {
		const service = serviceReturning(async () => ack);
		await expect(service.gameActivityPolicy(request)).resolves.toEqual(ack);
	});

	it('keeps a supplied fence epoch bound to its acknowledgement', async () => {
		const service = serviceReturning(async () => ({...ack, phase: 'fence'}));
		await expect(service.gameActivityPolicy({...request, phase: 'fence'})).rejects.toBeInstanceOf(BadGatewayError);
	});

	it.each([{request_id: 'unrelated-request'}, {phase: 'fence'}, {policy_revision: '0'}])(
		'rejects a mismatched apply acknowledgement %j',
		async (mismatch) => {
			const call = vi.fn(async () => ({...ack, ...mismatch}));
			const service = serviceReturning(call);
			await expect(service.gameActivityPolicy(request)).rejects.toBeInstanceOf(BadGatewayError);
			expect(call).toHaveBeenCalledTimes(1);
		},
	);

	it.each([{owner_epoch: 'replacement-owner'}, {pair_generation: '2'}])(
		'keeps pair apply bound to its fence %j',
		async (mismatch) => {
			const pairRequest = {
				owner_id: '2',
				viewer_id: '1',
				owner_epoch: 'previous-owner',
				pair_generation: '1',
				request_id: 'pair-close',
				phase: 'apply' as const,
			};
			const pairAck = {
				owner_epoch: pairRequest.owner_epoch,
				pair_generation: pairRequest.pair_generation,
				request_id: pairRequest.request_id,
				phase: pairRequest.phase,
			};
			const service = serviceReturning(async () => ({...pairAck, ...mismatch}));
			await expect(service.gameActivityPairPolicy(pairRequest)).rejects.toBeInstanceOf(BadGatewayError);
		},
	);

	it('retries unavailable delivery to the current owner until the existing apply deadline', async () => {
		vi.useFakeTimers();
		const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
			expect(params).toEqual(request);
			if (call.mock.calls.length < 5) throw new GatewayRpcMethodError(GatewayRpcMethodErrorCodes.NO_RESPONDERS);
			return ack;
		});
		const result = serviceReturning(call)
			.gameActivityPolicy(request)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(2500);
		expect(await result).toEqual(ack);
		expect(call).toHaveBeenCalledTimes(5);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('retries an early transport timeout without changing the apply identity', async () => {
		vi.useFakeTimers();
		const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
			expect(params).toEqual(request);
			if (call.mock.calls.length === 1) throw new GatewayRpcMethodError(GatewayRpcMethodErrorCodes.TIMEOUT);
			return ack;
		});
		const result = serviceReturning(call)
			.gameActivityPolicy(request)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toEqual(ack);
		expect(call).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('retries a lost transport connection within the apply deadline', async () => {
		vi.useFakeTimers();
		const call = vi.fn(async () => {
			if (call.mock.calls.length === 1) throw new Error('connection lost');
			return ack;
		});
		const result = serviceReturning(call)
			.gameActivityPolicy(request)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toEqual(ack);
		expect(call).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not retry a malformed acknowledgement', async () => {
		const call = vi.fn(async () => ({...ack, owner_epoch: ''}));
		await expect(serviceReturning(call).gameActivityPolicy(request)).rejects.toThrow();
		expect(call).toHaveBeenCalledTimes(1);
	});

	it('does not retry an unrelated transport failure', async () => {
		const failure = new Error('invalid request');
		const call = vi.fn(async () => {
			throw failure;
		});
		await expect(serviceReturning(call).gameActivityPolicy(request)).rejects.toBe(failure);
		expect(call).toHaveBeenCalledTimes(1);
	});

	it('does not reset the deadline while retrying unavailable policy delivery', async () => {
		vi.useFakeTimers();
		const call = vi.fn(async () => {
			throw new GatewayRpcMethodError(GatewayRpcMethodErrorCodes.NO_RESPONDERS);
		});
		const result = serviceReturning(call)
			.gameActivityPolicy(request)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(4999);
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toBeInstanceOf(GatewayTimeoutError);
		const callsAtDeadline = call.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(call).toHaveBeenCalledTimes(callsAtDeadline);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('waits for a healthy 150ms receiver acknowledgement', async () => {
		vi.useFakeTimers();
		const service = serviceReturning(() => new Promise((resolve) => setTimeout(() => resolve(ack), 150)));
		const result = service.gameActivityPolicy(request).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(150);
		expect(await result).toEqual(ack);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('fails a missing acknowledgement at five seconds and clears its deadline timer', async () => {
		vi.useFakeTimers();
		const service = serviceReturning(() => new Promise(() => {}));
		const result = service.gameActivityPolicy(request).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await result).toBeInstanceOf(GatewayTimeoutError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not retry a rejected policy revision', async () => {
		const call = vi.fn(async () => {
			throw new GatewayRpcMethodError('game_activity_policy_unavailable');
		});
		await expect(serviceReturning(call).gameActivityPolicy(request)).rejects.toBeInstanceOf(BadGatewayError);
		expect(call).toHaveBeenCalledTimes(1);
	});

	it('keeps timeout failure when an in-flight transport acknowledges after the deadline', async () => {
		vi.useFakeTimers();
		const call = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(ack), 5100)));
		const result = serviceReturning(call)
			.gameActivityPolicy(request)
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await result).toBeInstanceOf(GatewayTimeoutError);
		await vi.advanceTimersByTimeAsync(1000);
		expect(call).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
