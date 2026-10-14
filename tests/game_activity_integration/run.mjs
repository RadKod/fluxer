// SPDX-License-Identifier: AGPL-3.0-or-later
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const temp = process.env.GAME_ACTIVITY_TEST_TMP ?? resolve(repository, 'node_modules/.cache/game-activity-integration');
const meck = process.env.GAME_ACTIVITY_MECK_EBIN ?? resolve(repository, 'fluxer_gateway/_build/test/lib/meck/ebin');
if (!existsSync(join(meck, 'meck.beam')))
	throw new Error(
		'Build existing gateway test dependencies or set GAME_ACTIVITY_MECK_EBIN to the installed meck ebin.',
	);
mkdirSync(join(temp, 'ebin'), {recursive: true});
const executable = (name) =>
	process.env.OTP_BIN ? join(process.env.OTP_BIN, process.platform === 'win32' ? `${name}.exe` : name) : name;
const modules = [
	'fluxer_gateway/src/presence/presence_game_activity.erl',
	'fluxer_gateway/src/presence/presence_game_activity_policy.erl',
	'fluxer_gateway/src/presence/presence_status.erl',
	'fluxer_gateway/src/session/session_game_activity.erl',
	'fluxer_gateway/src/session/session_game_activity_rollout.erl',
	'tests/game_activity_integration/game_activity_integration_bridge.erl',
];
function run(command, args, env = process.env) {
	const result = spawnSync(command, args, {cwd: repository, env, stdio: 'inherit'});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
run(executable('erlc'), ['-o', join(temp, 'ebin'), ...modules]);
const require = createRequire(resolve(repository, 'fluxer_app/package.json'));
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
run(
	process.execPath,
	[vitest, 'run', '--config', resolve(directory, 'vitest.config.mts'), '--maxWorkers=1', '--no-file-parallelism'],
	{
		...process.env,
		GAME_ACTIVITY_TEST_TMP: temp,
		GAME_ACTIVITY_MECK_EBIN: meck,
	},
);
