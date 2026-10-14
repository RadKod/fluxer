// SPDX-License-Identifier: AGPL-3.0-or-later

export interface UsernameGateUser {
	id: string;
	usernameState?: 'legacy' | 'selected' | 'reselect_required';
	bot: boolean;
	system: boolean;
	suspended?: boolean;
	deleted?: boolean;
}

export interface UsernameGateMigration {
	state: 'legacy' | 'preparing' | 'selecting';
	epoch: number;
	started_at?: string | null;
	forced_at?: string | null;
}

export function usernameGateMode(
	user: UsernameGateUser | undefined,
	migration: UsernameGateMigration,
	now: number,
	requiredByError = false,
): 'none' | 'prompt' | 'required' {
	if (!user || user.bot || user.system || user.suspended || user.deleted) return 'none';
	if (requiredByError || user.usernameState === 'reselect_required') return 'required';
	if (user.usernameState === 'selected' || migration.state !== 'selecting') return 'none';
	return now >= Date.parse(migration.forced_at ?? '') ? 'required' : 'prompt';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

export function usernamePromptDay(now: number): string {
	return new Date(now + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextUsernamePromptDay(now: number): number {
	return (Math.floor((now + ISTANBUL_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - ISTANBUL_OFFSET_MS;
}

export function isUsernameGateEscapePath(pathname: string): boolean {
	return [
		'/login',
		'/verify',
		'/forgot',
		'/reset',
		'/recover',
		'/wasntme',
		'/authorize-ip',
		'/report',
		'/age-verification-callback',
	].some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function isUsernameSelectionRequired(payload: unknown): boolean {
	if (typeof payload !== 'object' || payload === null) return false;
	if ('body' in payload) return isUsernameSelectionRequired(payload.body);
	return 'code' in payload && payload.code === 'USERNAME_SELECTION_REQUIRED';
}
