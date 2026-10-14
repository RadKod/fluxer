// SPDX-License-Identifier: AGPL-3.0-or-later

import type {MessageEmbed, MessageEmbedMedia} from '@app/api/database/types/MessageTypes';
import {classifyFeedLinkPreviewUrl, findFeedLinkPreviewTarget, mapFeedLinkPreview} from '@app/api/feed/FeedLinkPreview';
import {describe, expect, it} from 'vitest';

const INVITES = [
	{origin: 'https://micup.gg', pathPrefix: '/invite/'},
	{origin: 'https://app.micup.test', pathPrefix: '/invite/'},
];
const cases: Array<[string, string | null, string | null]> = [
	// [input, expected kind, expected url or invite code]
	['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
	['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'https://youtu.be/dQw4w9WgXcQ'],
	['https://youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'https://youtube.com/shorts/dQw4w9WgXcQ'],
	['https://M.YouTube.com/live/dQw4w9WgXcQ', 'youtube', 'https://m.youtube.com/live/dQw4w9WgXcQ'],
	['https://www.youtube.com/embed/dQw4w9WgXcQ?start=5', 'youtube', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=5'],
	['http://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'http://music.youtube.com/watch?v=dQw4w9WgXcQ'],
	['https://www.twitch.tv/somechannel', 'twitch', 'https://www.twitch.tv/somechannel'],
	['https://www.twitch.tv/videos/123456', 'twitch', 'https://www.twitch.tv/videos/123456'],
	['https://m.twitch.tv/somechannel/clip/Funny-Slug_1', 'twitch', 'https://m.twitch.tv/somechannel/clip/Funny-Slug_1'],
	['https://clips.twitch.tv/FunnyClipSlug-abc', 'twitch', 'https://clips.twitch.tv/FunnyClipSlug-abc'],
	['https://kick.com/somechannel', 'kick', 'https://kick.com/somechannel'],
	[
		'https://www.kick.com/some-channel/videos/0f8e5a3c-1b2d-4e6f-8a9b-0c1d2e3f4a5b',
		'kick',
		'https://www.kick.com/some-channel/videos/0f8e5a3c-1b2d-4e6f-8a9b-0c1d2e3f4a5b',
	],
	['https://kick.com/somechannel/clips/clip_01ABC', 'kick', 'https://kick.com/somechannel/clips/clip_01ABC'],
	['https://micup.gg/invite/abc123', 'invite', 'abc123'],
	['https://MICUP.GG/invite/abc123/', 'invite', 'abc123'],
	['https://app.micup.test/invite/Weda-2026', 'invite', 'Weda-2026'],
	['https://micup.gg:443/invite/abc123', 'invite', 'abc123'],
	// An invite link keeps the scheme and port of the configured endpoint.
	['http://micup.gg/invite/abc123', null, null],
	['https://micup.gg:8443/invite/abc123', null, null],
	// Look-alike hosts, smuggled URLs, credentials, other schemes and shapes the unfurler does not know.
	['https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', null, null],
	['https://evil.com/?u=https://youtu.be/dQw4w9WgXcQ', null, null],
	['https://xmicup.gg/invite/abc123', null, null],
	['https://micup.gg.evil.com/invite/abc123', null, null],
	['https://youtube.com@evil.com/watch?v=dQw4w9WgXcQ', null, null],
	['https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ', null, null],
	['https://www.youtube.com\\@evil.com/watch?v=dQw4w9WgXcQ', null, null],
	['javascript:alert(1)//youtu.be/dQw4w9WgXcQ', null, null],
	['ftp://youtu.be/dQw4w9WgXcQ', null, null],
	['https://youtube.com./watch?v=dQw4w9WgXcQ', null, null],
	['https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ', null, null],
	['https://yоutube.com/watch?v=dQw4w9WgXcQ', null, null],
	['https://www.youtube.com/redirect?q=https://evil.com', null, null],
	['https://www.youtube.com/watch?v=short', null, null],
	['https://www.youtube.com/channel/UC1234567890', null, null],
	['https://www.twitch.tv/directory', null, null],
	['https://www.twitch.tv/some/other/path', null, null],
	['https://kick.com/somechannel/videos/not-a-uuid', null, null],
	['https://micup.gg/invite/a', null, null],
	['https://micup.gg/invite/abc123/../../../admin', null, null],
	['https://micup.gg/invites/abc123', null, null],
	['not a url', null, null],
];

describe('classifyFeedLinkPreviewUrl', () => {
	for (const [input, kind, value] of cases) {
		it(`${input} -> ${kind ?? 'no preview'}`, () => {
			const target = classifyFeedLinkPreviewUrl(input, INVITES);
			expect(target?.kind ?? null).toBe(kind);
			if (target) expect(target.kind === 'invite' ? target.inviteCode : target.url).toBe(value);
		});
	}
});

describe('findFeedLinkPreviewTarget', () => {
	it('takes the first allowed link in the text and ignores trailing punctuation', () => {
		expect(findFeedLinkPreviewTarget('bak (https://example.com) ve https://youtu.be/dQw4w9WgXcQ).', INVITES)?.url).toBe(
			'https://youtu.be/dQw4w9WgXcQ',
		);
		expect(findFeedLinkPreviewTarget('link yok', INVITES)).toBeNull();
		expect(findFeedLinkPreviewTarget(null, INVITES)).toBeNull();
	});
});

describe('mapFeedLinkPreview', () => {
	const proxy = {getExternalMediaProxyURL: (url: string) => `https://media.test/external/${encodeURIComponent(url)}`};
	const media = (url: string): MessageEmbedMedia => ({
		url,
		width: 1280,
		height: 720,
		description: null,
		content_type: 'image/jpeg',
		content_hash: null,
		placeholder: 'ph',
		flags: 0,
		duration: null,
	});
	const card = (patch: Partial<MessageEmbed>): MessageEmbed => ({
		type: 'video',
		title: 'Title',
		description: 'About',
		url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		timestamp: null,
		color: 0xff0000,
		author: {name: 'Channel', url: 'https://www.youtube.com/channel/x', icon_url: 'https://evil.test/icon.png'},
		provider: {name: 'YouTube', url: 'https://www.youtube.com'},
		thumbnail: media('https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg'),
		image: null,
		video: media('https://www.youtube.com/embed/dQw4w9WgXcQ'),
		footer: {text: 'footer', icon_url: 'https://evil.test/f.png'},
		fields: [{name: 'a', value: 'b', inline: false}],
		html: '<iframe src="https://evil.test"></iframe>',
		nsfw: null,
		...patch,
	});

	it('serves proxied media and leaves out html, fields, footer and icon URLs', () => {
		const preview = mapFeedLinkPreview({embeds: [card({})]}, proxy, INVITES)!;
		expect(preview.kind).toBe('youtube');
		expect(preview.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
		expect(preview.embed?.thumbnail?.proxy_url).toBe(
			`https://media.test/external/${encodeURIComponent('https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg')}`,
		);
		expect(preview.embed?.video?.url).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
		expect(preview.embed).not.toHaveProperty('html');
		expect(preview.embed).not.toHaveProperty('fields');
		expect(preview.embed).not.toHaveProperty('footer');
		expect(preview.embed?.author).toEqual({name: 'Channel', url: 'https://www.youtube.com/channel/x'});
	});

	it('drops a YouTube player that is not a YouTube embed URL and media that is not http(s)', () => {
		const preview = mapFeedLinkPreview(
			{embeds: [card({video: media('https://evil.test/player'), image: media('javascript:alert(1)')})]},
			proxy,
			INVITES,
		)!;
		expect(preview.embed?.video).toBeNull();
		expect(preview.embed?.image).toBeNull();
	});

	it('gives no preview for a stored card whose link is not on the allow list', () => {
		expect(mapFeedLinkPreview({embeds: [card({url: 'https://evil.test/watch?v=dQw4w9WgXcQ'})]}, proxy, INVITES)).toBe(
			null,
		);
		expect(mapFeedLinkPreview({embeds: null}, proxy, INVITES)).toBeNull();
	});
});
