// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: outside profiles, the premium crown stays right after the verified tick. Mounting all
// of these surfaces needs most of the app, so the sources are read: each tick is followed by the crown for the same
// user, at the same size and with the same class.
const PLACEMENTS = [
	'../../channel/components/MessageAuthorInfo.tsx',
	'../../channel/components/UserMessage.tsx',
	'../../channel/components/CompactMessageLayout.tsx',
	'../../channel/components/MemberListItem.tsx',
	'../../feed/components/FeedPostCard.tsx',
];

// Micup: big names without a verified tick, the mobile "You" page and the top of a DM. The badge
// row carried premium there, so the crown alone follows the name, at the 20 px of the other big names.
const NAME_ONLY_PLACEMENTS = [
	{file: '../../app/components/pages/YouPage.tsx', name: 'data-flx="app.you-page.username"'},
	{
		file: '../../channel/components/direct_message/DMWelcomeSection.tsx',
		name: 'data-flx="channel.direct-message.dm-welcome-section.username"',
	},
];

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const prop = (element: string, name: string) => element.match(new RegExp(`\\b${name}=\\{([^}]*)\\}`))?.[1];

describe('PremiumUserBadge placement', () => {
	it.each(PLACEMENTS)('%s imports the crown and draws it right after every verified tick', (file) => {
		const source = read(file);
		expect(source).toContain("import {PremiumUserBadge} from '@app/features/user/components/PremiumUserBadge';");

		const pairs = [...source.matchAll(/<VerifiedUserBadge\b[\s\S]*?\/>\s*(<PremiumUserBadge\b[\s\S]*?\/>)?/g)];
		expect(pairs.length).toBeGreaterThan(0);
		for (const [pair, crown] of pairs) {
			expect(crown, pair).toBeDefined();
			const tick = pair.slice(0, pair.length - crown.length);
			for (const name of ['user', 'size', 'className']) {
				expect(prop(crown, name), `${name} in ${pair}`).toBe(prop(tick, name));
			}
			expect(prop(crown, 'user')).toBeDefined();
			expect(crown).toMatch(/data-flx="[^"]*premium-user-badge[^"]*"/);
		}
	});

	it.each(NAME_ONLY_PLACEMENTS)('$file draws the crown once, right after the name, at 20 px', ({file, name}) => {
		const source = read(file);
		expect(source).toContain("import {PremiumUserBadge} from '@app/features/user/components/PremiumUserBadge';");

		const crowns = [...source.matchAll(/<PremiumUserBadge\b[\s\S]*?\/>/g)];
		expect(crowns).toHaveLength(1);
		const [crown] = crowns[0];
		expect(prop(crown, 'user')).toBe('user');
		expect(prop(crown, 'size')).toBe('20');
		expect(crown).toMatch(/data-flx="[^"]*premium-user-badge[^"]*"/);
		// Only the name and closing tags between the name element and the crown.
		const afterName = source.slice(source.indexOf(name), crowns[0].index);
		expect(afterName.slice(afterName.indexOf('>') + 1)).toMatch(/^[^<]*(<\/[A-Za-z]+>\s*)+$/);
	});

	// the member row is already a button and the message header row is aria-hidden (the name takes
	// focus only in keyboard mode), so there the crown is mouse-only. Everywhere else it stays a focusable button.
	it.each([...PLACEMENTS, ...NAME_ONLY_PLACEMENTS.map(({file}) => file)])(
		'%s makes the crown unfocusable only inside the member row and the message headers',
		(file) => {
			const mouseOnly = /\/(MemberListItem|MessageAuthorInfo|UserMessage|CompactMessageLayout)\.tsx$/.test(file);
			for (const [crown] of read(file).matchAll(/<PremiumUserBadge\b[\s\S]*?\/>/g)) {
				expect(prop(crown, 'focusable'), crown).toBe(mouseOnly ? 'false' : undefined);
			}
		},
	);

	it.each([...PLACEMENTS, ...NAME_ONLY_PLACEMENTS.map(({file}) => file)])(
		'%s keeps the nonprofile crown interactive',
		(file) => {
			for (const [crown] of read(file).matchAll(/<PremiumUserBadge\b[\s\S]*?\/>/g)) {
				expect(prop(crown, 'interactive'), crown).toBeUndefined();
			}
		},
	);

	it.each([
		'./modals/UserProfileModal.tsx',
		'./modals/user_profile_modal/ProfileModalContent.tsx',
		'./modals/user_profile_modal/ProfileBody.tsx',
	])('%s preserves the full profile preview state', (file) => {
		expect(read(file)).toContain('isPreview={isPreview}');
	});

	it.each(['../../app/components/floating/UserAreaPopout.tsx', './profile/ProfilePreview.tsx'])(
		'%s passes its badge row directly below the measured card name',
		(file) => {
			expect(read(file)).toMatch(/belowName=\{[\s\S]*?<UserProfileBadges[\s\S]*?isModal=\{true\}/);
		},
	);

	it.each([
		'./profile/profile_card/ProfileCardUserInfo.tsx',
		'./modals/user_profile_modal/UserProfileModalUserInfo.tsx',
		'./modals/UserProfileMobileSheet.tsx',
	])('%s sizes the profile row from the name instead of drawing a name crown', (file) => {
		const source = read(file);
		expect(source).not.toContain('PremiumUserBadge');
		expect(source).toContain('useProfileBadgeMetrics');
	});

	it.each(NAME_ONLY_PLACEMENTS)('$file excludes premium from its badge row', ({file}) => {
		expect(read(file)).toContain('showPremium={false}');
	});

	it('draws the crown in exactly eight nonprofile places', () => {
		const files = [...PLACEMENTS, ...NAME_ONLY_PLACEMENTS.map(({file}) => file)];
		const crowns = files.map((file) => read(file).match(/<PremiumUserBadge\b/g)?.length ?? 0);
		expect(crowns.reduce((sum, count) => sum + count, 0)).toBe(8);
	});
});
