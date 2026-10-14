// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import crownUrl from '@app/media/images/micup-premium-badge.png';
import {describe, expect, it} from 'vitest';

const {premiumBadgeUrl} = await import('@app/features/premium/utils/PremiumBadgeAsset');

describe('premiumBadgeUrl', () => {
	// the premium and shop pages show the purple crown that sits next to the name.
	it('is the bundled crown of PremiumUserBadge, not a CDN badge', () => {
		const badge = readFileSync(
			fileURLToPath(new URL('../../user/components/PremiumUserBadge.tsx', import.meta.url)),
			'utf8',
		);
		expect(badge).toContain("from '@app/media/images/micup-premium-badge.png'");
		expect(premiumBadgeUrl()).toBe(crownUrl);
		expect(premiumBadgeUrl()).not.toContain('/badges/');
	});
});
