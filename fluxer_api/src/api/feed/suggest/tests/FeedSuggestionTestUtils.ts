// SPDX-License-Identifier: AGPL-3.0-or-later

import {feedSuggestionCache} from '@app/api/feed/suggest/FeedSuggestionCache';
import {FeedSuggestionRepository} from '@app/api/feed/suggest/FeedSuggestionRepository';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import type {User} from '@app/api/models/User';
import {mapUserToPartialResponse} from '@app/api/user/UserMappers';
import type {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

// Stores a suggestion snapshot the way the build does and has this process read it. The cache is pointed at the test
// KV first: after a test reset it has no repository, and a refresh would read nothing.
export async function seedSuggestionPool({
	users = [],
	guilds = [],
	version = Date.now(),
}: {
	users?: Array<User>;
	guilds?: FeedSuggestionsResponse['guilds'];
	version?: number;
}): Promise<void> {
	feedSuggestionCache.setRefreshSubscriber(getKVClient());
	await new FeedSuggestionRepository(getKVClient()).putSnapshot({
		version,
		users: users.map(mapUserToPartialResponse),
		guilds,
	});
	await feedSuggestionCache.refresh();
}
