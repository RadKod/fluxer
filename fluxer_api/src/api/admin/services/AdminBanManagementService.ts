// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import type {AdminRepository, BannedIpEntry} from '@app/api/admin/AdminRepository';
import type {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {isHighCgnatBlastRadiusRisk} from '@app/api/ban/IpBanCgnatGuard';
import {isIpBanExempt} from '@app/api/ban/IpBanExemptions';
import {
	BANNED_AVATAR_HASHES_REFRESH_CHANNEL,
	BANNED_FILE_SHAS_REFRESH_CHANNEL,
	BANNED_PHRASES_REFRESH_CHANNEL,
	BANNED_PROFILE_SUBSTRINGS_REFRESH_CHANNEL,
	BANNED_URL_DOMAINS_REFRESH_CHANNEL,
	BANNED_URLS_REFRESH_CHANNEL,
	ContentBlocklistCategory,
	ContentBlocklistSeverity,
} from '@app/api/constants/ContentModeration';
import {IP_BAN_REFRESH_CHANNEL} from '@app/api/constants/IpBan';
import {deleteOneOrMany, fetchMany, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {BannedProfileSubstringRow, BannedProfileSubstringScope} from '@app/api/database/types/AdminArchiveTypes';
import {stripAnimationPrefix} from '@app/api/infrastructure/AssetEntitlementUtils';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import {bannedAvatarHashCache} from '@app/api/middleware/BannedAvatarHashCache';
import {fileShaCache} from '@app/api/middleware/FileShaCache';
import {ipBanCache} from '@app/api/middleware/IpBanMiddleware';
import {phraseBlocklistCache} from '@app/api/middleware/PhraseBlocklistCache';
import {profileSubstringBlocklistCache} from '@app/api/middleware/ProfileSubstringBlocklistCache';
import {getInstanceConfigRepository, getIpInfoService} from '@app/api/middleware/ServiceSingletons';
import {urlBlocklistCache} from '@app/api/middleware/UrlBlocklistCache';
import {BannedProfileSubstrings} from '@app/api/Tables';
import {
	computeUsernameDictionaryManifest,
	type UsernameDictionaryEntries,
	type UsernameDictionaryScope,
} from '@app/api/user/username/UsernamePolicyService';
import {parseIpBanEntry} from '@app/api/utils/IpRangeUtils';
import {canonicalizeStoredPhrase} from '@app/api/utils/PhraseBlocklistNormalization';
import {parseUrlDomainEntry} from '@app/api/utils/UrlHostRules';
import {canonicalizeUrl} from '@app/api/utils/UrlNormalizer';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {IpBanLinkedToDecisionError} from '@fluxer/errors/src/domains/moderation/IpBanLinkedToDecisionError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {AdminBlocklistListType} from '@fluxer/schema/src/domains/admin/AdminBlocklistSchemas';

interface AdminBanManagementServiceDeps {
	apiContext: ApiContext;
	adminRepository: AdminRepository;
	auditService: AdminAuditService;
	usernameDictionaryPublisher?: UsernameDictionaryPublisher;
}

interface AdminBlocklistEntry {
	list_type: AdminBlocklistListType;
	value: string;
	scope: string | null;
	category: string | null;
	severity: number | null;
	source_url: string | null;
	notes: string | null;
	content_type: string | null;
	match_subdomains: boolean | null;
	reason: string | null;
	expires_at: string | null;
	created_at: string | null;
	created_by_user_id: string | null;
}

interface AdminBlocklistEntryPage {
	items: Array<AdminBlocklistEntry>;
	has_more: boolean;
	next_after: string | null;
}

function createBlocklistEntry(
	listType: AdminBlocklistListType,
	value: string,
	overrides: Partial<Omit<AdminBlocklistEntry, 'list_type' | 'value'>> = {},
): AdminBlocklistEntry {
	return {
		list_type: listType,
		value,
		scope: null,
		category: null,
		severity: null,
		source_url: null,
		notes: null,
		content_type: null,
		match_subdomains: null,
		reason: null,
		expires_at: null,
		created_at: null,
		created_by_user_id: null,
		...overrides,
	};
}

function toIsoString(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

function toSnowflakeString(value: bigint | null | undefined): string | null {
	return value == null ? null : value.toString();
}

function normalizeAvatarHashes(hashes: Array<string>): Array<string> {
	return Array.from(new Set(hashes.map((hash) => stripAnimationPrefix(hash.toLowerCase()))));
}

function hostFromUrlOrHostname(value: string): string | null {
	const trimmed = value.trim();
	if (!/^https?:\/\//i.test(trimmed)) return trimmed;
	try {
		return new URL(trimmed).hostname;
	} catch {
		return null;
	}
}

function withReasonMetadata(entries: Array<[string, string]>, reason: string | undefined): Map<string, string> {
	if (!reason) {
		return new Map(entries);
	}
	const reasonEntry: [string, string] = ['reason', reason];
	return new Map([...entries, reasonEntry]);
}

export class AdminBanManagementService {
	constructor(private readonly deps: AdminBanManagementServiceDeps) {}

	private getUsernameDictionaryPublisher(): UsernameDictionaryPublisher {
		return (
			this.deps.usernameDictionaryPublisher ??
			new UsernameDictionaryPublisher(new CassandraUsernameDictionaryStorage(getInstanceConfigRepository()))
		);
	}

	async getUsernameDictionary() {
		return this.getUsernameDictionaryPublisher().current();
	}

	async cleanupUsernameDictionaryGenerations(now?: Date): Promise<number> {
		return cleanupUsernameDictionaryGenerations(now);
	}

	async publishUsernameDictionary(
		data: {scope: UsernameDictionaryScope; add: ReadonlyArray<string>; remove: ReadonlyArray<string>},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		if (!auditLogReason?.trim()) throw InputValidationError.create('audit_log_reason', 'A reason is required');
		const result = await this.getUsernameDictionaryPublisher().change(data);
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'username_dictionary',
			action: 'publish_username_dictionary',
			auditLogReason,
			metadata: new Map([
				['scope', data.scope],
				['dictionary_gen', String(result.dictionary_gen)],
				['count', String(result.count)],
				['hash', result.hash],
			]),
		});
		return result;
	}

	async banIp(
		data: {
			ip: string;
			duration_hours?: number;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository, auditService} = this.deps;
		// Micup: shared-network (CGNAT) addresses are refused before the write, upstream only checks the exemption list.
		const exempt = isIpBanExempt(data.ip);
		if (exempt || (await this.shouldSkipIpBanForCgnat(data.ip))) {
			await auditService.createAuditLog({
				adminUserId,
				targetType: 'ip',
				targetId: BigInt(0),
				action: exempt ? 'ban_ip_skipped_exempt' : 'ban_ip_skipped_cgnat',
				auditLogReason,
				metadata: new Map([['ip', data.ip]]),
			});
			throw new BadRequestError({
				code: APIErrorCodes.IP_BAN_DECLINED,
				message: exempt
					? 'This IP address is on the instance exemption list'
					: 'This IP address has a shared-network exemption',
			});
		}
		await this.assertIpBanNotLinked(data.ip);
		const durationHours = data.duration_hours ?? 0;
		const ttlSeconds = durationHours > 0 ? durationHours * 3600 : null;
		const expiresAt = await adminRepository.banIp(data.ip, ttlSeconds);
		ipBanCache.replaceBan(data.ip, expiresAt);
		await this.deps.apiContext.services.cache.publish(IP_BAN_REFRESH_CHANNEL, 'refresh');
		const metadata = new Map([['ip', data.ip]]);
		if (ttlSeconds !== null) {
			metadata.set('duration_hours', durationHours.toString());
			if (expiresAt) metadata.set('expires_at', expiresAt.toISOString());
		}
		await this.refreshIpBans();
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'ip',
			action: 'ban_ip',
			auditLogReason,
			metadata,
		});
	}

	private async shouldSkipIpBanForCgnat(ip: string): Promise<boolean> {
		if (parseIpBanEntry(ip)?.type !== 'single') return false;
		try {
			return isHighCgnatBlastRadiusRisk(
				await getIpInfoService().lookup(ip, {source: 'admin.ip_ban', reason: 'pre_write_cgnat_guard'}),
			);
		} catch (error) {
			Logger.warn({error, ip}, 'IPInfo CGNAT guard failed while adding IP ban');
			return false;
		}
	}

	async unbanIp(
		data: {
			ip: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		await this.assertIpBanNotLinked(data.ip);
		await adminRepository.unbanIp(data.ip);
		ipBanCache.unban(data.ip);
		await cacheService.publish(IP_BAN_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'ip',
			action: 'unban_ip',
			auditLogReason,
			metadata: new Map([['ip', data.ip]]),
		});
	}

	async checkIpBan(data: {ip: string}): Promise<{
		banned: boolean;
		expires_at: string | null;
		decision_id: string | null;
	}> {
		const match = ipBanCache.getMatch(data.ip);
		return {
			banned: match !== null,
			expires_at: toIsoString(match?.expiresAt),
			decision_id: toSnowflakeString(match?.decision?.decisionId),
		};
	}

	async blockNetworksForDecision(
		ips: ReadonlyArray<string>,
		decisionId: bigint,
		expiresAt: Date,
	): Promise<{blocked: Array<BannedIpEntry>; alreadyBlocked: Array<string>}> {
		const blocked: Array<BannedIpEntry> = [];
		const alreadyBlocked: Array<string> = [];
		for (const ip of ips) {
			const entry = await this.deps.adminRepository.banIpForDecision(ip, decisionId, expiresAt);
			if (entry) {
				blocked.push(entry);
			} else {
				alreadyBlocked.push(ip);
			}
		}
		if (blocked.length > 0) {
			await this.refreshIpBans();
		}
		return {blocked, alreadyBlocked};
	}

	async listDecisionNetworkBlocks(decisionId: bigint): Promise<Array<BannedIpEntry>> {
		return this.deps.adminRepository.listDecisionIpBans(decisionId);
	}

	async removeDecisionNetworkBlocks(decisionIds: ReadonlyArray<bigint>): Promise<Array<BannedIpEntry>> {
		const removed = await this.deps.adminRepository.removeDecisionIpBans(decisionIds);
		if (removed.length > 0) {
			await this.refreshIpBans();
		}
		return removed;
	}

	async relinkDecisionNetworkBlocks(fromDecisionId: bigint, toDecisionId: bigint): Promise<Array<BannedIpEntry>> {
		const relinked = await this.deps.adminRepository.relinkDecisionIpBans(fromDecisionId, toDecisionId);
		if (relinked.length > 0) {
			await this.refreshIpBans();
		}
		return relinked;
	}

	private async refreshIpBans(): Promise<void> {
		await ipBanCache.refresh();
		await this.deps.apiContext.services.cache.publish(IP_BAN_REFRESH_CHANNEL, 'refresh');
	}

	private async assertIpBanNotLinked(ip: string): Promise<void> {
		const decisionId = await this.deps.adminRepository.findIpBanDecision(ip);
		if (decisionId !== null) {
			throw new IpBanLinkedToDecisionError(decisionId);
		}
	}

	async banEmail(
		data: {
			email: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		await adminRepository.banEmail(data.email);
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'email',
			action: 'ban_email',
			auditLogReason,
			metadata: new Map([['email', data.email]]),
		});
	}

	async unbanEmail(
		data: {
			email: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		await adminRepository.unbanEmail(data.email);
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'email',
			action: 'unban_email',
			auditLogReason,
			metadata: new Map([['email', data.email]]),
		});
	}

	async checkEmailBan(data: {email: string}): Promise<{
		banned: boolean;
	}> {
		const {adminRepository} = this.deps;
		const banned = await adminRepository.isEmailBanned(data.email);
		return {banned};
	}

	async banPhrase(
		data: {
			phrase: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		await adminRepository.banPhrase(data.phrase);
		phraseBlocklistCache.add(data.phrase);
		await cacheService.publish(BANNED_PHRASES_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'phrase',
			action: 'ban_phrase',
			auditLogReason,
			metadata: new Map([['phrase', data.phrase]]),
		});
	}

	async unbanPhrase(
		data: {
			phrase: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		await adminRepository.unbanPhrase(data.phrase);
		phraseBlocklistCache.remove(data.phrase);
		await cacheService.publish(BANNED_PHRASES_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'phrase',
			action: 'unban_phrase',
			auditLogReason,
			metadata: new Map([['phrase', data.phrase]]),
		});
	}

	async checkPhraseBan(data: {phrase: string}): Promise<{
		banned: boolean;
	}> {
		return {banned: phraseBlocklistCache.isPhraseBanned(data.phrase)};
	}

	async banUrl(
		data: {
			url: string;
			category?: string;
			severity?: number;
			source_url?: string;
			notes?: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		const canonical = canonicalizeUrl(data.url);
		if (!canonical) throw InputValidationError.fromCode('url', ValidationErrorCodes.INVALID_URL_FORMAT);
		await adminRepository.banUrl({
			url_canonical: canonical,
			category: data.category ?? ContentBlocklistCategory.MANUAL,
			severity: data.severity ?? ContentBlocklistSeverity.BLOCK,
			source_url: data.source_url ?? null,
			added_at: new Date(),
			added_by: adminUserId,
			notes: data.notes ?? null,
		});
		urlBlocklistCache.addExactUrl(canonical);
		await cacheService.publish(BANNED_URLS_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'url',
			action: 'ban_url',
			auditLogReason,
			metadata: new Map([
				['url', canonical],
				['category', data.category ?? ContentBlocklistCategory.MANUAL],
			]),
		});
	}

	async unbanUrl(
		data: {
			url: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		const canonical = canonicalizeUrl(data.url);
		if (!canonical) throw InputValidationError.fromCode('url', ValidationErrorCodes.INVALID_URL_FORMAT);
		await adminRepository.unbanUrl(canonical);
		urlBlocklistCache.removeExactUrl(canonical);
		await cacheService.publish(BANNED_URLS_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'url',
			action: 'unban_url',
			auditLogReason,
			metadata: new Map([['url', canonical]]),
		});
	}

	async checkUrlBan(data: {url: string}): Promise<{
		banned: boolean;
	}> {
		return {banned: urlBlocklistCache.isUrlBanned(data.url)};
	}

	async banUrlDomain(
		data: {
			domain: string;
			match_subdomains?: boolean;
			category?: string;
			severity?: number;
			source_url?: string;
			notes?: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		const entry = parseUrlDomainEntry(data.domain);
		if (!entry.ok) throw InputValidationError.create('domain', entry.message);
		const d = entry.value;
		const matchSubs = data.match_subdomains ?? true;
		await adminRepository.banUrlDomain({
			domain: d,
			match_subdomains: matchSubs,
			category: data.category ?? ContentBlocklistCategory.MANUAL,
			severity: data.severity ?? ContentBlocklistSeverity.BLOCK,
			source_url: data.source_url ?? null,
			added_at: new Date(),
			added_by: adminUserId,
			notes: data.notes ?? null,
		});
		urlBlocklistCache.addDomain(d, matchSubs);
		await cacheService.publish(BANNED_URL_DOMAINS_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'url_domain',
			action: 'ban_url_domain',
			auditLogReason,
			metadata: new Map([
				['domain', d],
				['match_subdomains', String(matchSubs)],
				['pattern', String(entry.pattern)],
			]),
		});
	}

	async unbanUrlDomain(
		data: {
			domain: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		const entry = parseUrlDomainEntry(data.domain);
		const d = entry.ok ? entry.value : data.domain.trim().toLowerCase();
		await adminRepository.unbanUrlDomain(d);
		urlBlocklistCache.removeDomain(d);
		await cacheService.publish(BANNED_URL_DOMAINS_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'url_domain',
			action: 'unban_url_domain',
			auditLogReason,
			metadata: new Map([['domain', d]]),
		});
	}

	async checkUrlDomainBan(data: {domain: string}): Promise<{
		banned: boolean;
	}> {
		const host = hostFromUrlOrHostname(data.domain);
		return {banned: host != null && urlBlocklistCache.isHostnameBanned(host)};
	}

	async banFileSha(
		data: {
			sha256_hex: string;
			category?: string;
			severity?: number;
			content_type?: string;
			source_url?: string;
			notes?: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
		options?: {deferRefresh?: boolean},
	) {
		const {adminRepository} = this.deps;
		const hex = data.sha256_hex.toLowerCase();
		await adminRepository.banFileSha({
			sha256_hex: hex,
			category: data.category ?? ContentBlocklistCategory.MANUAL,
			severity: data.severity ?? ContentBlocklistSeverity.BLOCK,
			content_type: data.content_type ?? null,
			source_url: data.source_url ?? null,
			added_at: new Date(),
			added_by: adminUserId,
			notes: data.notes ?? null,
		});
		fileShaCache.add(hex);
		if (!options?.deferRefresh) {
			await this.publishFileShaRefresh();
		}
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'file_sha',
			action: 'ban_file_sha',
			auditLogReason,
			metadata: new Map([['sha256', hex]]),
		});
	}

	async publishFileShaRefresh(): Promise<void> {
		const {cache: cacheService} = this.deps.apiContext.services;
		await cacheService.publish(BANNED_FILE_SHAS_REFRESH_CHANNEL, 'refresh');
	}

	async unbanFileSha(
		data: {
			sha256_hex: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		const hex = data.sha256_hex.toLowerCase();
		await adminRepository.unbanFileSha(hex);
		fileShaCache.remove(hex);
		await cacheService.publish(BANNED_FILE_SHAS_REFRESH_CHANNEL, 'refresh');
		await this.deps.auditService.createAuditLog({
			targetId: 0n,
			adminUserId,
			targetType: 'file_sha',
			action: 'unban_file_sha',
			auditLogReason,
			metadata: new Map([['sha256', hex]]),
		});
	}

	async checkFileShaBan(data: {sha256_hex: string}): Promise<{
		banned: boolean;
	}> {
		return {banned: fileShaCache.isBanned(data.sha256_hex)};
	}

	async banAvatarHash(
		data: {
			hashes: Array<string>;
			category?: string;
			severity?: number;
			source_url?: string;
			reason?: string;
			notes?: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		const normalized = normalizeAvatarHashes(data.hashes);
		for (const hash of normalized) {
			await adminRepository.banAvatarHash({
				hash_short: hash,
				category: data.category ?? ContentBlocklistCategory.MANUAL,
				severity: data.severity ?? ContentBlocklistSeverity.BLOCK,
				source_url: data.source_url ?? null,
				added_at: new Date(),
				added_by: adminUserId,
				notes: data.notes ?? null,
			});
			bannedAvatarHashCache.add(hash);
			await this.deps.auditService.createAuditLog({
				targetId: 0n,
				adminUserId,
				targetType: 'avatar_hash',
				action: 'ban_avatar_hash',
				auditLogReason,
				metadata: withReasonMetadata([['hash_short', hash]], data.reason),
			});
		}
		await cacheService.publish(BANNED_AVATAR_HASHES_REFRESH_CHANNEL, 'refresh');
	}

	async unbanAvatarHash(
		data: {
			hashes: Array<string>;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		const normalized = normalizeAvatarHashes(data.hashes);
		for (const hash of normalized) {
			await adminRepository.unbanAvatarHash(hash);
			bannedAvatarHashCache.remove(hash);
			await this.deps.auditService.createAuditLog({
				targetId: 0n,
				adminUserId,
				targetType: 'avatar_hash',
				action: 'unban_avatar_hash',
				auditLogReason,
				metadata: new Map([['hash_short', hash]]),
			});
		}
		await cacheService.publish(BANNED_AVATAR_HASHES_REFRESH_CHANNEL, 'refresh');
	}

	async checkAvatarHashBan(data: {hashes: Array<string>}): Promise<{
		banned: boolean;
	}> {
		for (const hash of data.hashes) {
			if (bannedAvatarHashCache.isBanned(stripAnimationPrefix(hash.toLowerCase()))) {
				return {banned: true};
			}
		}
		return {banned: false};
	}

	async banUserAvatar(
		data: {
			user_id: string;
			reason?: string;
			notes?: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	): Promise<{
		hash_short: string;
	}> {
		const {users: userRepository} = this.deps.apiContext.services;
		const userId = createUserID(BigInt(data.user_id));
		const user = await userRepository.findUnique(userId);
		if (!user) throw new UnknownUserError();
		const avatar = user.avatarHash;
		if (!avatar) {
			throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		}
		const hashShort = stripAnimationPrefix(avatar.toLowerCase());
		await this.banAvatarHash(
			{
				hashes: [hashShort],
				reason: data.reason,
				notes: data.notes ?? `banned via user shortcut user_id=${data.user_id}`,
			},
			adminUserId,
			auditLogReason,
		);
		return {hash_short: hashShort};
	}

	async banProfileSubstring(
		data: {
			scope: BannedProfileSubstringScope;
			substrings: Array<string>;
			reason?: string;
			notes?: string;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		for (const raw of data.substrings) {
			const canonical = canonicalizeStoredPhrase(raw);
			if (!canonical) continue;
			await adminRepository.banProfileSubstring({
				scope: data.scope,
				substring: canonical,
				added_at: new Date(),
				added_by: adminUserId,
				notes: data.notes ?? null,
			});
			profileSubstringBlocklistCache.add(data.scope, canonical);
			await this.deps.auditService.createAuditLog({
				targetId: 0n,
				adminUserId,
				targetType: 'profile_substring',
				action: 'ban_profile_substring',
				auditLogReason,
				metadata: withReasonMetadata(
					[
						['scope', data.scope],
						['substring', canonical],
					],
					data.reason,
				),
			});
		}
		await cacheService.publish(BANNED_PROFILE_SUBSTRINGS_REFRESH_CHANNEL, 'refresh');
	}

	async unbanProfileSubstring(
		data: {
			scope: BannedProfileSubstringScope;
			substrings: Array<string>;
		},
		adminUserId: UserID,
		auditLogReason: string | null,
	) {
		const {adminRepository} = this.deps;
		const {cache: cacheService} = this.deps.apiContext.services;
		for (const raw of data.substrings) {
			const canonical = canonicalizeStoredPhrase(raw);
			if (!canonical) continue;
			await adminRepository.unbanProfileSubstring(data.scope, canonical);
			profileSubstringBlocklistCache.remove(data.scope, canonical);
			await this.deps.auditService.createAuditLog({
				targetId: 0n,
				adminUserId,
				targetType: 'profile_substring',
				action: 'unban_profile_substring',
				auditLogReason,
				metadata: new Map([
					['scope', data.scope],
					['substring', canonical],
				]),
			});
		}
		await cacheService.publish(BANNED_PROFILE_SUBSTRINGS_REFRESH_CHANNEL, 'refresh');
	}

	async checkProfileSubstringBan(data: {scope: BannedProfileSubstringScope; substrings: Array<string>}): Promise<{
		banned: boolean;
	}> {
		for (const raw of data.substrings) {
			if (profileSubstringBlocklistCache.isSubstringBanned(data.scope, raw)) {
				return {banned: true};
			}
		}
		return {banned: false};
	}

	async listBlocklistEntries(params: {
		listType: AdminBlocklistListType;
		limit: number;
		after: string | null;
		scope: BannedProfileSubstringScope | null;
	}): Promise<AdminBlocklistEntryPage> {
		const entries = await this.loadBlocklistEntries(params.listType, params.scope);
		entries.sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
		const after = params.after;
		const remaining = after == null ? entries : entries.filter((entry) => entry.value > after);
		const page = remaining.slice(0, params.limit);
		const hasMore = remaining.length > page.length;
		const lastEntry = page.at(-1);
		return {
			items: page,
			has_more: hasMore,
			next_after: hasMore && lastEntry ? lastEntry.value : null,
		};
	}

	private async loadBlocklistEntries(
		listType: AdminBlocklistListType,
		scope: BannedProfileSubstringScope | null,
	): Promise<Array<AdminBlocklistEntry>> {
		const {adminRepository} = this.deps;
		switch (listType) {
			case 'ip': {
				const rows = await adminRepository.loadAllBannedIpEntries();
				return rows.map((row) =>
					createBlocklistEntry(listType, row.ip, {
						reason: row.reason,
						expires_at: toIsoString(row.expiresAt),
						created_at: toIsoString(row.createdAt),
					}),
				);
			}
			case 'email': {
				const rows = await adminRepository.loadAllBannedEmails();
				return rows.map((value) => createBlocklistEntry(listType, value));
			}
			case 'phrase': {
				const rows = await adminRepository.loadAllBannedPhrases();
				return rows.map((value) => createBlocklistEntry(listType, value));
			}
			case 'url': {
				const rows = await adminRepository.loadAllBannedUrls();
				return rows.map((row) =>
					createBlocklistEntry(listType, row.url_canonical, {
						category: row.category,
						severity: row.severity,
						source_url: row.source_url,
						notes: row.notes,
						created_at: toIsoString(row.added_at),
						created_by_user_id: toSnowflakeString(row.added_by),
					}),
				);
			}
			case 'url-domain': {
				const rows = await adminRepository.loadAllBannedUrlDomains();
				return rows.map((row) =>
					createBlocklistEntry(listType, row.domain, {
						category: row.category,
						severity: row.severity,
						source_url: row.source_url,
						notes: row.notes,
						match_subdomains: row.match_subdomains,
						created_at: toIsoString(row.added_at),
						created_by_user_id: toSnowflakeString(row.added_by),
					}),
				);
			}
			case 'file-sha': {
				const rows = await adminRepository.loadAllBannedFileShas();
				return rows.map((row) =>
					createBlocklistEntry(listType, row.sha256_hex, {
						category: row.category,
						severity: row.severity,
						source_url: row.source_url,
						notes: row.notes,
						content_type: row.content_type,
						created_at: toIsoString(row.added_at),
						created_by_user_id: toSnowflakeString(row.added_by),
					}),
				);
			}
			case 'avatar-hash': {
				const rows = await adminRepository.loadAllBannedAvatarHashes();
				return rows.map((row) =>
					createBlocklistEntry(listType, row.hash_short, {
						category: row.category,
						severity: row.severity,
						source_url: row.source_url,
						notes: row.notes,
						created_at: toIsoString(row.added_at),
						created_by_user_id: toSnowflakeString(row.added_by),
					}),
				);
			}
			case 'profile-substring': {
				const partitions: ReadonlyArray<BannedProfileSubstringScope> =
					scope == null ? ['username', 'global_name', 'nickname', 'bio', 'pronouns'] : [scope];
				const rows = (
					await Promise.all(
						partitions.map((scope) => fetchMany<BannedProfileSubstringRow>(readPartition.bind({scope}))),
					)
				).flat();
				return rows.map((row) =>
					createBlocklistEntry(listType, row.substring, {
						scope: row.scope,
						notes: row.notes,
						created_at: toIsoString(row.added_at),
						created_by_user_id: toSnowflakeString(row.added_by),
					}),
				);
			}
		}
	}
}

interface Reservation {
	generation: number;
	baseGeneration: number;
	baseRevision: number;
	baseHash: string | null;
	createdAt: string;
}
export interface UsernameDictionaryStorage {
	readPolicy(): Promise<{dictionary_gen: number; dictionary_hash: string | null; revision: number}>;
	reserve(): Promise<Reservation>;
	read(generation: number): Promise<UsernameDictionaryEntries>;
	write(generation: number, entries: UsernameDictionaryEntries): Promise<void>;
	publish(reservation: Reservation, hash: string): Promise<boolean>;
	delete(generation: number): Promise<void>;
}

const scopes: ReadonlyArray<UsernameDictionaryScope> = ['uname_exact', 'uname_contains', 'uname_allow'];
const readPartition = BannedProfileSubstrings.select({where: BannedProfileSubstrings.where.eq('scope')});
const deletePartition = BannedProfileSubstrings.delete({where: BannedProfileSubstrings.where.eq('scope')});

export class CassandraUsernameDictionaryStorage implements UsernameDictionaryStorage {
	constructor(private readonly config: InstanceConfigRepository) {}
	readPolicy() {
		return this.config.readUsernamePolicyConfig();
	}
	reserve() {
		return this.config.reserveUsernameDictionaryGeneration();
	}
	publish(reservation: Reservation, hash: string) {
		return this.config.publishUsernameDictionaryGeneration(reservation, hash);
	}
	async read(generation: number): Promise<UsernameDictionaryEntries> {
		const entries: Record<UsernameDictionaryScope, Array<string>> = {
			uname_exact: [],
			uname_contains: [],
			uname_allow: [],
		};
		if (generation === 0) return entries;
		for (const scope of scopes) {
			const rows = await fetchMany<BannedProfileSubstringRow>(readPartition.bind({scope: `${scope}:g${generation}`}));
			entries[scope] = rows.map((row) => row.substring);
		}
		return entries;
	}
	async write(generation: number, entries: UsernameDictionaryEntries): Promise<void> {
		for (const scope of scopes) {
			for (const substring of entries[scope]) {
				await upsertOne(
					BannedProfileSubstrings.insert({
						scope: `${scope}:g${generation}`,
						substring,
						added_at: new Date(),
						added_by: null,
						notes: null,
					}),
				);
			}
		}
	}
	async delete(generation: number): Promise<void> {
		for (const scope of scopes) await deleteOneOrMany(deletePartition.bind({scope: `${scope}:g${generation}`}));
	}
	async cleanupUsernameDictionaryGenerations(now = new Date()): Promise<number> {
		const day = now.toISOString().slice(0, 10);
		let state = await this.config.readUsernameDictionaryCleanupState();
		if (state && state.day > day) return 0;
		if (!state || state.day !== day) {
			const next = {day, cursor: 1};
			if (!(await this.config.compareAndSetUsernameDictionaryCleanupState(state, next))) return 0;
			state = next;
		}
		const policy = await this.config.readUsernamePolicyConfig();
		const candidates = new Set<number>();
		for (let generation = state.cursor; generation < policy.next_dictionary_gen; generation++) {
			if (generation === policy.dictionary_gen || generation === policy.previous_dictionary_gen) continue;
			const metadata = await this.config.readUsernameDictionaryGenerationMetadata(generation);
			if (metadata && new Date(metadata.created_at).getTime() < now.getTime() - 86_400_000) candidates.add(generation);
		}
		// Micup: fence old publisher revisions before deleting any staged generation.
		if (candidates.size && !(await this.config.fenceUsernameDictionaryGenerationCleanup(policy))) return 0;
		let deleted = 0;
		for (let generation = state.cursor; generation < policy.next_dictionary_gen; generation++) {
			if (candidates.has(generation)) {
				await this.delete(generation);
				deleted++;
			}
			const next = {day, cursor: generation + 1};
			if (!(await this.config.compareAndSetUsernameDictionaryCleanupState(state, next))) return deleted;
			state = next;
		}
		return deleted;
	}
}

export async function cleanupUsernameDictionaryGenerations(now?: Date): Promise<number> {
	return new CassandraUsernameDictionaryStorage(getInstanceConfigRepository()).cleanupUsernameDictionaryGenerations(
		now,
	);
}

export class UsernameDictionaryPublisher {
	constructor(private readonly storage: UsernameDictionaryStorage) {}
	async current() {
		const policy = await this.storage.readPolicy();
		const entries = await this.storage.read(policy.dictionary_gen);
		const manifest = computeUsernameDictionaryManifest(entries);
		if (policy.dictionary_gen > 0 && manifest.hash !== policy.dictionary_hash)
			throw new Error('Username dictionary hash mismatch');
		return {dictionary_gen: policy.dictionary_gen, ...manifest, entries};
	}
	async change(change: {scope: UsernameDictionaryScope; add: ReadonlyArray<string>; remove: ReadonlyArray<string>}) {
		for (let attempt = 0; attempt < 5; attempt++) {
			const reservation = await this.storage.reserve();
			let publishing = false;
			try {
				const base = await this.storage.read(reservation.baseGeneration);
				if (reservation.baseGeneration > 0 && computeUsernameDictionaryManifest(base).hash !== reservation.baseHash) {
					throw new Error('Username dictionary hash mismatch');
				}
				const removed = new Set(change.remove.map((entry) => entry.trim().toLowerCase()));
				const entries: Record<UsernameDictionaryScope, Array<string>> = {
					uname_exact: [],
					uname_contains: [],
					uname_allow: [],
				};
				for (const scope of scopes) {
					const values =
						scope === change.scope
							? [...base[scope].filter((entry) => !removed.has(entry)), ...change.add]
							: base[scope];
					entries[scope] = Array.from(new Set(values.map((entry) => entry.trim().toLowerCase()))).sort();
				}
				if (scopes.reduce((count, scope) => count + entries[scope].length, 0) > 20_000) {
					throw InputValidationError.create('add', 'Username dictionary exceeds 20000 entries');
				}
				const manifest = computeUsernameDictionaryManifest(entries);
				await this.storage.write(reservation.generation, entries);
				publishing = true;
				let applied: boolean;
				try {
					applied = await this.storage.publish(reservation, manifest.hash);
				} catch (error) {
					const policy = await this.storage.readPolicy();
					if (policy.dictionary_gen === reservation.generation && policy.dictionary_hash === manifest.hash) {
						return {dictionary_gen: reservation.generation, ...manifest, entries};
					}
					throw error;
				}
				if (applied) return {dictionary_gen: reservation.generation, ...manifest, entries};
				const policy = await this.storage.readPolicy();
				if (policy.dictionary_gen === reservation.generation) {
					if (policy.dictionary_hash !== manifest.hash) throw new Error('Username dictionary hash mismatch');
					return {dictionary_gen: reservation.generation, ...manifest, entries};
				}
				publishing = false;
			} catch (error) {
				if (!publishing) await this.storage.delete(reservation.generation);
				throw error;
			}
			await this.storage.delete(reservation.generation);
		}
		throw new ConflictError({
			code: APIErrorCodes.CONFLICT,
			message: 'Username dictionary publication raced with another update',
		});
	}
}
