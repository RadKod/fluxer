// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/build-desktop.yaml', import.meta.url), 'utf8');
const appleSecrets = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];

function job(name) {
	const start = workflow.indexOf(`\n  ${name}:\n`);
	assert.notEqual(start, -1, `Missing ${name} job`);
	return workflow.slice(start).split(/\n {2}[a-z_]+:\n/)[1];
}

function step(body, name) {
	const start = body.indexOf(`      - name: ${name}\n`);
	assert.notEqual(start, -1, `Missing ${name} step`);
	return body.slice(start).split(/\n {6}- /)[0];
}

test('macOS is excluded before scheduling when any Apple signing or notarization input is absent', () => {
	const matrix = job('matrix');
	const guard = step(matrix, 'Resolve available platforms');
	const script = guard
		.split('        run: |\n')[1]
		?.split('\n')
		.map((line) => line.slice(10))
		.join('\n');
	assert.ok(script, 'Platform guard must run before the matrix helper');
	assert.ok(matrix.indexOf('Resolve available platforms') < matrix.indexOf('Build platform matrix'));
	for (const secret of appleSecrets) {
		assert.ok(guard.includes(`${secret}: \${{ secrets.${secret} }}`), `${secret} must reach the guard`);
	}
	assert.match(step(matrix, 'Build platform matrix'), /--skip-targets "\$\{SKIP_TARGETS\}"/);
	assert.match(
		step(matrix, 'Build platform matrix'),
		/SKIP_TARGETS: \$\{\{ steps\.targets\.outputs\.skip_targets \}\}/,
	);

	const directory = mkdtempSync(path.join(os.tmpdir(), 'desktop-matrix-'));
	try {
		for (const missing of [null, ...appleSecrets, 'all']) {
			const output = path.join(directory, `output-${missing ?? 'ready'}`);
			const values = Object.fromEntries(
				appleSecrets.map((name) => [name, missing === name || missing === 'all' ? '' : 'synthetic-value']),
			);
			const requested = 'windows,linux-arm64';
			const result = spawnSync('bash', ['-c', script], {
				encoding: 'utf8',
				env: {PATH: process.env.PATH, ...values, SKIP_TARGETS: requested, GITHUB_OUTPUT: output},
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(readFileSync(output, 'utf8').trim(), `skip_targets=${requested}${missing === null ? '' : ',macos'}`);
			assert.equal(result.stdout.includes('synthetic-value'), false, 'The guard must not print secrets');
			if (missing !== null) assert.match(result.stdout, /macOS.*skip/i);
		}
	} finally {
		rmSync(directory, {recursive: true, force: true});
	}
});

test('preparation is the default and partial payloads bypass the complete-release validator', () => {
	const inputs = workflow.split('\npermissions:')[0];
	assert.match(inputs, /publish_release:\n(?:[^\n]*\n)*? {8}type: boolean\n {8}default: false/);
	const upload = job('upload');
	assert.match(step(upload, 'Upload prepared desktop payload'), /path: payload_tree\/desktop/);
	for (const name of ['Prepare GitHub release assets', 'Upload GitHub release assets']) {
		assert.match(step(upload, name), /if: \$\{\{ inputs\.publish_release \}\}/);
	}
	assert.match(step(upload, 'Build summary'), /if: \$\{\{ inputs\.publish_release \}\}/);
	assert.match(step(upload, 'Build preparation summary'), /if: \$\{\{ !inputs\.publish_release \}\}/);
	assert.match(step(upload, 'Build preparation summary'), /No release was published/);
	assert.match(
		job('publish_release'),
		/if: \$\{\{ !cancelled\(\) && inputs\.publish_release && needs\.upload\.result == 'success' \}\}/,
	);
});

test('metadata and matrix use the triggering commit without requiring an upstream GitHub App token', () => {
	assert.match(step(job('meta'), 'Checkout source'), /ref: \$\{\{ github\.sha \}\}/);
	assert.match(step(job('matrix'), 'Checkout source'), /ref: \$\{\{ github\.sha \}\}/);
	assert.match(job('meta'), /source_sha: \$\{\{ steps\.meta\.outputs\.source_sha \}\}/);
	assert.match(job('build'), /ref: \$\{\{ needs\.meta\.outputs\.source_sha \}\}/);
	assert.doesNotMatch(job('meta'), /create-github-app-token|FLUXER_CI_APP_KEY|GH_TOKEN/);
});

test('prepared Linux feeds use the Micup origin and retain the existing artifact handoff', () => {
	assert.match(workflow.split('\njobs:')[0], /FLUXER_DESKTOP_PACKAGE_ORIGIN_BASE: https:\/\/dl\.micup\.gg/);
	assert.doesNotMatch(workflow, /PUBLIC_DL_BASE: https:\/\/api\.fluxer\.app/);
	const build = job('build');
	const feedTools = step(build, 'Install AppImage feed tools');
	assert.match(feedTools, /if: matrix\.platform == 'linux'/);
	assert.match(feedTools, /sudo apt-get install -y --no-install-recommends zsync/);
	assert.ok(build.indexOf('Install AppImage feed tools') < build.indexOf('--step build_appimage_update_feed'));
	assert.ok(build.indexOf('--step build_appimage_update_feed') < build.indexOf('--step generate_checksums_unix'));
	assert.ok(build.indexOf('--step generate_checksums_unix') < build.indexOf('--step stage_handoff'));
	assert.match(job('upload'), /pattern: fluxer-desktop-\$\{\{ needs\.meta\.outputs\.build_channel \}\}-\*/);
});
