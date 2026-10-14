// SPDX-License-Identifier: AGPL-3.0-or-later
const {createHash} = require('node:crypto');

module.exports = function voiceVadWorkletLoader(source) {
	const hash = createHash('sha256').update(source).digest('hex');
	if (hash !== '05a553f523d59502d133a6d05dbf1878137c9e7bcff06edf5561f7001b62f95f') {
		throw new Error('Unexpected @jitsi/rnnoise-wasm 0.2.1 sync artifact; review the model before updating its pin');
	}
	return source.replace(
		'export default createRNNWasmModuleSync;',
		'globalThis.fluxerCreateVoiceVad = createRNNWasmModuleSync;',
	);
};
