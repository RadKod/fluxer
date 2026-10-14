// SPDX-License-Identifier: AGPL-3.0-or-later

// hls.js ships its light build (package export "./light") without types; its API is the full build's.
declare module 'hls.js/light' {
	export * from 'hls.js';
	export {default} from 'hls.js';
}
