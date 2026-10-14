// SPDX-License-Identifier: AGPL-3.0-or-later

import {analyticsPage, analyticsReferrer} from '@app/features/analytics/utils/AnalyticsPage';
import {describe, expect, it} from 'vitest';

function stateAt(href: string, route?: {id: string; path?: string}) {
	return {location: new URL(href), matches: route ? [{route: {id: 'root'}}, {route}] : []};
}

describe('analyticsPage', () => {
	it.each([
		['https://micup.gg/reset#token=abc', {id: 'resetPassword', path: '/reset'}, '/reset'],
		['https://micup.gg/gift/ABC123', {id: 'giftRegister', path: '/gift/:code'}, '/gift/:code'],
		['https://micup.gg/invite/xyz', {id: 'inviteRegister', path: '/invite/:code'}, '/invite/:code'],
		[
			'https://micup.gg/channels/111/222/333',
			{id: 'channelMessage', path: '/channels/:guildId/:channelId/:messageId'},
			'/channels/:guildId/:channelId/:messageId',
		],
		[
			'https://micup.gg/channels/@me/444',
			{id: 'channel', path: '/channels/:guildId/:channelId'},
			'/channels/:guildId/:channelId',
		],
		[
			'https://micup.gg/auth/sso/callback?code=c0de&state=s7',
			{id: 'ssoCallback', path: '/auth/sso/callback'},
			'/auth/sso/callback',
		],
		['https://micup.gg/login?redirect_to=/channels/1/2', {id: 'login', path: '/login'}, '/login'],
	])('sends only the route template for %s', (href, route, path) => {
		const page = analyticsPage(stateAt(href, route));
		expect(page.path).toBe(path);
		expect(page.location).toBe(`https://micup.gg${path}`);
		expect(page.title).toBe(route.id);
		for (const secret of ['abc', 'ABC123', 'xyz', '111', '222', '333', '444', 'c0de', 's7', 'redirect_to', '#']) {
			expect(page.location).not.toContain(secret);
		}
	});

	it('keeps campaign parameters and drops every other query parameter', () => {
		const page = analyticsPage(
			stateAt('https://micup.gg/register?utm_source=x&utm_campaign=launch&ref=y', {id: 'register', path: '/register'}),
		);
		expect(page.location).toBe('https://micup.gg/register?utm_source=x&utm_campaign=launch');
	});

	it('trims an oversized campaign value', () => {
		const page = analyticsPage(
			stateAt(`https://micup.gg/register?utm_source=${'a'.repeat(500)}`, {id: 'register', path: '/register'}),
		);
		expect(new URL(page.location).searchParams.get('utm_source')).toHaveLength(100);
	});

	it('reports an unmatched location as unknown instead of its path', () => {
		const page = analyticsPage(stateAt('https://micup.gg/some/private/thing'));
		expect(page).toEqual({path: '/__unknown', location: 'https://micup.gg/__unknown', title: 'unknown'});
	});
});

describe('analyticsReferrer', () => {
	it.each([
		['https://www.google.com/search?q=micup', 'https://www.google.com'],
		['https://micup.gg/invite/secret', 'https://micup.gg'],
		['', ''],
		['not a url', ''],
		['android-app://com.example/', ''],
	])('reduces %s to its origin', (referrer, expected) => {
		expect(analyticsReferrer(referrer)).toBe(expected);
	});
});
