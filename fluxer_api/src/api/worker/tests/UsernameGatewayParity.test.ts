// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, test} from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('-ifdef(TEST).')[0]!;

// Micup: these contracts check source parity; native behavior is covered by Erlang and Rust tests.
describe('username gateway source contracts', () => {
	test('the public partial whitelist adds only identity_version and name_style', () => {
		const source = read('fluxer_gateway/src/utils/user_utils.erl');
		const fields = source.match(/^partial_user_fields\(\) ->\s*\[([\s\S]*?)\]/m)?.[1];
		expect(fields).toBeDefined();
		expect([...fields!.matchAll(/<<"([^"]+)">>/g)].map((match) => match[1])).toEqual([
			'id',
			'username',
			'discriminator',
			'identity_version',
			'global_name',
			'avatar',
			'avatar_color',
			'bot',
			'system',
			'flags',
			'mention_flags',
			'avatar_decoration_data',
			'avatar_ultra_data',
			'nameplate_data',
			'name_style',
		]);
	});

	test('the identity merge drops only stale identity fields', () => {
		const source = read('fluxer_gateway/src/utils/user_utils.erl');
		expect(source).toContain('merge_user/2');
		expect(source).toContain('IncomingVersion < CurrentVersion');
		expect(source).toContain('maps:without(identity_fields(), Incoming)');
		expect(source).toContain('maps:merge(Current,');
	});

	test.each(['guild_voice_connection_token', 'dm_voice_token'])('%s preserves the RPC selection code', (module) => {
		expect(read(`fluxer_gateway/src/guild/voice/${module}.erl`)).toContain('gateway_errors:voice_token_error(Body)');
	});

	test.each(['guild_voice_connection_join', 'guild_voice_connection_move'])(
		'%s preserves selection token failures',
		(module) => {
			expect(read(`fluxer_gateway/src/guild/voice/${module}.erl`)).toContain(
				'gateway_errors:error(username_selection_required)',
			);
		},
	);

	test('the wire error and Rust public partial retain the exact public contract', () => {
		expect(read('fluxer_gateway/src/gateway/gateway_errors.erl')).toContain('<<"USERNAME_SELECTION_REQUIRED">>');
		const rust = read('fluxer_common/src/user_partial.rs').match(/pub struct ApiUserPartial \{([\s\S]*?)\n\}/)?.[1];
		expect(rust).toContain('pub identity_version: Option<String>');
		for (const field of ['username_state', 'change_available_at', 'free_change_available']) {
			expect(rust).not.toContain(`pub ${field}:`);
		}
	});
});
