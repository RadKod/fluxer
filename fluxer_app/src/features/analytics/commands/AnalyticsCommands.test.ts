// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// biome-ignore-all lint/suspicious/noDocumentCookie: the tests plant and read the cookies gtag.js would write.

import {configure} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// As in index.tsx: an exception inside a reaction reaches whoever changed the observable.
configure({disableErrorBoundaries: true});

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getJSON: (key: string) => (storage.has(key) ? JSON.parse(storage.get(key)!) : null),
		setJSON: (key: string, value: unknown) => storage.set(key, JSON.stringify(value)),
		removeItem: (key: string) => storage.delete(key),
		subscribe: () => () => {},
	},
}));

type AnalyticsCommandsModule = typeof import('@app/features/analytics/commands/AnalyticsCommands');
type TestWindow = Window & {dataLayer?: Array<ArrayLike<unknown>>; gtag?: unknown} & Record<string, unknown>;
interface TestRoute {
	id: string;
	path: string;
}

const ID = 'G-TEST1234';
const GUILD_ID = '987654321012345678';
const CHANNEL_ID = '876543210123456789';
const CHANNEL_ROUTE: TestRoute = {id: 'channel', path: '/channels/:guildId/:channelId'};
const FEED_ROUTE: TestRoute = {id: 'feed', path: '/feed'};

function fakeRouter(href: string, route: TestRoute, navigating = false) {
	let state = {navigating, location: new URL(href), matches: [{route}]};
	const listeners = new Set<() => void>();
	return {
		getState: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		go(nextHref: string, nextRoute: TestRoute, navigating = false) {
			state = {navigating, location: new URL(nextHref), matches: [{route: nextRoute}]};
			for (const listener of listeners) listener();
		},
	};
}

const testWindow = () => window as unknown as TestWindow;
const calls = () => (testWindow().dataLayer ?? []).map((entry) => Array.from(entry));
const eventNames = () =>
	calls()
		.filter((call) => call[0] === 'event')
		.map((call) => call[1]);
const cookieNames = () =>
	document.cookie
		.split(';')
		.map((cookie) => cookie.split('=')[0].trim())
		.filter(Boolean);

let appended: Array<HTMLScriptElement>;
let stopAnalytics: (() => void) | null;

async function setup(measurementId: string | null, choice?: 'granted' | 'denied', navigating = false) {
	if (choice) storage.set('analytics_consent', JSON.stringify({version: 1, choice}));
	vi.resetModules();
	const commands: AnalyticsCommandsModule = await import('@app/features/analytics/commands/AnalyticsCommands');
	const router = fakeRouter(`https://micup.gg/channels/${GUILD_ID}/${CHANNEL_ID}`, CHANNEL_ROUTE, navigating);
	stopAnalytics = commands.start({
		measurementId,
		router: router as unknown as Parameters<AnalyticsCommandsModule['start']>[0]['router'],
		platform: 'web',
		appVersion: '1.2.3',
	});
	return {commands, router};
}

beforeEach(() => {
	storage.clear();
	const w = testWindow();
	delete w.dataLayer;
	delete w.gtag;
	delete w[`ga-disable-${ID}`];
	for (const name of cookieNames()) document.cookie = `${name}=; Max-Age=0; path=/`;
	document.head.replaceChildren();
	const shellScript = document.createElement('script');
	shellScript.setAttribute('nonce', 'pagenonce');
	document.head.appendChild(shellScript);
	appended = [];
	vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
		appended.push(node as unknown as HTMLScriptElement);
		return node;
	});
	stopAnalytics = null;
});

afterEach(() => {
	stopAnalytics?.();
	vi.restoreAllMocks();
});

describe('AnalyticsCommands', () => {
	it('stays dark without a measurement id: no script, no dataLayer, nothing tracked', async () => {
		const {commands} = await setup(null);
		commands.accept();
		commands.track('login');
		expect(appended).toEqual([]);
		expect(testWindow().dataLayer).toBeUndefined();
	});

	it('loads nothing while the person has not decided', async () => {
		const {commands, router} = await setup(ID);
		commands.track('message_send');
		router.go('https://micup.gg/feed', FEED_ROUTE);
		expect(appended).toEqual([]);
		expect(testWindow().dataLayer).toBeUndefined();
	});

	it('loads nothing after Reject and removes Google Analytics cookies', async () => {
		document.cookie = '_ga=GA1.1.1.1; path=/';
		document.cookie = '_ga_TEST1234=GS1.1.1; path=/';
		document.cookie = 'theme=dark; path=/';
		const {commands} = await setup(ID);
		commands.reject();
		commands.track('login');
		expect(appended).toEqual([]);
		expect(testWindow().dataLayer).toBeUndefined();
		expect(cookieNames()).toEqual(['theme']);
	});

	it('after Accept loads gtag once with the page nonce, ads denied and only the route template', async () => {
		const {commands} = await setup(ID);
		commands.accept();

		expect(appended).toHaveLength(1);
		const [script] = appended;
		expect(script.src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
		expect(script.nonce || script.getAttribute('nonce')).toBe('pagenonce');
		expect(script.async).toBe(true);

		expect(calls()).toContainEqual([
			'consent',
			'default',
			{ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted'},
		]);
		expect(calls()).toContainEqual([
			'config',
			ID,
			{
				send_page_view: false,
				allow_google_signals: false,
				allow_ad_personalization_signals: false,
				cookie_domain: 'none',
				cookie_flags: 'SameSite=Lax;Secure',
				cookie_expires: 34_128_000,
			},
		]);
		expect(calls()).toContainEqual([
			'set',
			expect.objectContaining({
				client_platform: 'web',
				app_version: '1.2.3',
				page_location: 'https://micup.gg/channels/:guildId/:channelId',
				page_title: 'channel',
				page_referrer: '',
			}),
		]);
		expect(eventNames()).toEqual(['page_view']);
		const sent = JSON.stringify(calls().filter((call) => call[0] !== 'js'));
		expect(sent).not.toContain(GUILD_ID);
		expect(sent).not.toContain(CHANNEL_ID);
	});

	it('starts measuring at once when the person accepted earlier', async () => {
		await setup(ID, 'granted');
		expect(appended).toHaveLength(1);
		expect(eventNames()).toEqual(['page_view']);
	});

	it('sends a page view only when the route template changes', async () => {
		const {commands, router} = await setup(ID);
		commands.accept();
		router.go(`https://micup.gg/channels/${GUILD_ID}/123123123123123123`, CHANNEL_ROUTE);
		router.go('https://micup.gg/feed', FEED_ROUTE, true);
		expect(eventNames()).toEqual(['page_view']);
		router.go('https://micup.gg/feed', FEED_ROUTE);
		expect(eventNames()).toEqual(['page_view', 'page_view']);
		expect(calls().at(-1)).toEqual([
			'event',
			'page_view',
			{page_location: 'https://micup.gg/feed', page_title: 'feed', page_referrer: ''},
		]);
	});

	it('sends each feature event at most once per page load', async () => {
		const {commands} = await setup(ID, 'granted');
		commands.track('message_send');
		commands.track('message_send');
		commands.track('voice_join');
		commands.track('message_send');
		expect(eventNames()).toEqual(['page_view', 'message_send', 'voice_join']);
		expect(calls().at(-1)).toEqual(['event', 'voice_join']);
	});

	it('keeps dataLayer bounded however long the tab stays open', async () => {
		const {router} = await setup(ID, 'granted');
		for (let i = 0; i < 500; i++) {
			router.go('https://micup.gg/feed', FEED_ROUTE);
			router.go(`https://micup.gg/channels/${GUILD_ID}/${CHANNEL_ID}`, CHANNEL_ROUTE);
		}
		expect(testWindow().dataLayer).toHaveLength(200);
	});

	it('on withdrawal stops sending, tells gtag, and removes the cookies', async () => {
		const {commands, router} = await setup(ID, 'granted');
		document.cookie = '_ga=GA1.1.1.1; path=/';
		document.cookie = '_ga_TEST1234=GS1.1.1; path=/';
		commands.reject();

		expect(testWindow()[`ga-disable-${ID}`]).toBe(true);
		expect(calls().at(-1)).toEqual(['consent', 'update', {analytics_storage: 'denied'}]);
		expect(cookieNames()).toEqual([]);
		const before = calls().length;
		commands.track('follow');
		router.go('https://micup.gg/feed', FEED_ROUTE);
		expect(calls()).toHaveLength(before);
	});

	it('resumes on the same page after a new Accept without loading gtag twice', async () => {
		const {commands} = await setup(ID, 'granted');
		commands.reject();
		commands.accept();
		expect(appended).toHaveLength(1);
		expect(testWindow()[`ga-disable-${ID}`]).toBe(false);
		expect(calls().at(-1)).toEqual(['consent', 'update', {analytics_storage: 'granted'}]);
		commands.track('follow');
		expect(eventNames()).toContain('follow');
	});

	it('loads only after consent in a shared shell without a CSP nonce', async () => {
		document.head.querySelector('script')?.remove();
		const {commands} = await setup(ID);
		expect(appended).toEqual([]);
		commands.accept();
		expect(appended).toHaveLength(1);
		expect(appended[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
		expect(appended[0].getAttribute('nonce')).toBeNull();
	});

	it('never lets a throwing gtag reach login, message send or voice join', async () => {
		const {commands, router} = await setup(ID, 'granted');
		testWindow().gtag = () => {
			throw new Error('blocked');
		};
		expect(() => commands.track('login')).not.toThrow();
		expect(() => router.go('https://micup.gg/feed', FEED_ROUTE)).not.toThrow();
		expect(() => commands.reject()).not.toThrow();
		expect(() => commands.accept()).not.toThrow();
	});

	it('keeps going when dataLayer.push throws', async () => {
		const {commands} = await setup(ID, 'granted');
		testWindow().dataLayer!.push = () => {
			throw new Error('frozen');
		};
		expect(() => commands.track('message_send')).not.toThrow();
	});

	it('starts without throwing when the script cannot be added', async () => {
		vi.mocked(document.head.appendChild).mockImplementation(() => {
			throw new Error('denied');
		});
		const {commands} = await setup(ID, 'granted');
		expect(() => commands.track('voice_join')).not.toThrow();
		expect(() => commands.reject()).not.toThrow();
	});

	it('measures the first page even when it starts in the middle of a navigation', async () => {
		await setup(ID, 'granted', true);
		expect(calls()).toContainEqual([
			'event',
			'page_view',
			expect.objectContaining({page_location: 'https://micup.gg/channels/:guildId/:channelId'}),
		]);
	});

	it('Cookie preferences resets the choice: collection stops, cookies go, the banner asks again', async () => {
		const {commands} = await setup(ID, 'granted');
		document.cookie = '_ga=GA1.1.1.1; path=/';
		commands.resetChoice();
		expect(testWindow()[`ga-disable-${ID}`]).toBe(true);
		expect(cookieNames()).toEqual([]);
		expect(storage.has('analytics_consent')).toBe(false);
		const {default: consent} = await import('@app/features/analytics/state/AnalyticsConsent');
		expect(consent.shouldAsk).toBe(true);
		const before = calls().length;
		commands.track('follow');
		expect(calls()).toHaveLength(before);
	});

	it('stops following the router once disposed', async () => {
		const {router} = await setup(ID, 'granted');
		stopAnalytics?.();
		stopAnalytics = null;
		router.go('https://micup.gg/feed', FEED_ROUTE);
		expect(eventNames()).toEqual(['page_view']);
	});
});
