// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {apiEndpoint: '/api', apiCodeVersion: 1}}));
vi.mock('@app/features/auth/state/Authentication', async () => {
	const {observable} = await import('mobx');
	return {default: observable({currentUserId: '1' as string | null, authToken: null as string | null})};
});

// The real REST client runs over a fake XMLHttpRequest, so what it sends by itself (the session token, a retry) shows.
const {runInAction} = await import('mobx');
const {http} = await import('@app/features/platform/transport/RestTransport');
const {default: RuntimeConfig} = await import('@app/features/app/state/RuntimeConfig');
const {default: Authentication} = await import('@app/features/auth/state/Authentication');
// The mock's fields are plain observables; the real store's are getters.
const auth = Authentication as unknown as {currentUserId: string | null; authToken: string | null};
const runtime = RuntimeConfig as unknown as {apiEndpoint: string; apiCodeVersion: number};
const {FEED_VIEW_SEND_MS, FEED_VIEW_THRESHOLDS, isHalfVisible, recordView, resetViews} = await import(
	'@app/features/feed/commands/FeedViewCommands'
);

const SESSION_TOKEN = 'micup-session-token';

interface SentRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string | null;
}

// 'drop': the request never reaches the server (a network error). 'hold': no answer ever comes (a half-open connection),
// only the request's own timeout ends it. `after`: the answer comes that many ms after the request.
type Reply = {status: number; body?: unknown; headers?: Record<string, string>; after?: number} | 'drop' | 'hold';

let requests: Array<SentRequest>;
// The server's answers in order; a request past them gets 204.
let replies: Array<Reply>;

class FakeXhr {
	status = 0;
	statusText = '';
	responseText = '';
	responseType = '';
	response: unknown = null;
	timeout = 0;
	readonly upload = new EventTarget();
	private readonly events = new EventTarget();
	private request: SentRequest = {method: '', url: '', headers: {}, body: null};
	private replyHeaders = '';

	open(method: string, url: string) {
		this.request = {method, url, headers: {}, body: null};
	}
	setRequestHeader(name: string, value: string) {
		this.request.headers[name] = value;
	}
	addEventListener(type: string, listener: EventListener) {
		this.events.addEventListener(type, listener);
	}
	getAllResponseHeaders() {
		return this.replyHeaders;
	}
	abort() {}
	send(body: string | null) {
		this.request.body = body;
		requests.push(this.request);
		const reply = replies.shift() ?? {status: 204};
		if (reply === 'hold') {
			// As a browser does at xhr.timeout (none when it is 0).
			if (this.timeout > 0) {
				setTimeout(() => {
					this.events.dispatchEvent(new Event('timeout'));
					this.events.dispatchEvent(new Event('loadend'));
				}, this.timeout);
			}
			return;
		}
		const answer = () => {
			if (reply === 'drop') {
				this.events.dispatchEvent(new Event('error'));
			} else {
				this.status = reply.status;
				const headers = {...reply.headers};
				if (reply.body !== undefined) {
					this.responseText = JSON.stringify(reply.body);
					headers['Content-Type'] = 'application/json';
				}
				this.replyHeaders = Object.entries(headers)
					.map(([name, value]) => `${name}: ${value}`)
					.join('\r\n');
				this.events.dispatchEvent(new Event('load'));
			}
			this.events.dispatchEvent(new Event('loadend'));
		};
		if (reply !== 'drop' && reply.after !== undefined) setTimeout(answer, reply.after);
		else queueMicrotask(answer);
	}
}

let fetchMock: ReturnType<typeof vi.fn>;
let sendBeacon: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState;

const seen = (...ids: Array<string>) => {
	for (const id of ids) recordView(id, `ticket-${id}`);
};
const sentViews = (index: number) =>
	(JSON.parse(requests[index]!.body!) as {views: Array<{id: string; token: string}>}).views;
const view = (id: string) => ({id, token: `ticket-${id}`});
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const hide = () => {
	visibility = 'hidden';
	document.dispatchEvent(new Event('visibilitychange'));
};
const show = () => {
	visibility = 'visible';
	document.dispatchEvent(new Event('visibilitychange'));
};
const viewsUrl = () => `${location.origin}/api/v1/feed/views`;

describe('FeedViewCommands', () => {
	beforeEach(() => {
		requests = [];
		replies = [];
		visibility = 'visible';
		vi.useFakeTimers();
		vi.stubGlobal('XMLHttpRequest', FakeXhr);
		fetchMock = vi.fn(async () => new Response(null, {status: 204}));
		vi.stubGlobal('fetch', fetchMock);
		sendBeacon = vi.fn(() => true);
		Object.defineProperty(navigator, 'sendBeacon', {configurable: true, value: sendBeacon});
		Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
		// The gap after an answer is 61 s + [0, 1) s; half of the jitter here.
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		http.installAuth(() => SESSION_TOKEN);
		http.configure({baseUrl: '/api', apiVersion: 1});
		runInAction(() => {
			auth.authToken = SESSION_TOKEN;
		});
		runtime.apiEndpoint = '/api';
		resetViews();
	});

	afterEach(() => {
		resetViews();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		http.installAuth(() => null);
		delete (navigator as {sendBeacon?: unknown}).sendBeacon;
		delete (document as {visibilityState?: unknown}).visibilityState;
		runInAction(() => {
			auth.currentUserId = '1';
		});
	});

	it('counts a card half on screen, and a card taller than twice the screen once it covers half of it', () => {
		// `visible` px of a `card` px tall card on an 800 px screen.
		const entry = (visible: number, card: number) =>
			({
				isIntersecting: visible > 0,
				intersectionRatio: visible / card,
				intersectionRect: {height: visible},
				rootBounds: {height: 800},
			}) as unknown as IntersectionObserverEntry;
		expect(isHalfVisible(entry(150, 300))).toBe(true);
		expect(isHalfVisible(entry(149, 300))).toBe(false);
		expect(isHalfVisible(entry(0, 300))).toBe(false);
		// 2 000 px on an 800 px screen: never half visible, counted once it covers 400 px.
		expect(isHalfVisible(entry(400, 2000))).toBe(true);
		expect(isHalfVisible(entry(399, 2000))).toBe(false);
		// Without the screen's bounds only the ratio counts.
		expect(isHalfVisible({...entry(400, 2000), rootBounds: null} as IntersectionObserverEntry)).toBe(false);
		// The observer calls back at each step, so the tall card is checked on the way to half of the screen.
		expect(FEED_VIEW_THRESHOLDS).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
	});

	it('sends the views of a minute in one batch of at most 100 with the Authorization header', async () => {
		for (let id = 1; id <= 101; id++) seen(String(id));
		await wait(59_999);
		expect(requests).toHaveLength(0);
		await wait(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({method: 'POST', url: viewsUrl()});
		expect(requests[0]!.headers).toMatchObject({Authorization: SESSION_TOKEN, 'Content-Type': 'application/json'});
		const views = sentViews(0);
		expect(views).toHaveLength(100);
		expect(views[0]).toEqual(view('1'));
		expect(views.map((entry) => entry.id)).not.toContain('101');
		await wait(10 * 60_000);
		expect(requests).toHaveLength(1);
	});

	it('does not count a post again within a minute (a card mounted again or in overscan)', async () => {
		seen('2');
		await wait(50_000);
		seen('1');
		await wait(5_000);
		seen('1');
		await wait(5_000);
		expect(requests).toHaveLength(1);
		expect(sentViews(0)).toEqual([view('2'), view('1')]);
		// 20 s after it counted, the card is on screen again.
		await wait(10_000);
		seen('1');
		await wait(10 * 60_000);
		expect(requests).toHaveLength(1);
		// A minute later it is a new view.
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('1')]);
	});

	it('sends the next batch no sooner than 61 to 62 s after the last answer', async () => {
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		// Seen right after the answer: its minute ends at 120 s, the server's gate opens at 121.5 s.
		seen('2');
		await wait(61_499);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('2')]);
	});

	it('keeps the batch on 429 and sends it again 1 s after retry_after', async () => {
		replies = [
			{
				status: 429,
				body: {code: 'RATE_LIMITED', message: 'You are being rate limited.', global: false, retry_after: 20},
				headers: {'Retry-After': '20', 'X-RateLimit-Reset-After': '20'},
			},
		];
		seen('1', '2');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		await wait(20_999);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('1'), view('2')]);
		await wait(10 * 60_000);
		expect(requests).toHaveLength(2);
	});

	it('a network error rejects http.post once without a retry, and the batch waits a minute', async () => {
		const post = vi.spyOn(http, 'post');
		replies = ['drop'];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		expect(post).toHaveBeenCalledTimes(1);
		expect(post.mock.calls[0]).toEqual([
			'/feed/views',
			{body: {views: [view('1')]}, timeoutMs: 30_000, retries: 0, mode: 'silent'},
		]);
		await expect(post.mock.results[0]!.value).rejects.toThrow();
		await wait(59_999);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('1')]);
	});

	it('keeps the batch after a 5xx for the next minute', async () => {
		// 502 is one the client itself would retry at once; with no retries it is one request.
		replies = [{status: 502}, {status: 500, body: {code: 'GENERAL_ERROR', message: 'Internal Server Error'}}];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		await wait(59_999);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		await wait(60_000);
		expect(requests).toHaveLength(3);
		expect([sentViews(1), sentViews(2)]).toEqual([[view('1')], [view('1')]]);
	});

	it('gives up on a send with no answer after 30 s, and sends the batch again a minute later', async () => {
		replies = ['hold'];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		// 90 s: the send times out, a network error; the batch waits a minute.
		await wait(30_000);
		await wait(59_999);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('1')]);
	});

	it('waits 61 s after a 429 without retry_after', async () => {
		replies = [{status: 429, body: {code: 'RATE_LIMITED', message: 'You are being rate limited.', global: false}}];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		await wait(60_999);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('1')]);
	});

	it('puts a refused batch back within 100, keeping a newer token recorded meanwhile', async () => {
		replies = [{status: 500, after: 5_000}];
		for (let id = 1; id <= 100; id++) seen(String(id));
		await wait(60_000);
		expect(requests).toHaveLength(1);
		// While the batch is on its way (the minute of its posts is over): post 1 with a new token, and a new post.
		recordView('1', 'ticket-1-new');
		seen('101');
		// 65 s: the 5xx; 2–99 go back behind them, 100 no longer fits.
		await wait(5_000);
		await wait(60_000);
		expect(requests).toHaveLength(2);
		const views = sentViews(1);
		expect(views).toHaveLength(100);
		expect(views.slice(0, 3)).toEqual([{id: '1', token: 'ticket-1-new'}, view('101'), view('2')]);
		expect(views.map((entry) => entry.id)).not.toContain('100');
	});

	it('stops sending for a while after a 403, and drops the views waiting for it', async () => {
		// View counts are off; the answer comes 5 s after the batch.
		replies = [
			{status: 403, body: {code: 'FEATURE_TEMPORARILY_DISABLED', message: 'Temporarily disabled.'}, after: 5_000},
		];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		// Seen while the batch is on its way: dropped with it.
		seen('2');
		await wait(5_000);
		// 65 s: the 403. A view after it waits 30 minutes, and leaving the page sends nothing before then.
		seen('3');
		hide();
		expect(fetchMock).not.toHaveBeenCalled();
		show();
		await wait(30 * 60_000 - 1);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('3')]);
	});

	it('drops a batch on 400, 401 or 404 and never retries it', async () => {
		const statuses = [400, 401, 404];
		replies = statuses.map((status) => ({status, body: {code: 'REFUSED', message: 'Refused'}}));
		for (const [index, status] of statuses.entries()) {
			seen(String(status));
			await wait(60_000);
			expect(requests).toHaveLength(index + 1);
			expect(sentViews(index)).toEqual([view(String(status))]);
		}
		await wait(10 * 60_000);
		expect(requests).toHaveLength(statuses.length);
	});

	it('sends on exit with fetch keepalive, a JSON body and the Authorization header, never sendBeacon', async () => {
		seen('1', '2');
		hide();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toBe(viewsUrl());
		expect(init).toEqual({
			method: 'POST',
			keepalive: true,
			headers: {'Content-Type': 'application/json', Authorization: SESSION_TOKEN},
			body: JSON.stringify({views: [view('1'), view('2')]}),
		});
		expect(sendBeacon).not.toHaveBeenCalled();
		// Nothing left for the page hide that follows, nor for the minute.
		window.dispatchEvent(new Event('pagehide'));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await wait(10 * 60_000);
		expect(requests).toHaveLength(0);
	});

	it('puts the session token only in the Authorization header', async () => {
		seen('1');
		window.dispatchEvent(new Event('pagehide'));
		const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
		expect(String(url)).not.toContain(SESSION_TOKEN);
		expect(init.body).not.toContain(SESSION_TOKEN);
		expect(init.headers).toEqual({'Content-Type': 'application/json', Authorization: SESSION_TOKEN});
		// The minute batch too.
		seen('2');
		await wait(62_000);
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).not.toContain(SESSION_TOKEN);
		expect(requests[0]!.body).not.toContain(SESSION_TOKEN);
		expect(requests[0]!.headers.Authorization).toBe(SESSION_TOKEN);
	});

	it('views sent on exit are not sent again when the page comes back', async () => {
		seen('1');
		await wait(5_000);
		hide();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		show();
		// The card is on screen again when the page comes back, with a new one; the minute timer set before the exit (60 s)
		// is gone, so the new view waits for the server's gate after the exit batch (5 s + 61.5 s).
		seen('1', '2');
		await wait(61_499);
		expect(requests).toHaveLength(0);
		await wait(1);
		expect(requests).toHaveLength(1);
		expect(sentViews(0)).toEqual([view('2')]);
		await wait(10 * 60_000);
		expect(requests).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends nothing on exit before the server's minute is over, or when the API is on another origin", async () => {
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		seen('2');
		await wait(30_000);
		// 90 s: the server took a batch at 60 s and would refuse this one.
		hide();
		expect(fetchMock).not.toHaveBeenCalled();
		show();
		await wait(31_500);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('2')]);

		resetViews();
		runtime.apiEndpoint = 'https://api.elsewhere.test';
		seen('3');
		hide();
		expect(fetchMock).not.toHaveBeenCalled();
		show();
		// Same origin but signed out: no token to send.
		runtime.apiEndpoint = '/api';
		runInAction(() => {
			auth.authToken = null;
		});
		hide();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sendBeacon).not.toHaveBeenCalled();
	});

	it('sends nothing on exit while a batch is on its way, and keeps the views for the next one', async () => {
		replies = [{status: 204, after: 5_000}];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		seen('2');
		hide();
		expect(fetchMock).not.toHaveBeenCalled();
		show();
		// The answer at 65 s opens the next minute at 126.5 s.
		await wait(66_499);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('2')]);
	});

	it("carries nothing of the previous account's answer when the account changes before it", async () => {
		// The first account's batch is refused with 5 minutes to wait; the answer comes after the switch.
		replies = [
			{
				status: 429,
				body: {code: 'RATE_LIMITED', message: 'You are being rate limited.', global: false, retry_after: 300},
				after: 5_000,
			},
		];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		await wait(2_000);
		runInAction(() => {
			auth.currentUserId = '2';
		});
		seen('2');
		// The old answer at 65 s cannot delay the new account's timer, set at 62 s.
		await wait(3_000);
		await wait(56_999);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('2')]);
	});

	it('forgets pending views when the account changes', async () => {
		// The first account is told to wait 5 minutes; the next one is not.
		replies = [
			{
				status: 429,
				body: {code: 'RATE_LIMITED', message: 'You are being rate limited.', global: false, retry_after: 300},
			},
		];
		seen('1');
		await wait(60_000);
		expect(requests).toHaveLength(1);
		seen('2');
		await wait(2_000);
		runInAction(() => {
			auth.currentUserId = '2';
		});
		// The new account's own view of the same post counts, in its own minute.
		seen('2');
		await wait(59_999);
		expect(requests).toHaveLength(1);
		await wait(1);
		expect(requests).toHaveLength(2);
		expect(sentViews(1)).toEqual([view('2')]);
	});

	it('clears queued views and rejects new views throughout a same-ID instance switch', async () => {
		seen('old');
		await AccountScopedWork.runSuspended('account-switch', async () => {
			seen('during-switch');
			hide();
			expect(fetchMock).not.toHaveBeenCalled();
			show();
		});
		expect(auth.currentUserId).toBe('1');
		seen('new');
		hide();
		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0]! as [URL, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({views: [view('new')]});
	});

	it('drops an old response and its backoff after a same-ID instance switch', async () => {
		let answer!: (response: RestResponse<unknown>) => void;
		const post = vi.spyOn(http, 'post').mockReturnValueOnce(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		seen('old');
		await wait(FEED_VIEW_SEND_MS);
		await AccountScopedWork.runSuspended('account-switch', async () => {});
		seen('new');
		answer({ok: false, status: 429, statusText: '', headers: {}, body: {retry_after: 300}});
		await wait(FEED_VIEW_SEND_MS);
		expect(post).toHaveBeenCalledTimes(2);
		expect(post.mock.calls[1]?.[1]?.body).toEqual({views: [view('new')]});
	});
});
