// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {createMarkdownProcessor} from '@astrojs/markdown-remark';
import {compile} from '@mdx-js/mdx';
import type {Root} from 'mdast';
import remarkGfm from 'remark-gfm';
import {
	brandDocsFrontmatter,
	CLOSED_DOCS_SECTIONS,
	remarkDocsBranding,
	transformDocsContent,
} from '../src/branding/DocsBranding.ts';

const names = ['FLUXER_DOCS_PRODUCT_NAME', 'FLUXER_BASE_DOMAIN', 'FLUXER_PUBLIC_SCHEME', 'FLUXER_PUBLIC_PORT'];
const previous = names.map((name) => process.env[name]);
before(() => {
	process.env.FLUXER_DOCS_PRODUCT_NAME = 'Micup';
	process.env.FLUXER_BASE_DOMAIN = 'micup.gg';
	process.env.FLUXER_PUBLIC_SCHEME = 'https';
	process.env.FLUXER_PUBLIC_PORT = '443';
});
after(() => {
	for (const [index, name] of names.entries()) {
		if (previous[index] === undefined) delete process.env[name];
		else process.env[name] = previous[index];
	}
});

test('Micup titles and descriptions are branded before content validation', () => {
	assert.deepEqual(brandDocsFrontmatter({title: 'Fluxer API', description: 'Use Fluxer.', draft: false}, 'index.md'), {
		title: 'Micup API',
		description: 'Use Micup.',
		draft: false,
	});
});

test('prose and endpoint examples change without changing wire names or quoted errors', () => {
	const tree: Root = {
		type: 'root',
		children: [
			{
				type: 'paragraph',
				children: [
					{type: 'text', value: 'Fluxer uses X-Fluxer-Version.'},
					{type: 'inlineCode', value: 'Fluxer error'},
				],
			},
			{
				type: 'code',
				lang: 'json',
				value:
					'{"api":"https://api.example.com/v1","public":"https://public.example.com","gateway":"wss://gateway.example.com","media":"https://media.example.com/a","cdn":"https://cdn.example.com/a","browser":"Fluxer Client","error":"Fluxer error"}',
			},
		],
	};
	transformDocsContent(tree, 'http-api/instance.mdx');
	assert.equal(
		(tree.children[0] as {children: Array<{value: string}>}).children[0].value,
		'Micup uses X-Fluxer-Version.',
	);
	assert.equal((tree.children[0] as {children: Array<{value: string}>}).children[1].value, 'Fluxer error');
	assert.equal(
		(tree.children[1] as {value: string}).value,
		'{"api":"https://micup.gg/api/v1","public":"https://micup.gg/api","gateway":"wss://micup.gg/gateway","media":"https://micup.gg/media/a","cdn":"https://micup.gg/a","browser":"Fluxer Client","error":"Fluxer error"}',
	);
});

test('upstream operator defaults, origins and instructions remain attributed to Fluxer', () => {
	const tree: Root = {
		type: 'root',
		children: [
			{
				type: 'paragraph',
				children: [
					{type: 'text', value: 'Default Fluxer. Built-in Fluxer web origins.'},
					{type: 'inlineCode', value: 'https://web.fluxer.app'},
					{type: 'inlineCode', value: 'https://fluxer.dev'},
				],
			},
		],
	};
	transformDocsContent(tree, 'C:\\repo\\src\\content\\docs\\operator\\configuration.mdx');
	assert.match(JSON.stringify(tree.children[0]), /upstream Fluxer/);
	assert.match(JSON.stringify(tree.children[1]), /Default Fluxer/);
	assert.match(JSON.stringify(tree), /https:\/\/web.fluxer.app/);
	assert.match(JSON.stringify(tree), /https:\/\/fluxer.dev/);
});

test('downloads become unavailable rather than an invented Micup mirror', () => {
	const tree: Root = {
		type: 'root',
		children: [{type: 'code', value: 'curl https://pkgs.fluxer.com/deb/fluxer.sources'}],
	};
	transformDocsContent(tree, 'downloads/linux-repositories.md');
	assert.match(JSON.stringify(tree), /no verified Micup download origin/i);
	assert.doesNotMatch(JSON.stringify(tree), /pkgs.fluxer|curl|pkgs.micup/);
	assert.match(
		String(
			brandDocsFrontmatter(
				{title: 'Linux repositories', description: 'Fluxer publishes repos.'},
				'downloads/linux-repositories.md',
			).description,
		),
		/unavailable/i,
	);
});

test('default Fluxer content and metadata remain unchanged', () => {
	delete process.env.FLUXER_DOCS_PRODUCT_NAME;
	try {
		const tree: Root = {type: 'root', children: [{type: 'paragraph', children: [{type: 'text', value: 'Fluxer'}]}]};
		const original = structuredClone(tree);
		transformDocsContent(tree, 'index.md');
		assert.deepEqual(tree, original);
		assert.deepEqual(brandDocsFrontmatter({title: 'Fluxer API'}, 'index.md'), {title: 'Fluxer API'});
	} finally {
		process.env.FLUXER_DOCS_PRODUCT_NAME = 'Micup';
	}
});

test('error registry quotations retain their exact upstream wording and support addresses', () => {
	const tree: Root = {
		type: 'root',
		children: [
			{type: 'paragraph', children: [{type: 'text', value: 'Fluxer returns errors.'}]},
			{type: 'heading', depth: 2, children: [{type: 'text', value: 'API error code registry'}]},
			{type: 'paragraph', children: [{type: 'text', value: 'Blocked from the Fluxer API; email support@fluxer.app'}]},
		],
	};
	transformDocsContent(tree, 'http-api/errors.md');
	assert.match(JSON.stringify(tree.children[0]), /Micup returns errors/);
	assert.match(JSON.stringify(tree), /quoted upstream messages/);
	assert.match(JSON.stringify(tree), /Blocked from the Fluxer API; email support@fluxer.app/);
});

test('Micup removes upstream hosted promotions but keeps source attribution', () => {
	const tree: Root = {
		type: 'root',
		children: [
			{
				type: 'paragraph',
				children: [{type: 'link', url: 'https://fluxer.app/donate', children: [{type: 'text', value: 'Donate'}]}],
			},
			{
				type: 'paragraph',
				children: [
					{
						type: 'link',
						url: 'https://github.com/fluxerapp/fluxer',
						children: [{type: 'text', value: 'Upstream source'}],
					},
				],
			},
		],
	};
	transformDocsContent(tree, 'index.md');
	assert.doesNotMatch(JSON.stringify(tree), /fluxer.app\/donate/);
	assert.match(JSON.stringify(tree), /github.com\/fluxerapp\/fluxer/);
});

test('the real Markdown homepage renders Micup discovery with upstream attribution', async () => {
	const fileURL = new URL('../src/content/docs/index.md', import.meta.url);
	const source = (await readFile(fileURL, 'utf8')).replace(/^---[\s\S]*?---\r?\n/u, '');
	const processor = await createMarkdownProcessor({remarkPlugins: [remarkDocsBranding], syntaxHighlight: false});
	const rendered = await processor.render(source, {fileURL});
	assert.match(rendered.code, /Micup is a self-hostable chat platform/);
	assert.match(rendered.code, /https:\/\/micup.gg\/\.well-known\/fluxer/);
	assert.match(rendered.code, /upstream Fluxer source/);
	assert.doesNotMatch(rendered.code, /https:\/\/fluxer.app/);
});

test('the real MDX instance endpoint example compiles with the single-domain profile', async () => {
	const file = new URL('../src/content/docs/http-api/instance.mdx', import.meta.url);
	const source = (await readFile(file, 'utf8')).replace(/^---[\s\S]*?---\r?\n/u, '');
	const rendered = String(await compile({value: source, path: file}, {remarkPlugins: [remarkDocsBranding]}));
	for (const endpoint of [
		'https://micup.gg/api',
		'wss://micup.gg/gateway',
		'https://micup.gg/media',
		'https://micup.gg/marketing',
		'https://micup.gg/admin',
	]) {
		assert.ok(rendered.includes(endpoint), endpoint);
	}
	assert.doesNotMatch(rendered, /api\.example\.com|public\.example\.com|gateway\.example\.com|cdn\.example\.com/);
});

async function readDocsPage(page: string): Promise<{file: URL; source: string}> {
	for (const extension of ['mdx', 'md']) {
		const file = new URL(`../src/content/docs/${page}.${extension}`, import.meta.url);
		try {
			return {file, source: await readFile(file, 'utf8')};
		} catch {}
	}
	throw new Error(`missing docs page ${page}`);
}

async function renderDocsPage(page: string): Promise<string> {
	const {file, source} = await readDocsPage(page);
	const body = source.replace(/^---[\s\S]*?---\r?\n/u, '');
	if (file.pathname.endsWith('.md')) {
		const processor = await createMarkdownProcessor({remarkPlugins: [remarkDocsBranding], syntaxHighlight: false});
		return (await processor.render(body, {fileURL: file})).code;
	}
	return String(await compile({value: body, path: file}, {remarkPlugins: [remarkGfm, remarkDocsBranding]}));
}

test('Micup withholds the announcement channels page', () => {
	const page = 'src/content/docs/topics/announcement-channels.md';
	const data: {title: string; draft?: boolean} = {title: 'Announcement channels'};
	assert.equal(brandDocsFrontmatter(data, page).draft, true);
	delete process.env.FLUXER_DOCS_PRODUCT_NAME;
	try {
		assert.equal(brandDocsFrontmatter(data, page).draft, undefined);
	} finally {
		process.env.FLUXER_DOCS_PRODUCT_NAME = 'Micup';
	}
});

test('every hidden announcement section still exists in the upstream pages', async () => {
	for (const [page, headings] of Object.entries(CLOSED_DOCS_SECTIONS)) {
		const {source} = await readDocsPage(page);
		for (const heading of headings)
			assert.match(source, new RegExp(`^#{2,3} ${heading}$`, 'mu'), `${page}: ${heading}`);
	}
});

test('the real pages drop announcement following and publishing in the Micup build', async () => {
	const expectations: Record<string, {hidden: Array<string>; kept: Array<string>}> = {
		'http-api/channels': {
			hidden: [
				'Follow announcement channel',
				'/v1/channels/{channel_id}/followers',
				'follower-stats',
				'Followed channel object',
				'GUILD_ANNOUNCEMENT',
				'CHANNEL_HAS_FOLLOWED_CHANNELS',
				'into an announcement channel or back',
				'/topics/announcement-channels/',
			],
			kept: [
				'Modify channel',
				'A direct message and the personal notes channel match no variant',
				'Deleting a guild channel permanently removes its messages, attachments, invites and webhooks.',
			],
		},
		'http-api/messages': {
			hidden: [
				'/crosspost',
				'Get message crosspost source',
				'CROSSPOSTED',
				'SOURCE_MESSAGE_DELETED',
				'PUBLISHED_MESSAGE_EDIT_RATE_LIMITED',
				'/topics/announcement-channels/',
			],
			kept: [
				'Create message',
				'Modify message',
				'SUPPRESS_EMBEDS',
				'Delete message attachment',
				'starts with the media endpoint path followed by',
				'Reply, forward, or published message reference',
			],
		},
		'http-api/webhooks': {
			hidden: [
				'CHANNEL_FOLLOWER',
				'Webhook source guild object',
				'channel follower webhook',
				'INVALID_FOLLOW_TARGET_CHANNEL',
			],
			kept: ['Execute webhook', 'INCOMING', 'Release publication', 'Schema or image failure'],
		},
		'http-api/permissions': {
			hidden: ['Announcement channel permissions', '#crosspost-message', '#follow-announcement-channel'],
			kept: ['Elevated permissions', 'MANAGE_WEBHOOKS'],
		},
		'topics/rate-limits': {
			hidden: [
				'These allowances answer 429 the same way',
				'MESSAGE_CROSSPOST_RATE_LIMITED',
				'#announcement-channel-allowances',
				'#crosspost-message',
			],
			kept: ['Allowances answering 400', 'Allowances answering 429', 'Take a voice seat reports'],
		},
		'admin-api/jobs': {
			hidden: ['removeChannelFollowers', 'follower cleanup', '/topics/announcement-channels/'],
			kept: ['Processing lanes', 'refreshSearchIndex'],
		},
	};
	for (const page of Object.keys(CLOSED_DOCS_SECTIONS)) assert.ok(page in expectations, page);
	for (const [page, {hidden, kept}] of Object.entries(expectations)) {
		const rendered = await renderDocsPage(page);
		for (const phrase of hidden) assert.ok(!rendered.includes(phrase), `${page} still shows ${phrase}`);
		for (const phrase of kept) assert.ok(rendered.includes(phrase), `${page} lost ${phrase}`);
	}
	delete process.env.FLUXER_DOCS_PRODUCT_NAME;
	try {
		assert.ok((await renderDocsPage('http-api/channels')).includes('Follow announcement channel'));
	} finally {
		process.env.FLUXER_DOCS_PRODUCT_NAME = 'Micup';
	}
});

test('links into the hidden announcement page and sections become plain text elsewhere', async () => {
	const rendered = await renderDocsPage('http-api/guilds');
	assert.doesNotMatch(rendered, /#crosspost-message|#follow-announcement-channel|\/topics\/announcement-channels\//u);
	assert.match(rendered, /Crosspost message/u);
	assert.match(rendered, /Follow announcement channel/u);
});
