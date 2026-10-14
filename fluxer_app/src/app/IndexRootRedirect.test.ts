// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AuthSessionStorageKey} from '@app/features/platform/state/auth_session/AuthSessionStorage';
import {describe, expect, it} from 'vitest';

// Micup: index.html's inline boot scripts, read as shipped.
const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const INLINE_SCRIPTS = [
	...INDEX_HTML.matchAll(/<script nonce="\{\{CSP_NONCE_PLACEHOLDER\}\}">([\s\S]*?)<\/script>/g),
].map((match) => match[1]);
const ROOT_REDIRECT = INLINE_SCRIPTS.find((script) => script.includes("'/channels/@me'")) ?? '';

interface Visit {
	path?: string;
	search?: string;
	hash?: string;
	token?: string | null;
	desktop?: boolean;
	storageThrows?: boolean;
}

function open(visit: Visit): string | null {
	let target: string | null = null;
	const location = {
		pathname: visit.path ?? '/',
		search: visit.search ?? '',
		hash: visit.hash ?? '',
		replace: (next: string) => {
			target = next;
		},
	};
	const localStorage = {
		getItem: (key: string) => {
			if (visit.storageThrows) throw new Error('storage blocked');
			return key === AuthSessionStorageKey.Token ? (visit.token ?? null) : null;
		},
	};
	const window = visit.desktop ? {location, electron: {}} : {location};
	runInNewContext(ROOT_REDIRECT, {window, localStorage});
	return target;
}

describe('index.html root redirect', () => {
	it('sends a signed-out browser visitor on the bare root to the landing page', () => {
		expect(open({})).toBe('/marketing');
	});

	it.each(['', 'undefined', 'null'])('treats a stored token of %j as signed out', (token) => {
		expect(open({token})).toBe('/marketing');
	});

	it('treats unreadable storage as signed out', () => {
		expect(open({storageThrows: true})).toBe('/marketing');
	});

	it('keeps a signed-in visitor on the app', () => {
		expect(open({token: 'a-session-token'})).toBe('/channels/@me');
	});

	it('keeps the desktop app on the app even when signed out', () => {
		expect(open({desktop: true})).toBe('/channels/@me');
	});

	it('keeps a root address with a query on the app, query included', () => {
		expect(open({search: '?ref=mail'})).toBe('/channels/@me?ref=mail');
	});

	it('keeps a root address with a fragment on the app, fragment included', () => {
		expect(open({hash: '#top'})).toBe('/channels/@me#top');
	});

	it('leaves every other path alone', () => {
		expect(open({path: '/login'})).toBeNull();
	});

	it('uses the session storage key for routing without the removed fast-connect socket', () => {
		const read = `localStorage.getItem('${AuthSessionStorageKey.Token}')`;
		expect(ROOT_REDIRECT).toContain(read);
		expect(INDEX_HTML).not.toContain('__FLUXER_FAST_CONNECT__');
	});
});
