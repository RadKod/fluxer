// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {UserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import type {GuildBoostResponse, UserBoostSlotResponse} from '@fluxer/schema/src/domains/boost/BoostResponseSchemas';
import type {Guild} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';

export const GUILD_BOOSTS_PAGE_SIZE = 100;

export async function fetchGuildBoosts(guildId: string, before?: string): Promise<Array<GuildBoostResponse>> {
	const query = before ? {limit: GUILD_BOOSTS_PAGE_SIZE, before} : {limit: GUILD_BOOSTS_PAGE_SIZE};
	const response = await http.get<Array<GuildBoostResponse>>(Endpoints.GUILD_BOOSTS(guildId), {query});
	return response.body;
}

// GUILD_UPDATE only follows level changes, so the boost count is read fresh from the guild.
export async function fetchGuildBoostCount(
	guildId: string,
): Promise<{premiumTier: number | null; premiumSubscriptionCount: number | null}> {
	const response = await http.get<Guild>(Endpoints.GUILD(guildId));
	return {
		premiumTier: response.body.premium_tier ?? null,
		premiumSubscriptionCount: response.body.premium_subscription_count ?? null,
	};
}

export async function fetchBoostSlots(): Promise<Array<UserBoostSlotResponse>> {
	const response = await http.get<Array<UserBoostSlotResponse>>(Endpoints.USER_BOOST_SLOTS);
	return response.body;
}

// Slots come with premium; a member without a free one is sent to the premium tab (trial, key redemption), never to a payment.
function openPremiumSettings(): void {
	ModalCommands.pop();
	ModalCommands.push(
		modal(() => <UserSettingsModal initialTab="plutonium" data-flx="boost.guild-boost-commands.user-settings-modal" />),
	);
}

// Returns whether a boost was sent; the new level and count arrive with GUILD_UPDATE.
export async function boostGuild(guildId: string, slots: ReadonlyArray<UserBoostSlotResponse>): Promise<boolean> {
	const freeSlot = slots.find((slot) => slot.guild_id === null);
	if (!freeSlot) {
		openPremiumSettings();
		return false;
	}
	await http.put<GuildBoostResponse>(Endpoints.GUILD_BOOSTS(guildId), {body: {slot_id: freeSlot.id}});
	return true;
}

export async function removeGuildBoost(guildId: string, boostId: string): Promise<void> {
	await http.delete(Endpoints.GUILD_BOOST(guildId, boostId));
}
