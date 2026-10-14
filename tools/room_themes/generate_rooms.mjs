#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

// Builds the 3D voice room GLB files procedurally (no Blender): three rooms and the shared table parts.
//   node tools/room_themes/generate_rooms.mjs [--out <dir>] [--only gece-lounge,kahvehane,oyun-odasi,masa-parcalari]
// Writes <out>/<id>/<id>.glb per room and <out>/masa-parcalari.glb (default out: tools/room_themes/build, git-ignored),
// the layout tools/room_themes/build_manifest.mjs reads:
//   node tools/room_themes/build_manifest.mjs --rooms tools/room_themes/build --out fluxer_static/rooms \
//     --manifest packages/constants/src/VoiceRoomThemeManifest.ts \
//     --parts-manifest packages/constants/src/VoiceRoomPartsManifest.ts --parts tools/room_themes/build/masa-parcalari.glb

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {writeGlb} from './lib/glb.mjs';
import {buildParts} from './parts.mjs';
import {buildGeceLounge} from './rooms/gece_lounge.mjs';
import {buildKahvehane} from './rooms/kahvehane.mjs';
import {buildOyunOdasi} from './rooms/oyun_odasi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOMS = {
	'gece-lounge': buildGeceLounge,
	kahvehane: buildKahvehane,
	'oyun-odasi': buildOyunOdasi,
};

function main() {
	const {values} = parseArgs({options: {out: {type: 'string'}, only: {type: 'string'}}});
	const out = values.out ?? join(here, 'build');
	const only = values.only ? new Set(values.only.split(',')) : null;
	for (const [id, build] of Object.entries(ROOMS)) {
		if (only && !only.has(id)) continue;
		const started = performance.now();
		const room = build();
		const triangles = room.triangleCount();
		room.bake();
		const glb = writeGlb(room.toGltf());
		mkdirSync(join(out, id), {recursive: true});
		writeFileSync(join(out, id, `${id}.glb`), glb);
		const seconds = ((performance.now() - started) / 1000).toFixed(1);
		console.log(
			`${id}: ${glb.length} bytes, ${Math.round(triangles)} triangles, ${room.empties.length} empties, ${seconds}s`,
		);
	}
	if (!only || only.has('masa-parcalari')) {
		const glb = writeGlb(buildParts());
		mkdirSync(out, {recursive: true});
		writeFileSync(join(out, 'masa-parcalari.glb'), glb);
		console.log(`masa-parcalari: ${glb.length} bytes`);
	}
}

main();
