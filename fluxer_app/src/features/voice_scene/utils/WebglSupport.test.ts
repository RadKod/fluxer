// SPDX-License-Identifier: AGPL-3.0-or-later

import {probeWebglSupport} from '@app/features/voice_scene/utils/WebglSupport';
import {describe, expect, it, vi} from 'vitest';

const UNMASKED_RENDERER_WEBGL = 0x9246;
const RENDERER = 0x1f01;

function fakeDocument(context: object | null) {
	const getContext = vi.fn(() => context);
	return {doc: {createElement: () => ({getContext})} as unknown as Document, getContext};
}

describe('probeWebglSupport', () => {
	it('reads the unmasked renderer and frees the probe context', () => {
		const loseContext = vi.fn();
		const gl = {
			RENDERER,
			getExtension: (name: string) =>
				name === 'WEBGL_debug_renderer_info'
					? {UNMASKED_RENDERER_WEBGL}
					: name === 'WEBGL_lose_context'
						? {loseContext}
						: null,
			getParameter: (parameter: number) =>
				parameter === UNMASKED_RENDERER_WEBGL ? 'Google SwiftShader' : parameter === RENDERER ? 'WebKit WebGL' : null,
		};
		const {doc, getContext} = fakeDocument(gl);
		const support = probeWebglSupport(doc, {hardwareConcurrency: 8, deviceMemory: 4} as unknown as Navigator);
		expect(getContext).toHaveBeenCalledWith('webgl2');
		expect(support).toEqual({webgl2: true, renderer: 'Google SwiftShader', hardwareConcurrency: 8, deviceMemory: 4});
		expect(loseContext).toHaveBeenCalledTimes(1);
	});

	it('falls back to RENDERER when the debug extension is hidden', () => {
		const gl = {RENDERER, getExtension: () => null, getParameter: () => 'Mozilla'};
		const {doc} = fakeDocument(gl);
		expect(probeWebglSupport(doc, {hardwareConcurrency: 4} as Navigator)).toEqual({
			webgl2: true,
			renderer: 'Mozilla',
			hardwareConcurrency: 4,
			deviceMemory: null,
		});
	});

	it('no webgl2 context → webgl2 false', () => {
		const {doc} = fakeDocument(null);
		expect(probeWebglSupport(doc, {} as Navigator)).toEqual({
			webgl2: false,
			renderer: null,
			hardwareConcurrency: null,
			deviceMemory: null,
		});
	});
});
