// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';

export function hostedImageUrl(name: string): string {
	return `${RuntimeConfig.staticCdnEndpoint}/web/images/${name}`;
}
