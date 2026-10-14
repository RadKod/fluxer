// SPDX-License-Identifier: AGPL-3.0-or-later

import {ALL_PERMISSIONS, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it} from 'vitest';
import {
	ApplicationCommandBulkOverwriteRequest,
	ApplicationCommandRequest,
	ApplicationCommandResponse,
	ApplicationCommandsUpdateEvent,
	GuildApplicationCommandBulkOverwriteRequest,
	GuildApplicationCommandRequest,
} from './ApplicationCommandSchemas';

const command = {name: 'yardım', description: 'Komut açıklaması'};
const option = {type: 3, name: 'seçenek', description: 'Seçenek açıklaması', required: false};
const options = (count: number) => Array.from({length: count}, (_, i) => ({...option, name: `seçenek${i}`}));
const choices = (count: number) => Array.from({length: count}, (_, i) => ({name: `Seçim ${i}`, value: `${i}`}));
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const serverFields = {
	id: '9223372036854775807',
	application_id: '9223372036854775807',
	version: '9223372036854775807',
	guild_id: '9223372036854775807',
};

function commandAtByteLength(bytes: number, name = 'command000') {
	const value = {
		type: 1,
		name,
		description: 'description',
		default_member_permissions: null,
		dm_permission: false,
		options: Array.from({length: Math.ceil(bytes / 2500)}, (_, index) => ({
			type: 3,
			name: `option${index}`,
			description: 'description',
			required: false,
			choices: Array.from({length: 25}, (_, choice) => ({name: `choice${choice}`, value: ''})),
		})),
	};
	let remaining = bytes - jsonBytes(value);
	for (const entry of value.options.flatMap(({choices}) => choices)) {
		const length = Math.min(100, remaining);
		entry.value = 'x'.repeat(length);
		remaining -= length;
	}
	expect(remaining).toBe(0);
	expect(jsonBytes(value)).toBe(bytes);
	return value;
}

describe('application command registration', () => {
	it('normalizes NFC, preserves Turkish letters and sets safe defaults', () => {
		expect(ApplicationCommandRequest.parse({...command, name: 'c\u0327ıg\u0306öşü-i'})).toEqual({
			...command,
			name: 'çığöşü-i',
			type: 1,
			options: [],
			dm_permission: false,
			default_member_permissions: null,
		});
	});
	it.each(['', 'BÜYÜK', 'İsim', 'iki kelime', 'emoji😀', 'nokta.ad', '\ud800'])('rejects invalid name %j', (name) => {
		expect(ApplicationCommandRequest.safeParse({...command, name}).success).toBe(false);
	});
	it('counts name code points rather than UTF-16 units at 32/33', () => {
		expect(ApplicationCommandRequest.safeParse({...command, name: '𐐨'.repeat(32)}).success).toBe(true);
		expect(ApplicationCommandRequest.safeParse({...command, name: '𐐨'.repeat(33)}).success).toBe(false);
	});
	it('bounds descriptions at 1/100/101 code points', () => {
		expect(ApplicationCommandRequest.safeParse({...command, description: '😀'.repeat(100)}).success).toBe(true);
		for (const description of ['', '😀'.repeat(101)]) {
			expect(ApplicationCommandRequest.safeParse({...command, description}).success).toBe(false);
		}
	});
	it.each([3, 4, 5, 6, 7, 8, 10])('accepts option type %i', (type) => {
		expect(ApplicationCommandRequest.safeParse({...command, options: [{...option, type}]}).success).toBe(true);
	});
	it.each([1, 2, 9, 11, '3'])('rejects unsupported option type %j', (type) => {
		expect(ApplicationCommandRequest.safeParse({...command, options: [{...option, type}]}).success).toBe(false);
	});
	it('requires required options before optional ones and unique normalized names', () => {
		const required = {...option, name: 'önce', required: true};
		expect(ApplicationCommandRequest.safeParse({...command, options: [required, option]}).success).toBe(true);
		expect(ApplicationCommandRequest.safeParse({...command, options: [option, required]}).success).toBe(false);
		expect(
			ApplicationCommandRequest.safeParse({...command, options: [option, {...option, name: 'sec\u0327enek'}]}).success,
		).toBe(false);
	});
	it('bounds options and choices at 25/26', () => {
		for (const count of [25, 26]) {
			expect(ApplicationCommandRequest.safeParse({...command, options: options(count)}).success).toBe(count === 25);
			expect(
				ApplicationCommandRequest.safeParse({...command, options: [{...option, choices: choices(count)}]}).success,
			).toBe(count === 25);
		}
	});
	it('bounds option names, descriptions, choice names and string values', () => {
		for (const invalid of [
			{...option, name: 'a'.repeat(33)},
			{...option, description: 'a'.repeat(101)},
			{...option, choices: [{name: '', value: 'a'}]},
			{...option, choices: [{name: 'a'.repeat(101), value: 'a'}]},
			{...option, choices: [{name: 'a', value: 'a'.repeat(101)}]},
		])
			expect(ApplicationCommandRequest.safeParse({...command, options: [invalid]}).success).toBe(false);
		expect(
			ApplicationCommandRequest.safeParse({
				...command,
				options: [{...option, choices: [{name: '😀'.repeat(100), value: '😀'.repeat(100)}]}],
			}).success,
		).toBe(true);
	});
	it('preserves numeric choice values and rejects mismatched types', () => {
		for (const type of [4, 10]) {
			const numeric = {...option, type, choices: [{name: 'Sayı', value: 12}]};
			expect(ApplicationCommandRequest.parse({...command, options: [numeric]}).options[0]).toEqual(numeric);
			expect(
				ApplicationCommandRequest.safeParse({
					...command,
					options: [{...numeric, choices: [{name: 'Sayı', value: '12'}]}],
				}).success,
			).toBe(false);
		}
		for (const type of [3, 5, 6, 7, 8]) {
			expect(
				ApplicationCommandRequest.safeParse({
					...command,
					options: [{...option, type, choices: [{name: 'Sayı', value: 12}]}],
				}).success,
			).toBe(false);
		}
	});
	it('rejects unsafe integers and nonfinite/out of range numbers in choices', () => {
		for (const [type, values] of [
			[4, [1.5, Number.MAX_SAFE_INTEGER + 1]],
			[10, [Infinity, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1]],
		] as const) {
			for (const value of values)
				expect(
					ApplicationCommandRequest.safeParse({
						...command,
						options: [{...option, type, choices: [{name: 'Sayı', value}]}],
					}).success,
				).toBe(false);
		}
	});
	it('rejects unknown fields at root, option and choice levels', () => {
		for (const input of [
			{...command, injected: true},
			{...command, type: 2},
			{...command, options: [{...option, options: []}]},
			{...command, options: [{...option, autocomplete: true}]},
			{...command, options: [{...option, choices: [{name: 'A', value: 'a', extra: true}]}]},
		])
			expect(ApplicationCommandRequest.safeParse(input).success).toBe(false);
	});
	it('preserves null and zero permissions and supports exactly the existing bit mask', () => {
		for (const value of [null, '0', String(Permissions.SEND_MESSAGES), String(ALL_PERMISSIONS)]) {
			expect(
				ApplicationCommandRequest.parse({...command, default_member_permissions: value}).default_member_permissions,
			).toBe(value);
		}
	});
	it.each([
		'-1',
		'1.5',
		' 1',
		'+1',
		'1e3',
		'00',
		'01',
		'0'.repeat(21),
		'18446744073709551616',
		String(1n << 19n),
		0,
		false,
	])('rejects invalid permission bitset %j', (value) => {
		expect(ApplicationCommandRequest.safeParse({...command, default_member_permissions: value}).success).toBe(false);
	});
	it('allows opt-in DM only for global commands', () => {
		expect(ApplicationCommandRequest.safeParse({...command, dm_permission: true}).success).toBe(true);
		expect(GuildApplicationCommandRequest.parse(command).dm_permission).toBe(false);
		expect(GuildApplicationCommandRequest.safeParse({...command, dm_permission: true}).success).toBe(false);
		expect(GuildApplicationCommandBulkOverwriteRequest.safeParse([{...command, dm_permission: true}]).success).toBe(
			false,
		);
	});
	it('bounds each scope at 100 commands and rejects duplicate normalized names', () => {
		for (const count of [100, 101]) {
			expect(
				ApplicationCommandBulkOverwriteRequest.safeParse(
					Array.from({length: count}, (_, i) => ({...command, name: `komut${i}`})),
				).success,
			).toBe(count === 100);
		}
		expect(ApplicationCommandBulkOverwriteRequest.safeParse([command, {...command, name: 'yardım'}]).success).toBe(
			false,
		);
		expect(ApplicationCommandBulkOverwriteRequest.safeParse([]).success).toBe(true);
	});
	it('bounds UTF-8 command and scope snapshots independently of structural limits', () => {
		const large = {
			...command,
			options: options(25).map((entry) => ({
				...entry,
				choices: choices(25).map((choice) => ({...choice, value: '😀'.repeat(100)})),
			})),
		};
		expect(ApplicationCommandRequest.safeParse(large).success).toBe(false);
		const bounded = {...command, options: options(25).map((entry) => ({...entry, description: '😀'.repeat(100)}))};
		expect(ApplicationCommandRequest.safeParse(bounded).success).toBe(true);
		expect(
			ApplicationCommandBulkOverwriteRequest.safeParse(
				Array.from({length: 100}, (_, i) => ({...bounded, name: `komut${i}`})),
			).success,
		).toBe(false);
	});
	it.each([ApplicationCommandRequest, GuildApplicationCommandRequest])(
		'reserves all server IDs before accepting a command at the UTF-8 boundary',
		(schema) => {
			const tooLarge = commandAtByteLength(32638);
			expect(jsonBytes({...tooLarge, ...serverFields})).toBe(32769);
			expect(ApplicationCommandResponse.safeParse({...tooLarge, ...serverFields}).success).toBe(false);
			expect(schema.safeParse(tooLarge).success).toBe(false);

			const boundary = commandAtByteLength(32637);
			const parsed = schema.parse(boundary);
			expect(jsonBytes({...parsed, ...serverFields})).toBe(32768);
			expect(ApplicationCommandResponse.safeParse({...parsed, ...serverFields}).success).toBe(true);
		},
	);
	it.each([ApplicationCommandBulkOverwriteRequest, GuildApplicationCommandBulkOverwriteRequest])(
		'reserves every command metadata field before accepting a scope snapshot',
		(schema) => {
			const snapshot = Array.from({length: 100}, (_, index) =>
				commandAtByteLength(index === 99 ? 5098 : 5111, `command${String(index).padStart(3, '0')}`),
			);
			for (const entry of snapshot) expect(ApplicationCommandRequest.safeParse(entry).success).toBe(true);
			expect(jsonBytes(snapshot)).toBe(511188);
			expect(jsonBytes(snapshot.map((entry) => ({...entry, ...serverFields})))).toBe(524288);
			expect(schema.safeParse(snapshot).success).toBe(true);

			snapshot[99] = commandAtByteLength(5099, 'command099');
			expect(jsonBytes(snapshot)).toBe(511189);
			expect(jsonBytes(snapshot.map((entry) => ({...entry, ...serverFields})))).toBe(524289);
			expect(schema.safeParse(snapshot).success).toBe(false);
		},
	);
});

describe('command responses', () => {
	const response = {...command, id: '123', application_id: '456', version: '789'};
	it('requires IDs and never exposes the internal scope sentinel', () => {
		expect(ApplicationCommandResponse.safeParse(response).success).toBe(true);
		expect(ApplicationCommandResponse.safeParse({...response, guild_id: '1234'}).success).toBe(true);
		for (const field of ['id', 'application_id', 'version', 'guild_id']) {
			for (const value of ['0', '-1', '01', '9223372036854775808', 123]) {
				expect(ApplicationCommandResponse.safeParse({...response, [field]: value}).success).toBe(false);
			}
		}
		expect(ApplicationCommandResponse.safeParse({...response, scope_id: '0'}).success).toBe(false);
		expect(ApplicationCommandResponse.safeParse(command).success).toBe(false);
		expect(ApplicationCommandResponse.safeParse({...response, guild_id: '1234', dm_permission: true}).success).toBe(
			false,
		);
	});
	it('accepts only content-free guild catalog invalidations', () => {
		const event = {application_id: '123', scope_id: '456', version: '789'};
		expect(ApplicationCommandsUpdateEvent.safeParse(event).success).toBe(true);
		expect(ApplicationCommandsUpdateEvent.safeParse({...event, scope_id: '0'}).success).toBe(false);
		expect(ApplicationCommandsUpdateEvent.safeParse({...event, commands: [response]}).success).toBe(false);
	});
});
