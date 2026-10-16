// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RemarkPlugin} from '@astrojs/markdown-remark';
import type {Parent, PhrasingContent, Root, RootContent} from 'mdast';
import {docsExampleEndpoints, docsProductName} from '../server/DocsConfig.ts';

function docsSection(file: string): string {
	return file
		.replaceAll('\\', '/')
		.replace(/^.*\/content\/docs\//u, '')
		.split('/')[0];
}

function docsPage(file: string): string {
	return file
		.replaceAll('\\', '/')
		.replace(/^.*\/content\/docs\//u, '')
		.replace(/\.mdx?$/u, '');
}

// TEMPORARY: announcement channels are closed; open only after bucketing ((source_channel_id, bucket), source_message_id) and capping followers, on a product decision.
const CLOSED_DOCS_PAGES = new Set(['topics/announcement-channels']);
export const CLOSED_DOCS_SECTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
	'http-api/channels': [
		'Followed channel object',
		'Channel follower stats object',
		'Follow announcement channel',
		'Get channel follower stats',
	],
	'http-api/messages': ['Crosspost message', 'Get message crosspost source'],
	'http-api/webhooks': ['Webhook source guild object', 'Webhook source channel object'],
	'http-api/permissions': ['Announcement channel permissions'],
	'topics/rate-limits': ['Announcement channel allowances'],
};
const CLOSED_DOCS_PROSE_PAGES = new Set([
	'http-api/channels',
	'http-api/messages',
	'http-api/webhooks',
	'admin-api/jobs',
]);
const CLOSED_DOCS_MENTION =
	/(?<!(?:, |or ))announcement channel|follower|followed[ _]channel|crosspost|published[ _]message(?! reference)|SOURCE_MESSAGE_DELETED|GUILD_ANNOUNCEMENT/iu;
const CLOSED_DOCS_LINKS = new Set([
	...[...CLOSED_DOCS_PAGES].map((page) => `/${page}/`),
	...Object.entries(CLOSED_DOCS_SECTIONS).flatMap(([page, headings]) =>
		headings.map((heading) => `/${page}/#${heading.toLowerCase().replaceAll(' ', '-')}`),
	),
]);

type DocsNode = Root | RootContent;

function textOf(node: DocsNode): string {
	let text = 'value' in node && typeof node.value === 'string' ? node.value : '';
	if ('url' in node) text += ` ${node.url}`;
	if ('children' in node) for (const child of node.children) text += textOf(child);
	return text;
}

function isClosedLink(url: string, page: string): boolean {
	const target = url.startsWith('#') ? `/${page}/${url}` : url;
	return CLOSED_DOCS_LINKS.has(target) || CLOSED_DOCS_LINKS.has(target.split('#')[0]);
}

function unlinkClosed(node: DocsNode, page: string): void {
	if (!('children' in node)) return;
	node.children = node.children.flatMap((child) =>
		child.type === 'link' && isClosedLink(child.url, page) ? child.children : [child],
	) as typeof node.children;
	for (const child of node.children) unlinkClosed(child, page);
}

function footnoteMarker(node: DocsNode): string | null {
	if (node.type === 'paragraph') return footnoteMarker(node.children[0] ?? {type: 'text', value: ''});
	return node.type === 'mdxJsxTextElement' && node.name === 'sup' ? textOf(node) : null;
}

function footnoteMarkers(node: DocsNode): Set<string> {
	const markers = new Set<string>();
	const marker = node.type === 'paragraph' ? null : footnoteMarker(node);
	if (marker !== null) markers.add(marker);
	if ('children' in node)
		for (const child of node.children) for (const found of footnoteMarkers(child)) markers.add(found);
	return markers;
}

function withoutClosedSentences(children: Array<PhrasingContent>): Array<PhrasingContent> {
	const lead = footnoteMarker({type: 'paragraph', children}) === null ? [] : children.slice(0, 1);
	const sentences: Array<Array<PhrasingContent>> = [[]];
	for (const child of children.slice(lead.length)) {
		if (child.type !== 'text') {
			sentences[sentences.length - 1].push(child);
			continue;
		}
		child.value.split(/(?<=\.)\s+/u).forEach((part, index) => {
			if (index > 0) sentences.push([]);
			if (part.length > 0) sentences[sentences.length - 1].push({...child, value: part});
		});
	}
	const mentions = (sentence: Array<PhrasingContent>): boolean =>
		CLOSED_DOCS_MENTION.test(textOf({type: 'paragraph', children: sentence}));
	if (mentions(sentences[0])) return lead.length === 0 ? [] : children;
	const kept = sentences.filter((sentence) => !mentions(sentence));
	if (kept.length === sentences.length) return children;
	return [
		...lead,
		...kept.flatMap(
			(sentence, index): Array<PhrasingContent> => (index === 0 ? sentence : [{type: 'text', value: ' '}, ...sentence]),
		),
	];
}

function keepsRowWithoutClosedClause(row: RootContent): boolean {
	for (const cell of 'children' in row ? row.children : []) {
		for (const child of 'children' in cell ? cell.children : []) {
			if (child.type !== 'text') continue;
			child.value = child.value.replace(/, or [^,]*$/u, (clause) => (CLOSED_DOCS_MENTION.test(clause) ? '' : clause));
		}
	}
	return !CLOSED_DOCS_MENTION.test(textOf(row));
}

function dropClosedMentions(node: Root | Parent): void {
	let orphanedFootnotes = new Set<string>();
	const kept: Array<RootContent> = [];
	for (const child of node.children as Array<RootContent>) {
		if (child.type === 'heading') orphanedFootnotes = new Set();
		if (child.type === 'tableRow' && CLOSED_DOCS_MENTION.test(textOf(child)) && !keepsRowWithoutClosedClause(child))
			continue;
		if (child.type === 'paragraph') {
			if (orphanedFootnotes.has(footnoteMarker(child) ?? '')) continue;
			child.children = withoutClosedSentences(child.children);
			if (textOf(child).trim().length === 0) continue;
		} else if ('children' in child && child.children.length > 0 && child.type !== 'heading') {
			const before = footnoteMarkers(child);
			dropClosedMentions(child);
			if (child.children.length === 0) continue;
			if (child.type === 'table') {
				const after = footnoteMarkers(child);
				orphanedFootnotes = new Set([...before].filter((marker) => !after.has(marker)));
			}
		}
		kept.push(child);
	}
	node.children = kept as typeof node.children;
}

function hideClosedFeatures(tree: Root, page: string): void {
	const headings = CLOSED_DOCS_SECTIONS[page] ?? [];
	let hiddenDepth = 0;
	tree.children = tree.children.filter((node) => {
		if (node.type === 'heading') {
			if (hiddenDepth > 0 && node.depth <= hiddenDepth) hiddenDepth = 0;
			if (hiddenDepth === 0 && headings.includes(textOf(node))) hiddenDepth = node.depth;
		}
		return hiddenDepth === 0;
	});
	if (CLOSED_DOCS_PROSE_PAGES.has(page)) dropClosedMentions(tree);
	unlinkClosed(tree, page);
}

function brandProse(value: string): string {
	return value.replace(/(?<![\w-])Fluxer(?![\w-])/gu, docsProductName());
}

export function brandDocsFrontmatter<T extends Record<string, unknown>>(data: T, file: string): T {
	if (docsProductName() === 'Fluxer') return data;
	const branded = {...data};
	if (CLOSED_DOCS_PAGES.has(docsPage(file))) Object.assign(branded, {draft: true});
	for (const key of ['title', 'description'] as const) {
		if (typeof data[key] === 'string') Object.assign(branded, {[key]: brandProse(data[key])});
	}
	if (docsSection(file) === 'operator') {
		Object.assign(branded, {description: `Upstream Fluxer operator reference. ${data.description ?? ''}`});
	}
	return branded;
}

function paragraph(value: string): RootContent {
	return {type: 'paragraph', children: [{type: 'text', value}]};
}

export function transformDocsContent(tree: Root, file: string): void {
	if (docsProductName() === 'Fluxer') return;
	hideClosedFeatures(tree, docsPage(file));
	const section = docsSection(file);
	// sanalyer: downloads/overview is rewritten for dl.sanalyer.com by tools/brand/docs-marka.mjs; the upstream
	// package pages are drafts there, so this transform no longer replaces the section.
	const containsPromotion = (node: RootContent): boolean => {
		if ('url' in node && /^(https:\/\/fluxer\.app\/(plutonium|donate)|https:\/\/discord\.gg\/)/u.test(node.url))
			return true;
		if ('value' in node && typeof node.value === 'string' && node.value === 'Getting help') return true;
		if ('children' in node) return node.children.some((child) => containsPromotion(child as RootContent));
		return false;
	};
	tree.children = tree.children.filter((node) => !containsPromotion(node));
	if (section === 'operator') {
		tree.children = tree.children.filter(
			(node) => !JSON.stringify(node).includes('File issues and follow development'),
		);
		tree.children.unshift(
			paragraph(
				`This is the upstream Fluxer self-hosting reference, not a description of the managed ${docsProductName()} deployment. Defaults, built-in origins, installation artifacts and resource figures below belong to upstream Fluxer. They are not ${docsProductName()} capacity targets.`,
			),
		);
		return;
	}
	const endpoints = docsExampleEndpoints();
	const origins: Record<string, string> = {
		'https://api.example.com': endpoints.api,
		'https://public.example.com': endpoints.api,
		'wss://gateway.example.com': endpoints.gateway,
		'https://media.example.com': endpoints.media,
		'https://cdn.example.com': endpoints.static_cdn,
		'https://admin.example.com': endpoints.admin,
		'https://app.example.com': endpoints.app,
	};
	const replaceExamples = (value: string): string =>
		value.replace(
			/https:\/\/(?:api|public|media|cdn|admin|app)\.example\.com(?=[/\s"'`?#]|$)|wss:\/\/gateway\.example\.com(?=[/\s"'`?#]|$)/gu,
			(origin) => origins[origin],
		);
	const visit = (node: Root | RootContent): void => {
		if (node.type === 'text') node.value = replaceExamples(brandProse(node.value));
		else if (node.type === 'code' || node.type === 'inlineCode') node.value = replaceExamples(node.value);
		else if (node.type === 'link' || node.type === 'definition') node.url = replaceExamples(node.url);
		if (node.type === 'inlineCode' && node.value === 'https://fluxer.app/.well-known/fluxer') {
			node.value = `${endpoints.app}/.well-known/fluxer`;
		}
		if (node.type === 'code') {
			node.value = node.value.replace('https://example.com/.well-known/fluxer', `${endpoints.app}/.well-known/fluxer`);
			if (file.replaceAll('\\', '/').endsWith('http-api/instance.mdx')) {
				for (const [key, endpoint] of [
					['marketing', endpoints.marketing],
					['invite', endpoints.invite],
					['gift', endpoints.gift],
				]) {
					node.value = node.value.replace(
						new RegExp(`("${key}":\\s*")https://example\\.com[^"\\s]*`, 'u'),
						`$1${endpoint}`,
					);
				}
			}
		}
		if ('children' in node) for (const child of node.children) visit(child as RootContent);
	};
	let quotedRegistry = false;
	const children: Array<RootContent> = [];
	for (const child of tree.children) {
		if (file.replaceAll('\\', '/').endsWith('http-api/errors.md') && child.type === 'heading' && child.depth === 2) {
			quotedRegistry = child.children.some((node) => node.type === 'text' && /error code registry$/u.test(node.value));
		}
		if (!quotedRegistry) visit(child);
		children.push(child);
		if (quotedRegistry && child.type === 'heading' && child.depth === 2) {
			children.push(paragraph('These are quoted upstream messages, reproduced exactly.'));
		}
	}
	tree.children = children;
	if (JSON.stringify(tree).includes('https://web.fluxer.app')) {
		tree.children.unshift(
			paragraph(
				'The upstream origins quoted on this page are compatibility constants. They remain exact protocol/reference values, not this deployment’s public endpoint.',
			),
		);
	}
	// sanalyer: the homepage and its source attribution live in tools/brand/docs-marka.mjs (rewritten index.md).
}

export const remarkDocsBranding: RemarkPlugin = () => (tree, file) => {
	transformDocsContent(tree, file.path);
};
