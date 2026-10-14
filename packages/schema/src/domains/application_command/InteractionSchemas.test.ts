// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
import {
	InteractionCallbackRequest,
	InteractionFollowupRequest,
	InteractionInvokeRequest,
	InteractionInvokeResponse,
} from './InteractionSchemas';

const invoke = {
	application_id: '123',
	command_id: '456',
	command_version: '789',
	channel_id: '321',
	options: [],
	nonce: 'request-1',
	session_id: 'session-1',
};

describe('interaction invocation', () => {
	it('accepts the exact invocation contract', () => {
		expect(InteractionInvokeRequest.parse(invoke)).toEqual(invoke);
	});
	it.each([
		[3, 'metin'],
		[4, 123],
		[5, true],
		[6, '123'],
		[7, '456'],
		[8, '789'],
		[10, 1.25],
	])('preserves type %i values', (type, value) => {
		const options = [{name: 'seçenek', type, value}];
		expect(InteractionInvokeRequest.parse({...invoke, options}).options).toEqual(options);
	});
	it.each([
		[3, 123],
		[4, '123'],
		[4, 1.5],
		[4, Number.MAX_SAFE_INTEGER + 1],
		[5, 'true'],
		[6, 123],
		[6, '0'],
		[7, '1.5'],
		[8, '9223372036854775808'],
		[10, '1.25'],
		[10, Infinity],
		[10, NaN],
		[10, Number.MAX_SAFE_INTEGER + 1],
		[9, '123'],
	])('rejects type %i with value %j', (type, value) => {
		expect(InteractionInvokeRequest.safeParse({...invoke, options: [{name: 'seçenek', type, value}]}).success).toBe(
			false,
		);
	});
	it('bounds strings at 6000 code points and numeric values at safe extrema', () => {
		for (const length of [6000, 6001]) {
			expect(
				InteractionInvokeRequest.safeParse({...invoke, options: [{name: 'metin', type: 3, value: '😀'.repeat(length)}]})
					.success,
			).toBe(length === 6000);
		}
		for (const type of [4, 10]) {
			for (const value of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
				expect(InteractionInvokeRequest.safeParse({...invoke, options: [{name: 'sayı', type, value}]}).success).toBe(
					true,
				);
			}
		}
	});
	it('requires every context field and rejects unknown fields at every level', () => {
		for (const key of Object.keys(invoke)) {
			const missing = {...invoke} as Record<string, unknown>;
			delete missing[key];
			expect(InteractionInvokeRequest.safeParse(missing).success).toBe(false);
		}
		for (const extra of [{guild_id: '123'}, {token: 'secret'}, {user_id: '123'}]) {
			expect(InteractionInvokeRequest.safeParse({...invoke, ...extra}).success).toBe(false);
		}
		expect(
			InteractionInvokeRequest.safeParse({...invoke, options: [{name: 'x', type: 3, value: 'x', resolved: {}}]})
				.success,
		).toBe(false);
	});
	it('rejects invalid IDs and empty/unbounded nonce and session', () => {
		for (const field of ['application_id', 'command_id', 'command_version', 'channel_id']) {
			for (const value of ['0', '-1', '01', '1.5', '9223372036854775808', 123]) {
				expect(InteractionInvokeRequest.safeParse({...invoke, [field]: value}).success).toBe(false);
			}
		}
		for (const [field, max] of [
			['nonce', 32],
			['session_id', 64],
		] as const) {
			for (const value of ['', ' '.repeat(3), 'a'.repeat(max + 1), 123]) {
				expect(InteractionInvokeRequest.safeParse({...invoke, [field]: value}).success).toBe(false);
			}
		}
	});
	it('rejects duplicate normalized names and bounds options at 25/26', () => {
		expect(
			InteractionInvokeRequest.safeParse({
				...invoke,
				options: [
					{name: 'ç', type: 3, value: 'a'},
					{name: 'c\u0327', type: 3, value: 'b'},
				],
			}).success,
		).toBe(false);
		for (const count of [25, 26]) {
			expect(
				InteractionInvokeRequest.safeParse({
					...invoke,
					options: Array.from({length: count}, (_, i) => ({name: `x${i}`, type: 3, value: 'x'})),
				}).success,
			).toBe(count === 25);
		}
	});
});

describe('interaction callbacks and followups', () => {
	it('defaults content replies to public with no mentions', () => {
		expect(InteractionCallbackRequest.parse({type: 4, data: {content: 'yanıt'}})).toEqual({
			type: 4,
			data: {content: 'yanıt', flags: 0, allowed_mentions: {parse: []}},
		});
	});
	it.each([0, 64])('accepts content and defer visibility %i', (flags) => {
		expect(InteractionCallbackRequest.safeParse({type: 4, data: {content: 'yanıt', flags}}).success).toBe(true);
		expect(InteractionCallbackRequest.parse({type: 5, data: {flags}})).toEqual({type: 5, data: {flags}});
		expect(InteractionFollowupRequest.safeParse({content: 'takip', flags}).success).toBe(true);
	});
	it('defaults defer visibility and forbids content during defer', () => {
		expect(InteractionCallbackRequest.parse({type: 5})).toEqual({type: 5, data: {flags: 0}});
		expect(InteractionCallbackRequest.safeParse({type: 5, data: {content: 'yanıt'}}).success).toBe(false);
	});
	it.each([1, 2, 3, 6, '4'])('rejects callback type %j', (type) => {
		expect(InteractionCallbackRequest.safeParse({type, data: {content: 'yanıt'}}).success).toBe(false);
	});
	it.each([1, 65, -64, '64'])('rejects unsupported visibility flags %j', (flags) => {
		expect(InteractionCallbackRequest.safeParse({type: 4, data: {content: 'yanıt', flags}}).success).toBe(false);
		expect(InteractionCallbackRequest.safeParse({type: 5, data: {flags}}).success).toBe(false);
		expect(InteractionFollowupRequest.safeParse({content: 'yanıt', flags}).success).toBe(false);
	});
	it('requires content or an allowed text embed and rejects unknown nested fields', () => {
		expect(InteractionCallbackRequest.safeParse({type: 4, data: {}}).success).toBe(false);
		expect(InteractionCallbackRequest.safeParse({type: 4, data: {content: '   '}}).success).toBe(false);
		expect(
			InteractionCallbackRequest.safeParse({
				type: 4,
				data: {embeds: [{title: 'Başlık', fields: [{name: 'A', value: 'B'}]}]},
			}).success,
		).toBe(true);
		for (const data of [
			{content: 'yanıt', attachments: []},
			{content: 'yanıt', extra: true},
			{embeds: [{title: 'Başlık', extra: true}]},
			{embeds: [{title: 'Başlık', fields: [{name: 'A', value: 'B', extra: true}]}]},
			{content: 'yanıt', allowed_mentions: {parse: [], extra: true}},
			{embeds: [{image: {url: 'https://example.com/x.png'}}]},
			{embeds: [{url: 'https://example.com', title: 'Başlık'}]},
		])
			expect(InteractionCallbackRequest.safeParse({type: 4, data}).success).toBe(false);
		expect(InteractionCallbackRequest.safeParse({type: 4, data: {content: 'yanıt'}, extra: true}).success).toBe(false);
		expect(InteractionFollowupRequest.safeParse({content: 'yanıt', token: 'secret'}).success).toBe(false);
	});
	it('bounds response UTF-8 bytes', () => {
		const data = {embeds: Array.from({length: 10}, () => ({description: '😀'.repeat(1000)}))};
		expect(InteractionCallbackRequest.safeParse({type: 4, data}).success).toBe(false);
		expect(InteractionFollowupRequest.safeParse(data).success).toBe(false);
		expect(InteractionFollowupRequest.safeParse({embeds: data.embeds.slice(0, 1)}).success).toBe(true);
	});
	it('requires actual text in embed-only replies', () => {
		for (const embed of [{}, {color: 123}, {title: '   '}, {fields: []}]) {
			expect(InteractionFollowupRequest.safeParse({embeds: [embed]}).success).toBe(false);
		}
	});
	it('keeps explicit mention IDs as JSON strings', () => {
		const data = {content: 'yanıt', allowed_mentions: {users: ['123'], roles: ['456']}};
		const parsed = InteractionFollowupRequest.parse(data);
		expect(parsed.allowed_mentions).toEqual({...data.allowed_mentions, parse: []});
		expect(() => JSON.stringify(parsed)).not.toThrow();
		for (const id of [123, '0', '01', '9223372036854775808']) {
			expect(InteractionFollowupRequest.safeParse({...data, allowed_mentions: {users: [id]}}).success).toBe(false);
		}
	});
});

describe('invocation HTTP response', () => {
	it('exposes only ID, known delivery status and deadline, never token/options', () => {
		const response = {id: '123', status: 'ENQUEUED', deadline_at: '2026-10-08T10:00:03.000Z'};
		expect(InteractionInvokeResponse.parse(response)).toEqual(response);
		for (const status of ['RESERVED', 'PREPARED', 'DISPATCHING', 'NOT_DELIVERED', 'DELIVERY_UNKNOWN']) {
			expect(InteractionInvokeResponse.safeParse({...response, status}).success).toBe(true);
		}
		for (const extra of [
			{token: 'secret'},
			{options: []},
			{status: 'UNKNOWN'},
			{deadline_at: 'invalid'},
			{deadline_at: 123},
			{id: '0'},
		]) {
			expect(InteractionInvokeResponse.safeParse({...response, ...extra}).success).toBe(false);
		}
	});
});
