// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {type OfficialBotComponentClick, routeOfficialBotComponent} from '@app/api/guild/OfficialBotComponentRouter';
import type {RosterFixture} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';

// Clicks a button of the announced roster card through the router, as the click route does after its access checks.
export async function clickRoster(
	f: RosterFixture,
	userId: UserID,
	customId: string,
	overrides: Partial<OfficialBotComponentClick> = {},
) {
	const state = (await f.roster.readState(f.ref))!;
	const message = (await f.deps.channelRepository.messages.getMessage(state.channelId, state.messageId))!;
	const user = await f.deps.userRepository.findUniqueAssert(userId);
	const viewer: ThreadViewer = {kind: 'user', userId, bot: user.isBot, capable: user.isBot};
	return routeOfficialBotComponent({
		user,
		viewer,
		guildId: f.ref.guildId,
		channelId: state.channelId,
		message,
		customId,
		member: {} as GuildMemberResponse,
		authChannel: await f.deps.channelService.interactions.authService.getChannelAuthenticated({
			viewer,
			userId,
			channelId: state.channelId,
		}),
		channelService: f.deps.channelService,
		requestCache: createRequestCache(),
		atMs: Date.now(),
		...overrides,
	});
}
