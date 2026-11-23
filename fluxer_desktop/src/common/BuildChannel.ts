// SPDX-License-Identifier: AGPL-3.0-or-later

export type BuildChannel = 'stable' | 'canary' | 'development';

declare const __FLUXER_BUILD_CHANNEL__: BuildChannel;

// sanalyer: the node --test suites load this file unbuilt, without the build's define.
export const BUILD_CHANNEL: BuildChannel =
	typeof __FLUXER_BUILD_CHANNEL__ === 'undefined' ? 'stable' : __FLUXER_BUILD_CHANNEL__;
