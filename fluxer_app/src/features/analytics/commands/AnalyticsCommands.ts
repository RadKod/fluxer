// SPDX-License-Identifier: AGPL-3.0-or-later

import AnalyticsConsent from '@app/features/analytics/state/AnalyticsConsent';
import {type AnalyticsPage, analyticsPage, analyticsReferrer} from '@app/features/analytics/utils/AnalyticsPage';
import type {Router} from '@app/features/platform/components/router/RouterTypes';
import {reaction} from 'mobx';

// Content-free counts only: no ids, names or text ever go with an event.
export type AnalyticsEvent =
	| 'sign_up'
	| 'login'
	| 'email_verified'
	| 'guild_create'
	| 'guild_join'
	| 'message_send'
	| 'voice_join'
	| 'screen_share_start'
	| 'feed_post_create'
	| 'feed_like'
	| 'feed_comment_create'
	| 'follow'
	| 'desktop_download_click';

export interface AnalyticsStartOptions {
	measurementId: string | null | undefined;
	router: Pick<Router, 'getState' | 'subscribe'>;
	platform: 'web' | 'desktop';
	appVersion: string;
}

type Gtag = (...args: Array<unknown>) => void;
type GtagWindow = Window & Record<string, unknown> & {dataLayer?: Array<unknown>; gtag?: Gtag};

const GTAG_URL = 'https://www.googletagmanager.com/gtag/js';
// 13 months instead of GA's two-year default.
const COOKIE_MAX_AGE_SECONDS = 395 * 24 * 60 * 60;
// A tab can stay open for days; page views and the first use of each feature stay far below this.
const MAX_DATA_LAYER_PUSHES = 200;

let globals: Record<string, string> = {};
let referrer = '';
let page: AnalyticsPage | null = null;
let loaded = false;
let active = false;
let sentPath: string | null = null;
let pushes = 0;
const sentEvents = new Set<AnalyticsEvent>();

const gtagWindow = (): GtagWindow => window as unknown as GtagWindow;

// Analytics must never break the flow it observes: mobx runs with disableErrorBoundaries (index.tsx), so an
// exception here would surface in login, message send or voice join. Every entry point swallows its errors.
function quietly(run: () => void): void {
	try {
		run();
	} catch {}
}

function push(...args: Array<unknown>): void {
	if (pushes >= MAX_DATA_LAYER_PUSHES) return;
	pushes += 1;
	quietly(() => gtagWindow().gtag?.(...args));
}

function pageFields(current: AnalyticsPage): Record<string, string> {
	return {page_location: current.location, page_title: current.title, page_referrer: referrer};
}

function sendPageView(): void {
	if (!active || !page || page.path === sentPath) return;
	sentPath = page.path;
	const fields = pageFields(page);
	push('set', fields);
	push('event', 'page_view', fields);
}

function pageNonce(): string {
	const script = document.querySelector<HTMLScriptElement>('script[nonce]');
	return script?.nonce || script?.getAttribute('nonce') || '';
}

// Basic consent mode: gtag.js is added only after "Accept". Older shells provide a nonce; the shared shell's
// CSP permits the configured analytics script directly. A blocked script leaves only the bounded dataLayer.
function load(id: string): void {
	const w = gtagWindow();
	if (loaded) {
		w[`ga-disable-${id}`] = false;
		w.gtag?.('consent', 'update', {analytics_storage: 'granted'});
	} else {
		const nonce = pageNonce();
		w[`ga-disable-${id}`] = false;
		const dataLayer = w.dataLayer ?? [];
		w.dataLayer = dataLayer;
		w.gtag = function gtag() {
			// biome-ignore lint/complexity/noArguments: gtag.js reads only Arguments objects from dataLayer.
			dataLayer.push(arguments);
		};
		push('consent', 'default', {
			ad_storage: 'denied',
			ad_user_data: 'denied',
			ad_personalization: 'denied',
			analytics_storage: 'granted',
		});
		push('set', {...globals, ...(page ? pageFields(page) : {page_referrer: referrer})});
		push('js', new Date());
		push('config', id, {
			send_page_view: false,
			allow_google_signals: false,
			allow_ad_personalization_signals: false,
			cookie_domain: 'none',
			cookie_flags: 'SameSite=Lax;Secure',
			cookie_expires: COOKIE_MAX_AGE_SECONDS,
		});
		const script = document.createElement('script');
		script.async = true;
		if (nonce) script.nonce = nonce;
		script.src = `${GTAG_URL}?id=${encodeURIComponent(id)}`;
		document.head.appendChild(script);
		loaded = true;
	}
	active = true;
	sendPageView();
}

// gtag.js writes these through document.cookie; the Cookie Store API is missing in some browsers the app supports.
function clearCookies(id: string): void {
	for (const name of ['_ga', `_ga_${id.slice(2)}`]) {
		// biome-ignore lint/suspicious/noDocumentCookie: host-only cookies (cookie_domain 'none').
		document.cookie = `${name}=; Max-Age=0; path=/`;
		// biome-ignore lint/suspicious/noDocumentCookie: GA's default cookie_domain 'auto' used the parent domain.
		document.cookie = `${name}=; Max-Age=0; path=/; domain=.${window.location.hostname}`;
	}
}

// Stops a loaded gtag.js for good on this page (ga-disable-<id> is GA's own opt-out switch) and removes its cookies.
function stop(id: string): void {
	const w = gtagWindow();
	w[`ga-disable-${id}`] = true;
	if (active) w.gtag?.('consent', 'update', {analytics_storage: 'denied'});
	active = false;
	clearCookies(id);
}

export function start({measurementId, router, platform, appVersion}: AnalyticsStartOptions): () => void {
	const disposers: Array<() => void> = [];
	quietly(() => {
		const id = AnalyticsConsent.configure(measurementId);
		if (!id) return;
		globals = {client_platform: platform, app_version: appVersion};
		referrer = analyticsReferrer(document.referrer);
		const followRoute = (): void =>
			quietly(() => {
				const state = router.getState();
				// Mid-navigation the state still holds the current location with its matches; only later updates wait.
				if (state.navigating && page) return;
				page = analyticsPage(state);
				sendPageView();
			});
		followRoute();
		disposers.push(router.subscribe(followRoute));
		disposers.push(
			reaction(
				() => AnalyticsConsent.isGranted,
				(granted) => quietly(() => (granted ? load(id) : stop(id))),
				{fireImmediately: true},
			),
		);
	});
	return () => {
		for (const dispose of disposers) quietly(dispose);
	};
}

export function accept(): void {
	AnalyticsConsent.setChoice('granted');
}

export function reject(): void {
	AnalyticsConsent.setChoice('denied');
}

// "Cookie preferences" on the sign-in pages: forgetting the choice stops collection and shows the banner again.
export function resetChoice(): void {
	AnalyticsConsent.clearChoice();
}

export function track(event: AnalyticsEvent): void {
	if (!active || sentEvents.has(event)) return;
	sentEvents.add(event);
	push('event', event);
}
