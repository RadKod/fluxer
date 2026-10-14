// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import * as CodeLinkUtils from '@app/features/messaging/utils/CodeLinkUtils';

// Micup: Fluxer's gift hosts are another service's.
const OFFICIAL_GIFT_URL_BASES = Object.freeze(['https://sanalyer.com/gift']);
const GIFT_CONFIG: CodeLinkUtils.CodeLinkConfig = {
	path: 'gift',
	get urlBases() {
		if (RuntimeConfig.isSelfHosted()) {
			return [RuntimeConfig.giftUrlBase];
		}
		return [RuntimeConfig.giftUrlBase, ...OFFICIAL_GIFT_URL_BASES];
	},
};

export function findGifts(content: string | null): Array<string> {
	return CodeLinkUtils.findCodes(content, GIFT_CONFIG);
}

export function findSpoileredGifts(content: string | null): Array<CodeLinkUtils.CodeLinkMatch> {
	return CodeLinkUtils.findSpoileredCodeMatches(content, GIFT_CONFIG);
}

// Micup: the code part of a gift link (CodeLinkUtils); anything else is refused before it reaches the API.
const BARE_KEY_PATTERN = /^[a-zA-Z0-9-]{2,32}$/;

// Micup: a pasted key or a gift link of this instance, for the redeem key dialog and the shop's code field.
export function findKey(text: string): string | null {
	const trimmed = text.trim();
	return BARE_KEY_PATTERN.test(trimmed) ? trimmed : (findGifts(trimmed)[0] ?? null);
}
