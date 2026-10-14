// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const storage = vi.hoisted(() => ({
	values: new Map<string, string>(),
	external: null as null | (() => void),
}));

vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getJSON: (key: string) => (storage.values.has(key) ? JSON.parse(storage.values.get(key)!) : null),
		setJSON: (key: string, value: unknown) => storage.values.set(key, JSON.stringify(value)),
		removeItem: (key: string) => storage.values.delete(key),
		subscribe: (listener: () => void, options?: {key?: string; source?: string}) => {
			if (options?.key === 'analytics_consent' && options.source === 'external') storage.external = listener;
			return () => {};
		},
	},
}));

async function freshConsent() {
	vi.resetModules();
	return (await import('@app/features/analytics/state/AnalyticsConsent')).default;
}

describe('AnalyticsConsent', () => {
	beforeEach(() => {
		storage.values.clear();
		storage.external = null;
	});

	it('stays off and never asks without a measurement id', async () => {
		const consent = await freshConsent();
		for (const id of [null, undefined, '', 'UA-1234-1', 'G-abc12345', 'G-AB"C']) {
			expect(consent.configure(id)).toBeNull();
			expect(consent.isAvailable).toBe(false);
			expect(consent.shouldAsk).toBe(false);
			expect(consent.isGranted).toBe(false);
		}
		consent.setChoice('granted');
		expect(consent.isGranted).toBe(false);
		expect(storage.values.size).toBe(0);
	});

	it('asks until the person decides', async () => {
		const consent = await freshConsent();
		expect(consent.configure('G-TEST1234')).toBe('G-TEST1234');
		expect(consent.shouldAsk).toBe(true);
		expect(consent.isGranted).toBe(false);
		consent.setChoice('denied');
		expect(consent.shouldAsk).toBe(false);
		expect(consent.isGranted).toBe(false);
	});

	it('remembers the choice with the consent version it was given under', async () => {
		const consent = await freshConsent();
		consent.configure('G-TEST1234');
		consent.setChoice('granted');
		expect(JSON.parse(storage.values.get('analytics_consent')!)).toEqual({version: 1, choice: 'granted'});

		const reloaded = await freshConsent();
		reloaded.configure('G-TEST1234');
		expect(reloaded.isGranted).toBe(true);
		expect(reloaded.shouldAsk).toBe(false);
	});

	it('asks again when the consent text version changed', async () => {
		storage.values.set('analytics_consent', JSON.stringify({version: 0, choice: 'granted'}));
		const consent = await freshConsent();
		consent.configure('G-TEST1234');
		expect(consent.isGranted).toBe(false);
		expect(consent.shouldAsk).toBe(true);
	});

	it('ignores a stored value it does not recognise', async () => {
		storage.values.set('analytics_consent', JSON.stringify({version: 1, choice: 'yes'}));
		const consent = await freshConsent();
		consent.configure('G-TEST1234');
		expect(consent.shouldAsk).toBe(true);
	});

	it('forgets the choice when asked to, so the banner shows again', async () => {
		const consent = await freshConsent();
		consent.configure('G-TEST1234');
		consent.setChoice('denied');
		consent.clearChoice();
		expect(storage.values.has('analytics_consent')).toBe(false);
		expect(consent.shouldAsk).toBe(true);
	});

	it('follows a withdrawal made in another tab', async () => {
		const consent = await freshConsent();
		consent.configure('G-TEST1234');
		consent.setChoice('granted');
		storage.values.set('analytics_consent', JSON.stringify({version: 1, choice: 'denied'}));
		storage.external?.();
		expect(consent.isGranted).toBe(false);
		expect(consent.choice).toBe('denied');
	});
});
