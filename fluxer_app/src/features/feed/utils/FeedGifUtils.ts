// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Gif} from '@app/features/expressions/commands/GifCommands';
import * as GifSlugUtils from '@app/features/expressions/utils/GifSlugUtils';

// A Klipy GIF behind our media proxy: /external/<HMAC signature>/https/static.klipy.com/<path>.webp|.gif, the exact
// shape the gifs service signs (fluxer_common external_media_path). Tested on the link as written, so no query or
// fragment (not even a bare ? or #), no percent-encoding, no backslash, no other host.
const KLIPY_PROXY_PATH = /^\/external\/[A-Za-z0-9_-]+\/https\/static\.klipy\.com\/[A-Za-z0-9_\-/.]+\.(?:webp|gif)$/;
// Image formats the picker hands out: the animated WebP (the smallest full-size file), then the GIF sizes.
const GIF_IMAGE_FORMATS = ['webp', 'gif', 'mediumgif', 'tinygif'] as const;
// As many as a post has images; a longer text keeps the rest as links.
const MAX_INLINE_GIFS = 4;

// TEMPORARY: a comment GIF is the signed media-proxy URL itself, stored in the comment text, so it depends on the proxy
// secret and the media domain. Move: an additive `gif_url` column on the comment rows with the raw Klipy URL, signed
// on read like a post's link preview (mapFeedLinkPreview). Trigger: before FLUXER_MEDIA_PROXY_SECRET_KEY is rotated
// or the media domain changes, since both turn every stored comment GIF into a dead link.

// The media endpoint parsed once (it changes only with the instance), as "<origin><path>" without a trailing slash.
let parsedEndpoint: {raw: string; root: string | null} = {raw: '', root: null};
function endpointRoot(mediaEndpoint: string): string | null {
	if (parsedEndpoint.raw !== mediaEndpoint) {
		let root: string | null = null;
		try {
			const base = new URL(mediaEndpoint);
			root = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
		} catch {}
		parsedEndpoint = {raw: mediaEndpoint, root};
	}
	return parsedEndpoint.root;
}

/**
 * True for a link a feed text may draw inline as a GIF: our own media proxy's signed copy of a Klipy image. The viewer
 * only ever asks our proxy, which fetches only what the server signed, so no other link becomes an image (tracking
 * pixel, IP leak) and nothing reaches the proxy unsigned. The link must be written exactly as the proxy builds it:
 * nothing the URL parser would rewrite (case, default port, dot segments, backslashes) and no query or fragment.
 */
export function isFeedGifUrl(raw: string, mediaEndpoint: string): boolean {
	const root = endpointRoot(mediaEndpoint);
	if (root === null || !raw.startsWith(`${root}/external/`)) return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	return url.href === raw && KLIPY_PROXY_PATH.test(raw.slice(root.length));
}

/** A feed text split into what the markdown renderer draws and the GIF links drawn under it (at most four). */
export function splitFeedGifs(content: string, mediaEndpoint: string): {text: string; gifs: Array<string>} {
	const gifs: Array<string> = [];
	const text = content
		.replace(/\S+/g, (token) => {
			if (gifs.length >= MAX_INLINE_GIFS || !isFeedGifUrl(token, mediaEndpoint)) return token;
			gifs.push(token);
			return '';
		})
		.trim();
	return {text, gifs};
}

/**
 * The link a GIF picked for a comment writes into the text: its proxied Klipy image, or the Klipy share link (a plain
 * link) when the picker gave none this client draws.
 */
export function feedGifUrl(gif: Gif, mediaEndpoint: string): string {
	for (const format of GIF_IMAGE_FORMATS) {
		const url = gif.media?.[format]?.proxy_src;
		if (url && isFeedGifUrl(url, mediaEndpoint)) return url;
	}
	return GifSlugUtils.resolveShareUrl(gif.provider, {url: gif.url, slug: gif.slug});
}
