// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';

export class MaxFeedCommentsError extends BadRequestError {
	constructor(limit: number) {
		super({
			code: APIErrorCodes.MAX_FEED_COMMENTS,
			messageVariables: {count: limit},
			data: {
				max_comments_per_post: limit,
			},
		});
	}
}
