// SPDX-License-Identifier: AGPL-3.0-or-later

interface TaggedUserLike {
	username: string;
	discriminator: string;
	bot?: boolean | null;
	system?: boolean | null;
}

const ZERO_DISCRIMINATOR_RE = /^0+$/;

export function shouldShowDiscriminator(
	user: Pick<TaggedUserLike, 'discriminator' | 'bot' | 'system'>,
	_uniqueUsernames?: boolean,
): boolean {
	return Boolean(user.bot || user.system) || !ZERO_DISCRIMINATOR_RE.test(user.discriminator);
}

export function formatUserTag(user: TaggedUserLike, uniqueUsernames?: boolean): string {
	return shouldShowDiscriminator(user, uniqueUsernames)
		? `${user.username}#${user.discriminator}`
		: `@${user.username}`;
}

export function parseUserTagInput(input: string): [username: string, discriminator?: string] | null {
	const [username, discriminator, extra] = input.trim().replace(/^@/, '').split('#');
	if (!username || extra !== undefined) return null;
	if (discriminator === undefined) return [username];
	if (!/^\d{4}$/.test(discriminator) || ZERO_DISCRIMINATOR_RE.test(discriminator)) return null;
	return [username, discriminator];
}
