// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import type {MicupBotAutomodRuleRow} from '@app/api/database/types/MicupBotTypes';
import {classifyFeedLinkPreviewUrl, type FeedInviteBase} from '@app/api/feed/FeedLinkPreview';
import {isMicupBotLive, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {
	MICUPBOT_AUTOMOD_CIRCUIT,
	MICUPBOT_LIVE_LAG_WARN_MS,
	MICUPBOT_TEXT,
} from '@app/api/guild/micupbot/MicupBotConstants';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
export interface MicupBotAutomodActionPayload {
	guild_id: string;
	channel_id: string;
	message_id: string;
	author_id: string;
	rule: MicupBotAutomodRuleRow['rule'];
	action: MicupBotAutomodRuleRow['action'];
	mute_seconds: number;
	at: number;
}
export function createMicupBotAutomodRunner(deps: WorkerDependencies) {
	return {
		async run(payload: MicupBotAutomodActionPayload): Promise<void> {
			const counts = {deleted: 0, warned: 0, muted: 0, skipped: 0, failed: 0};
			let failure: unknown;
			try {
				const bot = micupBotUserId();
				if (bot === null || !isMicupBotLive(deps.limitConfigService)) {
					counts.skipped++;
					return;
				}
				const guildId = createGuildID(BigInt(payload.guild_id));
				const channelId = createChannelID(BigInt(payload.channel_id));
				const authorId = createUserID(BigInt(payload.author_id));
				const requestCache = createRequestCache();
				const {limit, windowMs, pauseSeconds} = MICUPBOT_AUTOMOD_CIRCUIT;
				if (await deps.kvClient.get(`micupbot:amstop:${guildId}`)) {
					counts.skipped++;
					return;
				}
				if (
					(await deps.gatewayService.getUserPermissions({guildId, userId: authorId, channelId})) &
					Permissions.MANAGE_MESSAGES
				) {
					counts.skipped++;
					return;
				}
				if (!(await deps.kvClient.checkLeakyBucketLimit(`micupbot:amcb:${guildId}`, limit, windowMs, 1)).allowed) {
					counts.skipped++;
					if (
						(await deps.kvClient.setnx(`micupbot:amstop:${guildId}`, '1', pauseSeconds)) &&
						(await deps.kvClient.setnx(`micupbot:amwarn:${guildId}`, '1', pauseSeconds))
					) {
						await deps.channelService.messages.send.sendMessage({
							viewer: {kind: 'user', userId: bot, bot: true, capable: true},
							user: await deps.userRepository.findUniqueAssert(bot),
							channelId,
							requestCache,
							data: {content: MICUPBOT_TEXT.automodPaused, allowed_mentions: {parse: []}},
						});
						counts.warned++;
					}
					return;
				}
				const reason = MICUPBOT_TEXT.audit.automod(payload.rule);
				try {
					await deps.channelService.messages.deletion.deleteMessage({
						viewer: {kind: 'user', userId: bot, bot: true, capable: true},
						userId: bot,
						channelId,
						messageId: createMessageID(BigInt(payload.message_id)),
						requestCache,
						auditLogReason: reason,
					});
				} catch (error) {
					if (error instanceof UnknownMessageError) {
						counts.skipped++;
						return;
					}
					throw error;
				}
				counts.deleted++;
				if (payload.action === 'delete_warn') {
					if (!(await deps.kvClient.setnx(`micupbot:amw:${guildId}:${authorId}`, '1', 30))) return;
					await deps.channelService.messages.send.sendMessage({
						viewer: {kind: 'user', userId: bot, bot: true, capable: true},
						user: await deps.userRepository.findUniqueAssert(bot),
						channelId,
						requestCache,
						data: {
							content: MICUPBOT_TEXT.automodWarning(payload.author_id, MICUPBOT_TEXT.automodReason[payload.rule]),
							allowed_mentions: {parse: [], users: [authorId]},
						},
					});
					counts.warned++;
				} else if (payload.action === 'delete_mute') {
					await deps.guildService.members.updateMember(
						{
							userId: bot,
							targetId: authorId,
							guildId,
							data: {
								communication_disabled_until: new Date(Date.now() + payload.mute_seconds * 1000).toISOString(),
								timeout_reason: reason,
							},
							requestCache,
						},
						reason,
					);
					counts.muted++;
				}
			} catch (error) {
				failure = error;
				counts.failed++;
			} finally {
				const summary = {
					guild_id: payload.guild_id,
					rule: payload.rule,
					lag_ms: Math.max(0, Date.now() - payload.at),
					...counts,
					error: failure,
				};
				if (counts.failed || summary.lag_ms > MICUPBOT_LIVE_LAG_WARN_MS)
					Logger.warn(summary, 'MicupBOT automod action done');
				else Logger.info(summary, 'MicupBOT automod action done');
			}
		},
	};
}
export interface MicupBotViolation {
	rule: MicupBotAutomodRuleRow['rule'];
	action: MicupBotAutomodRuleRow['action'];
	mute_seconds: number;
}
function host(value: string): string {
	return value
		.toLowerCase()
		.replace(/^www\./, '')
		.replace(/\.$/, '');
}

// Weak keys tie derived data to the cached settings snapshot without retaining expired guilds/rules.
const endpointPatterns = new WeakMap<
	ReadonlyArray<string>,
	{
		ownHosts: ReadonlyArray<string> | undefined;
		bases: Array<FeedInviteBase>;
		own: Set<string>;
	}
>();
const rulePatterns = new WeakMap<MicupBotAutomodRuleRow, {domains: Array<string>; words: Array<RegExp>}>();
const WORD_CHAR = '[\\p{L}\\p{M}\\p{N}]';
const STARTS_WITH_WORD_CHAR = new RegExp(`^${WORD_CHAR}`, 'u');
const ENDS_WITH_WORD_CHAR = new RegExp(`${WORD_CHAR}$`, 'u');

// A blocked word matches only as a whole word; a leading/trailing `*` lets letters precede/follow it.
// Boundaries apply only where the word itself starts/ends with a letter or digit, so emoji still match.
function compileWord(raw: string): RegExp | null {
	const word = raw.toLocaleLowerCase('tr-TR');
	const anyBefore = word.startsWith('*');
	const anyAfter = word.length > 1 && word.endsWith('*');
	const text = word.slice(anyBefore ? 1 : 0, anyAfter ? -1 : undefined);
	if (!text) return null;
	const before = !anyBefore && STARTS_WITH_WORD_CHAR.test(text) ? `(?<!${WORD_CHAR})` : '';
	const after = !anyAfter && ENDS_WITH_WORD_CHAR.test(text) ? `(?!${WORD_CHAR})` : '';
	return new RegExp(`${before}${RegExp.escape(text)}${after}`, 'u');
}

function getEndpointPatterns(inviteHosts: ReadonlyArray<string>, ownHosts?: ReadonlyArray<string>) {
	const cached = endpointPatterns.get(inviteHosts);
	if (cached && cached.ownHosts === ownHosts) return cached;
	const bases: Array<FeedInviteBase> = inviteHosts.map((endpoint) => {
		const url = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
		return {origin: url.origin, pathPrefix: `${url.pathname.replace(/\/+$/, '')}/`};
	});
	for (const scheme of ['http', 'https']) {
		for (const [domain, pathPrefix] of [
			['discord.gg', '/'],
			['discord.com', '/invite/'],
			['discordapp.com', '/invite/'],
		]) {
			bases.push({origin: `${scheme}://${domain}`, pathPrefix: pathPrefix!});
		}
	}
	const own = new Set(
		[
			...inviteHosts.map((endpoint) => new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).hostname),
			...(ownHosts ?? []),
		].map(host),
	);
	const patterns = {ownHosts, bases, own};
	endpointPatterns.set(inviteHosts, patterns);
	return patterns;
}

function getRulePatterns(rule: MicupBotAutomodRuleRow) {
	let patterns = rulePatterns.get(rule);
	if (!patterns) {
		patterns = {
			domains: [...(rule.allowed_domains ?? [])].map(host),
			words: [...(rule.words ?? [])].map(compileWord).filter((word) => word !== null),
		};
		rulePatterns.set(rule, patterns);
	}
	return patterns;
}

export function detectMicupBotViolation(params: {
	content: string;
	mentionedUserIds: ReadonlyArray<string>;
	mentionedRoleIds: ReadonlyArray<string>;
	mentionEveryone: boolean;
	rules: Array<MicupBotAutomodRuleRow>;
	inviteHosts: ReadonlyArray<string>;
	ownHosts?: ReadonlyArray<string>;
}): MicupBotViolation | null {
	const {bases, own} = getEndpointPatterns(params.inviteHosts, params.ownHosts);
	const urls: Array<{url: URL; explicit: boolean}> = [];
	for (const match of params.content.matchAll(
		/(?:https?:\/\/|www\.)[^\s<>]+|(?<![\p{L}\p{N}./?=&@:-])[a-z\d.-]+\.[a-z]{2,}\/[^\s<>]+/giu,
	)) {
		const raw = match[0].replace(/[.,;:!?)\]}'"*_~]+$/, '');
		try {
			urls.push({
				url: new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`),
				explicit: /^(?:https?:\/\/|www\.)/i.test(raw),
			});
		} catch {
			/* A malformed URL is not a link. No network lookup is performed. */
		}
	}
	for (const rule of params.rules) {
		if (!rule.enabled) continue;
		let matches = false;
		switch (rule.rule) {
			case 'invites':
				matches = urls.some(({url}) => {
					const candidate = new URL(url);
					candidate.hostname = host(candidate.hostname);
					return classifyFeedLinkPreviewUrl(candidate.href, bases)?.kind === 'invite';
				});
				break;
			case 'links': {
				const allowed = getRulePatterns(rule).domains;
				matches = urls.some(({url, explicit}) => {
					const domain = host(url.hostname);
					return (
						explicit &&
						!allowed.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`)) &&
						!own.has(domain)
					);
				});
				break;
			}
			case 'words': {
				const lower = params.content.toLocaleLowerCase('tr-TR');
				matches = getRulePatterns(rule).words.some((word) => word.test(lower));
				break;
			}
			case 'mentions':
				matches =
					new Set(params.mentionedUserIds).size +
						new Set(params.mentionedRoleIds).size +
						(params.mentionEveryone ? rule.threshold : 0) >=
					rule.threshold;
				break;
			case 'caps': {
				const letters = params.content.match(/\p{L}/gu) ?? [];
				const upper = letters.filter((letter) => letter !== letter.toLocaleLowerCase('tr-TR')).length;
				matches = letters.length >= 10 && upper * 100 >= letters.length * rule.threshold;
				break;
			}
			case 'spam':
				break;
		}
		if (matches) return {rule: rule.rule, action: rule.action, mute_seconds: rule.mute_seconds};
	}
	return null;
}
