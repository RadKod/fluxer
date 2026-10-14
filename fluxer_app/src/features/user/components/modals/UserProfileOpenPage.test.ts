// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: the profile modal and the mobile profile sheet lead to the full profile page.
// Rendering them needs most of the app, so this reads their JSX (as UserProfileModalFollow.test.ts does).
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const MODAL = source('./UserProfileModal.tsx');
const MOBILE_SHEET = source('./UserProfileMobileSheet.tsx');

const OPEN_PROFILE = /message: 'Open profile',/;
// The source between two markers: one branch of the action row.
const branch = (code: string, from: string, to: string) => code.slice(code.indexOf(from), code.indexOf(to));

describe('Open profile', () => {
	it('sits in the modal action row, on your own profile and on others, never in the settings preview', () => {
		expect(MODAL).toMatch(OPEN_PROFILE);
		expect(MODAL).toMatch(/const handleOpenProfilePage = \(\) => \{\s*UserProfileCommands\.openProfilePage\(userId\);/);
		const preview = branch(
			MODAL,
			'if (isCurrentUser && disableEditProfile) {',
			'if (isCurrentUser && !disableEditProfile) {',
		);
		const own = branch(MODAL, 'if (isCurrentUser && !disableEditProfile) {', 'const renderPrimaryActionButton');
		const others = branch(MODAL, 'renderPrimaryActionButton()}', 'const borderProfile');
		expect(MODAL).toMatch(/onClick=\{handleOpenProfilePage\}/);
		expect(preview).not.toMatch(/\{renderOpenProfilePageButton\(\)\}/);
		expect(own).toMatch(/\{renderOpenProfilePageButton\(\)\}/);
		expect(others).toMatch(/\{renderOpenProfilePageButton\(\)\}/);
	});

	it('is an action of the mobile profile sheet, on your own profile and on others', () => {
		expect(MOBILE_SHEET).toMatch(OPEN_PROFILE);
		expect(MOBILE_SHEET).toMatch(/UserProfileCommands\.openProfilePage\(user\.id\)/);
		expect(MOBILE_SHEET).toMatch(/onClick=\{handleOpenProfilePage\}/);
		expect(MOBILE_SHEET.match(/\{renderOpenProfilePageCard\(\)\}/g)).toHaveLength(2);
	});

	// A profile the page cached without the mutual lists does not stand in for the sheet's, which shows them.
	it('the mobile sheet does not take a profile cached without the mutual lists', () => {
		expect(MOBILE_SHEET).toMatch(/return cached\?\.mutualsLoaded \? cached : null;/);
	});
});
