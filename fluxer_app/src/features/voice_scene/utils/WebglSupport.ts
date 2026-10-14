// SPDX-License-Identifier: AGPL-3.0-or-later

export interface WebglSupport {
	webgl2: boolean;
	// Unmasked GPU name when the browser exposes it; software rasterisers are recognised from it.
	renderer: string | null;
	hardwareConcurrency: number | null;
	deviceMemory: number | null;
}

type ProbeContext = Pick<WebGL2RenderingContext, 'RENDERER' | 'getExtension' | 'getParameter'>;

export function probeWebglSupport(doc: Document = document, nav: Navigator = navigator): WebglSupport {
	const device = {
		hardwareConcurrency: nav.hardwareConcurrency || null,
		deviceMemory: (nav as Navigator & {deviceMemory?: number}).deviceMemory || null,
	};
	let gl: ProbeContext | null = null;
	try {
		gl = doc.createElement('canvas').getContext('webgl2') as ProbeContext | null;
	} catch {
		gl = null;
	}
	if (!gl) return {webgl2: false, renderer: null, ...device};
	const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
	const renderer = gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
	// Browsers cap live contexts; the probe must not hold one the room renderer will need.
	gl.getExtension('WEBGL_lose_context')?.loseContext();
	return {webgl2: true, renderer: typeof renderer === 'string' ? renderer : null, ...device};
}

let cached: WebglSupport | null = null;

export function getWebglSupport(): WebglSupport {
	cached ??= probeWebglSupport();
	return cached;
}
