// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: what the small card (UserProfilePopout.test.tsx) leaves out lives in the full profile.
// Rendering the modal needs most of the app, so this reads its JSX (as ProfileEffectSurfaces.test.ts does).
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const MODAL = source('./UserProfileModal.tsx');
const USER_INFO = source('./user_profile_modal/UserProfileModalUserInfo.tsx');
const CONTENT = source('./user_profile_modal/ProfileContent.tsx');
const MOBILE_SHEET = source('./UserProfileMobileSheet.tsx');

describe('the full profile keeps what the small card leaves out', () => {
	it('shows Follow in the header, and the #tag, badges, follow counts and Posts under the name', () => {
		expect(MODAL).toMatch(/<ProfileFollowButton\b/);
		expect(USER_INFO).toMatch(/formatTagForStreamerMode\(user\.tag\)/);
		expect(USER_INFO).toMatch(/<UserProfileBadges\b/);
		expect(USER_INFO).toMatch(/<ProfileFollowActions\b[^>]*\bhideFollowButton\b/);
		expect(USER_INFO).toMatch(/<ProfilePostsButton\b/);
	});

	it('shows the timezone, member since dates, roles, connections and the note', () => {
		for (const part of [
			'UserProfileTimezoneInfo',
			'UserProfileMembershipInfo',
			'UserProfileRoles',
			'UserProfileConnections',
			'UserNoteEditor',
		]) {
			expect(CONTENT, part).toMatch(new RegExp(`<${part}\\b`));
		}
	});

	it('keeps Follow and the counts on the mobile profile sheet', () => {
		expect(MOBILE_SHEET).toMatch(/<ProfileFollowActions\b(?![^>]*\bhideFollowButton\b)/);
	});
});
