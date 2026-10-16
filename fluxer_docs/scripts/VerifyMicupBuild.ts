// SPDX-License-Identifier: AGPL-3.0-or-later

export {};

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:4321/docs/');
if (
	base.protocol !== 'http:' ||
	!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
	base.pathname !== '/docs/' ||
	base.search ||
	base.hash ||
	base.username ||
	base.password
)
	throw new Error('Use a local loopback URL: http://127.0.0.1:PORT/docs/');

const pages = new Map<string, string>();
const queued = new Set([base.href]);
const assets = new Set<string>();
const links = new Set<string>();
const skipped = new Set<string>();
const errors: Array<string> = [];
let danglingHashes = 0;
const decode = (value: string): string =>
	value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const attributes = (html: string, name: string): Array<string> =>
	[...html.matchAll(new RegExp(`\\s${name}=["']([^"']*)["']`, 'gi'))].map((match) => decode(match[1]));
function localUrl(value: string, parent: string): URL | null {
	const url = new URL(value, parent);
	if (url.origin === 'https://sanalyer.com' && url.pathname.startsWith('/docs/')) {
		url.protocol = base.protocol;
		url.host = base.host;
	}
	if (url.origin !== base.origin || url.username || url.password) {
		skipped.add(url.href);
		return null;
	}
	return url;
}
async function request(url: string): Promise<Response> {
	for (let hop = 0; hop < 5; hop++) {
		const response = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(15000)});
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get('location');
		const next = location && localUrl(location, url);
		if (!next) throw new Error(`Redirect leaves local origin: ${url}`);
		url = next.href;
	}
	throw new Error(`Too many redirects: ${url}`);
}

while ([...queued].some((url) => !pages.has(url))) {
	const batch = [...queued].filter((url) => !pages.has(url)).slice(0, 8);
	await Promise.all(
		batch.map(async (url) => {
			pages.set(url, '');
			try {
				const response = await request(url);
				if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
					throw new Error(`Expected 200 HTML, got ${response.status}: ${url}`);
				}
				const html = await response.text();
				pages.set(url, html);
				for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
					for (const href of attributes(tag, 'href')) {
						const target = localUrl(href, url);
						if (!target) continue;
						if (!target.pathname.startsWith('/docs/')) {
							skipped.add(target.href);
							continue;
						}
						links.add(target.href);
						target.hash = '';
						queued.add(target.href);
					}
				}
				for (const tag of html.match(/<(?:img|script|link|source|video)\b[^>]*>/gi) ?? []) {
					for (const value of [...attributes(tag, 'src'), ...attributes(tag, 'href')]) {
						const target = localUrl(value, url);
						if (target) {
							target.hash = '';
							assets.add(target.href);
						}
					}
				}
				const navigation = html.match(/<(header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi)?.join('') ?? '';
				if (/<a\b[^>]*href=["']https:\/\/(?:fluxer\.app|fluxer\.dev|discord\.gg)(?:[/"'])/i.test(navigation)) {
					errors.push(`Fluxer hosted promotion in navigation: ${url}`);
				}
			} catch (error) {
				errors.push(String(error));
			}
		}),
	);
}
for (const href of links) {
	const url = new URL(href);
	if (!url.hash) continue;
	const hash = decodeURIComponent(url.hash.slice(1));
	url.hash = '';
	if (!attributes(pages.get(url.href) ?? '', 'id').includes(hash)) {
		danglingHashes++;
		errors.push(`Missing anchor: ${href}`);
	}
}
const assetList = [...assets];
for (let start = 0; start < assetList.length; start += 8) {
	await Promise.all(
		assetList.slice(start, start + 8).map(async (url) => {
			try {
				const response = await request(url);
				await response.body?.cancel();
				if (response.status !== 200) errors.push(`Asset HTTP ${response.status}: ${url}`);
			} catch (error) {
				errors.push(String(error));
			}
		}),
	);
}
for (const path of ['', 'bots/hizli-baslangic/']) {
	const html = pages.get(new URL(path, base).href) ?? '';
	if (!/<title>[^<]*sanalyer[^<]*<\/title>/i.test(html)) errors.push(`Missing sanalyer title: ${path || 'homepage'}`);
	if (!html.includes('https://sanalyer.com/.well-known/fluxer'))
		errors.push(`Missing sanalyer discovery: ${path || 'homepage'}`);
}
const example = pages.get(new URL('bots/hizli-baslangic/', base).href) ?? '';
for (const expected of ['api_public', '/v1/channels/', 'Authorization', 'Bot']) {
	if (!example.includes(expected)) errors.push(`Missing bot example detail: ${expected}`);
}
const discovery = pages.get(new URL('http-api/instance/', base).href) ?? '';
for (const endpoint of ['https://sanalyer.com/api', 'wss://sanalyer.com/gateway', 'https://sanalyer.com/media']) {
	if (!discovery.includes(endpoint)) errors.push(`Missing sanalyer endpoint mapping: ${endpoint}`);
}
console.log(
	JSON.stringify(
		{pages: pages.size, internalLinks: links.size, assets: assets.size, skipped: skipped.size, danglingHashes, errors},
		null,
		2,
	),
);
if (errors.length > 0) process.exitCode = 1;
