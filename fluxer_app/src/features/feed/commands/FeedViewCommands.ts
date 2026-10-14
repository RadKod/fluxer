// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import Authentication from '@app/features/auth/state/Authentication';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import SessionManager from '@app/features/platform/state/AuthSession';
import {http} from '@app/features/platform/transport/RestTransport';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {reaction} from 'mobx';

// Micup akis-izlenme. A card at least half on screen (or covering half the screen) is a view; views go to the server in
// one batch a minute, the most it takes from an account. The server trusts only the post's view_token.
export const FEED_VIEW_SEND_MS = 60_000;
const FEED_VIEW_REPEAT_MS = 60_000;
// The server's gate is 60 s from the batch's arrival; waiting 61–62 s from its answer never meets a closed gate.
const FEED_VIEW_GAP_MS = 61_000;
const FEED_VIEW_GAP_JITTER_MS = 1000;
const FEED_VIEWS_PER_REQUEST = 100; // FeedViewsRequest on the server
// A send with no answer by then (a half-open connection) fails like a network error instead of holding back the rest.
const FEED_VIEW_TIMEOUT_MS = 30_000;
// A 403 is view counts off (the emergency brake): no send, not even on exit, for this long; a new account asks at once.
// TEMPORARY: while they are off an open tab still asks once in 30 min (10 M tabs ≈ 5.6 K 403/s through the rate
// limiter); stop until the page reloads if that load matters.
const FEED_VIEW_OFF_MS = 30 * 60_000;
// 0.5 for an ordinary card; the lower steps let a card taller than twice the screen count once it covers half of it.
// TEMPORARY: a card over ten screens tall never counts.
export const FEED_VIEW_THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5];

export function isHalfVisible(entry: IntersectionObserverEntry): boolean {
	if (!entry.isIntersecting) return false;
	if (entry.intersectionRatio >= 0.5) return true;
	return entry.rootBounds !== null && entry.intersectionRect.height >= entry.rootBounds.height / 2;
}

type ViewBatch = Array<{id: string; token: string}>;
// A 429's body (RateLimitError); other answers carry nothing read here.
type RateLimitBody = {retry_after?: number} | undefined;

const pending = new Map<string, string>(); // post id → view_token
const lastCounted = new Map<string, number>(); // post id → when it last counted here (pruned at each send)
let nextSendAt = 0; // the earliest time the server's minute gate is open again, as far as this tab knows
let sending = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

const gap = () => FEED_VIEW_GAP_MS + Math.random() * FEED_VIEW_GAP_JITTER_MS;

// Keeps a timer already set: after a 429 or a failure it is the one that counts.
function scheduleAt(at: number): void {
	if (timer !== null) return;
	timer = setTimeout(
		() => {
			timer = null;
			void sendViews();
		},
		Math.max(0, at - Date.now()),
	);
}

function cancelTimer(): void {
	if (timer !== null) clearTimeout(timer);
	timer = null;
}

function takeBatch(): ViewBatch {
	const batch = Array.from(pending, ([id, token]) => ({id, token}));
	pending.clear();
	return batch;
}

// A batch the server did not take goes back, within the 100 a request holds; a view recorded since keeps its newer token.
function putBack(batch: ViewBatch): void {
	for (const {id, token} of batch) {
		if (!pending.has(id) && pending.size < FEED_VIEWS_PER_REQUEST) pending.set(id, token);
	}
}

export function recordView(postId: string, token: string, now = Date.now()): void {
	if (AccountScopedWork.isSuspended) return;
	const last = lastCounted.get(postId);
	if (last !== undefined && now - last < FEED_VIEW_REPEAT_MS) return;
	if (!pending.has(postId) && pending.size >= FEED_VIEWS_PER_REQUEST) return;
	lastCounted.set(postId, now);
	pending.set(postId, token);
	if (!sending) scheduleAt(Math.max(now + FEED_VIEW_SEND_MS, nextSendAt));
}

export async function sendViews(): Promise<void> {
	if (AccountScopedWork.isSuspended || sending || pending.size === 0) return;
	const requestGeneration = generation;
	sending = true;
	const userId = Authentication.currentUserId;
	const batch = takeBatch();
	const now = Date.now();
	for (const [postId, countedAt] of lastCounted) {
		if (now - countedAt >= FEED_VIEW_REPEAT_MS) lastCounted.delete(postId);
	}
	let response: RestResponse<RateLimitBody> | null = null;
	try {
		response = await http.post<RateLimitBody>(Endpoints.FEED_VIEWS, {
			body: {views: batch},
			timeoutMs: FEED_VIEW_TIMEOUT_MS,
			retries: 0,
			mode: 'silent',
		});
	} catch {
		// A network error or a timeout: with no retries http.post rejects once, and the batch waits a minute like after a 5xx.
	}
	if (requestGeneration !== generation) return;
	sending = false;
	if (Authentication.currentUserId !== userId) {
		// The previous account's answer: nothing of it carries over.
	} else if (response === null || response.status >= 500) {
		putBack(batch);
		scheduleAt(Date.now() + FEED_VIEW_SEND_MS);
	} else if (response.status === 429) {
		putBack(batch);
		nextSendAt = Date.now() + (response.body?.retry_after ?? FEED_VIEW_SEND_MS / 1000) * 1000 + 1000;
		scheduleAt(nextSendAt);
	} else if (response.status === 403) {
		pending.clear();
		nextSendAt = Date.now() + FEED_VIEW_OFF_MS;
	} else if (response.ok) {
		nextSendAt = Date.now() + gap();
	}
	// Any other answer (400, 401, 404: a bad batch, signed out, a server before view counts) drops it.
	if (pending.size > 0) scheduleAt(Math.max(Date.now() + FEED_VIEW_SEND_MS, nextSendAt));
}

// On leaving the page. sendBeacon cannot carry the Authorization header; a keepalive fetch outlives the page like it.
export function sendViewsOnExit(now = Date.now()): void {
	// The server would refuse it: a batch is on its way, or its minute gate is still closed.
	if (AccountScopedWork.isSuspended || sending || pending.size === 0 || now < nextSendAt) return;
	const token = SessionManager.token;
	const url = new URL(
		`${RuntimeConfig.apiEndpoint}/v${RuntimeConfig.apiCodeVersion}${Endpoints.FEED_VIEWS}`,
		location.origin,
	);
	// As in RestTransport: the session token goes to the page's own origin only.
	if (!token || url.origin !== location.origin) return;
	const batch = takeBatch();
	cancelTimer();
	nextSendAt = now + gap();
	void fetch(url, {
		method: 'POST',
		keepalive: true,
		headers: {'Content-Type': 'application/json', Authorization: token},
		body: JSON.stringify({views: batch}),
	}).catch(() => {});
}

export function resetViews(): void {
	generation += 1;
	sending = false;
	pending.clear();
	lastCounted.clear();
	nextSendAt = 0;
	cancelTimer();
}

// Another account on this device starts with nothing of the previous one's views.
reaction(() => Authentication.currentUserId, resetViews);
AccountScopedWork.registerCancellation(resetViews);

if (typeof window !== 'undefined') {
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') sendViewsOnExit();
	});
	window.addEventListener('pagehide', () => sendViewsOnExit());
}
