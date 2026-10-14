// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import type {DiscoveryGuild} from '@app/features/discovery/commands/DiscoveryCommands';
import FeedSuggestionPicks from '@app/features/feed/state/FeedSuggestionPicks';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import Users from '@app/features/user/state/Users';
import type {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const logger = new Logger('FeedSuggestionCommands');

export interface SuggestionPicks {
	userIds: Array<string>;
	guilds: Array<DiscoveryGuild>;
}

// One request per feed page opening; the people go to the Users store so their profile opens with a name and avatar
// (a stranger's profile request is refused and the modal falls back, UserProfileModal.tsx:165-168). Only the people
// the store lacks: the snapshot can be minutes old and must not overwrite a user the store already holds. Null on any
// error: the section hides and the feed goes on.
export async function fetchSuggestions(): Promise<SuggestionPicks | null> {
	try {
		const {body} = await http.get<FeedSuggestionsResponse>(Endpoints.FEED_SUGGESTIONS);
		Users.cacheUsers(body.users.filter((user) => !Users.getUser(user.id)));
		return {
			userIds: body.users.map((user) => user.id),
			guilds: body.guilds.map((guild) => ({
				...guild,
				banner: guild.banner ?? null,
				icon: guild.icon ?? null,
				description: guild.description ?? null,
				primary_language: guild.primary_language ?? null,
			})),
		};
	} catch (error) {
		logger.warn('Failed to load feed suggestions:', error);
		return null;
	}
}

// Once per feed page opening: a second call, a remount of the section or a failed first request asks no more until
// FeedPage resets FeedSuggestionPicks.
export async function loadSuggestions(): Promise<void> {
	const opening = FeedSuggestionPicks.beginLoad();
	if (opening === null) return;
	FeedSuggestionPicks.handleLoaded(opening, await fetchSuggestions());
}
