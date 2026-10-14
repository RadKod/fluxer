// SPDX-License-Identifier: AGPL-3.0-or-later

// Micup: TEMPORARY: without targeted member fan-out (T6) migration stays below 80% of the initial T6 triggers
// (50,000 guild members, 5,000 online, 100,000 accounts); replace these limits with T6 once one of them is reached.
export const USERNAME_CAPACITY_LIMITS = {members: 40_000, online: 4_000, accounts: 80_000} as const;

export function usernameStartCapacityReady(
	totalAccounts: number,
	guild: {max_guild_members: number; max_guild_online: number},
): boolean {
	return (
		totalAccounts < USERNAME_CAPACITY_LIMITS.accounts &&
		guild.max_guild_members < USERNAME_CAPACITY_LIMITS.members &&
		guild.max_guild_online < USERNAME_CAPACITY_LIMITS.online
	);
}
