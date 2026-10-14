// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import type {IConnectionRepository} from '@app/api/connection/IConnectionRepository';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import type {GuildService} from '@app/api/guild/services/GuildService';
import type {IDiscriminatorService} from '@app/api/infrastructure/DiscriminatorService';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getBadgeRepository, getBadgeService, getProfileAccessCache} from '@app/api/middleware/ServiceSingletons';
import type {GuildMember} from '@app/api/models/GuildMember';
import type {User} from '@app/api/models/User';
import {isProfileHidden} from '@app/api/user/ProfileVisibility';
import type {ProfileAccessResult, ProfileView, ProfileViewer} from '@app/api/user/profile/ProfileAccessRules';
import type {ProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import {
	buildProfileView,
	type CachedProfileView,
	decodeProfileView,
	encodeProfileView,
	type ProfileViewConnection,
	projectedUser,
} from '@app/api/user/profile/ProfileViewProjection';
import type {IUserAccountRepository} from '@app/api/user/repositories/IUserAccountRepository';
import type {IUserRelationshipRepository} from '@app/api/user/repositories/IUserRelationshipRepository';
import type {ProfileAccessService, ProfileSide} from '@app/api/user/services/ProfileAccessService';
import {checkUsernameClaimAvailability, isUsernameTaken, readUsernameMigration} from '@app/api/user/UniqueUsernames';
import {hasFixedDiscriminator} from '@app/api/user/UserTag';
import {
	PremiumFlags,
	ProfileFieldPrivacyFlags,
	RelationshipTypes,
	type UserPremiumType,
	UserPremiumTypes,
} from '@fluxer/constants/src/UserConstants';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';

interface ProfileFieldPrivacyContext {
	isOwner: boolean;
	isFriend: boolean;
	hasMutualGuild: boolean;
}

interface UserAccountLookupServiceDeps {
	userAccountRepository: IUserAccountRepository;
	userRelationshipRepository: IUserRelationshipRepository;
	guildRepository: IGuildRepositoryAggregate;
	guildService: GuildService;
	discriminatorService: IDiscriminatorService;
	connectionRepository: IConnectionRepository;
	profileAccess: ProfileAccessService;
}

interface ProfileAccessParams {
	userId: UserID;
	targetId: UserID;
	viewer?: ProfileViewer;
	requestCache?: RequestCache;
}

export class UserAccountLookupService {
	constructor(private readonly deps: UserAccountLookupServiceDeps) {}

	async findUnique(userId: UserID): Promise<User | null> {
		return await this.deps.userAccountRepository.findUnique(userId);
	}

	async findUniqueAssert(userId: UserID): Promise<User> {
		return await this.deps.userAccountRepository.findUniqueAssert(userId);
	}

	/** the one profile access rule. Throws UnknownUserError (404); a refusal is view: null. */
	async resolveProfileAccess(params: ProfileAccessParams): Promise<ProfileAccessResult> {
		return this.deps.profileAccess.resolve(params.userId, params.targetId, params.viewer, params.requestCache);
	}

	/**
	 * The profile access rule alone (the first step of getUserProfile): throws MissingAccessError (403) when the viewer
	 * may not see the target and tells whether the profile is restricted, without reading the profile fields or the
	 * owner's users row (the owner side answers). Follow routes and the post routes use it.
	 */
	async getProfileAccess(
		params: ProfileAccessParams,
	): Promise<ProfileAccessResult & {view: ProfileView; restrictProfile: boolean}> {
		const access = await this.resolveProfileAccess(params);
		if (access.view === null) throw new MissingAccessError();
		return {...access, view: access.view, restrictProfile: access.view === 'limited'};
	}

	/** A public post's gate: the owner side and a block either way, without the bond. Throws UnknownUserError. */
	async resolvePublicPostAccess(params: {
		userId: UserID;
		targetId: UserID;
	}): Promise<{side: ProfileSide; blocked: boolean}> {
		return this.deps.profileAccess.sideAndBlock(params.userId, params.targetId);
	}

	/** The owner's effective level from the owner side (Keşfet, the home feed filter); null when the account is gone. */
	async getProfileAudience(targetId: UserID): Promise<ProfileAudience | null> {
		return this.deps.profileAccess.audienceOf(targetId);
	}

	async getUserProfile(params: {
		userId: UserID;
		targetId: UserID;
		guildId?: GuildID;
		withMutualFriends?: boolean;
		withMutualGuilds?: boolean;
		viewer?: ProfileViewer;
		requestCache: RequestCache;
	}): Promise<{
		user: User;
		guildMember?: GuildMemberResponse | null;
		guildMemberDomain?: GuildMember | null;
		premiumType?: UserPremiumType;
		premiumSince?: Date;
		premiumLifetimeSequence?: number;
		mutualFriends?: Array<User>;
		mutualGuilds?: Array<{
			id: string;
			nick: string | null;
		}>;
		connections?: Array<ProfileViewConnection>;
		badges: Array<BadgeResponse>;
		timezoneVisible: boolean;
		restrictProfile: boolean;
	}> {
		const {userId, targetId, guildId, withMutualFriends, withMutualGuilds, viewer, requestCache} = params;
		const access = await this.getProfileAccess({userId, targetId, viewer, requestCache});
		// Micup the owner as the cached view sees it; a lapsed premium is mended from the real row by the caller.
		const view = await this.loadProfileView(targetId);
		const user = projectedUser(view);
		const hidden = isProfileHidden(user);
		const restrictProfile = access.restrictProfile || hidden;
		let guildMember: GuildMemberResponse | null = null;
		let guildMemberDomain: GuildMember | null = null;
		if (guildId != null) {
			const viewerMember = await this.deps.guildRepository.getMember(guildId, userId);
			if (viewerMember) {
				guildMemberDomain = await this.deps.guildRepository.getMember(guildId, targetId);
				if (guildMemberDomain) {
					guildMember = await this.deps.guildService.members.getMember({
						userId,
						targetId,
						guildId,
						requestCache,
					});
				}
			}
		}
		let premiumType = user.premiumType ?? undefined;
		let premiumSince = user.premiumSince ?? undefined;
		let premiumLifetimeSequence = user.premiumLifetimeSequence ?? undefined;
		if (restrictProfile || user.premiumFlags & PremiumFlags.BADGE_HIDDEN) {
			premiumType = undefined;
			premiumSince = undefined;
			premiumLifetimeSequence = undefined;
		} else {
			if (user.premiumType === UserPremiumTypes.LIFETIME) {
				if (user.premiumFlags & PremiumFlags.BADGE_MASKED) {
					premiumType = UserPremiumTypes.SUBSCRIPTION;
				}
				if (user.premiumFlags & PremiumFlags.BADGE_SEQUENCE_HIDDEN) {
					premiumLifetimeSequence = undefined;
				}
			}
			if (user.premiumFlags & PremiumFlags.BADGE_TIMESTAMP_HIDDEN) {
				premiumSince = undefined;
			}
		}
		// Micup: the field privacy context comes with the access decision, no more reads.
		const profileFieldPrivacyContext: ProfileFieldPrivacyContext | null = restrictProfile
			? null
			: {isOwner: userId === targetId, isFriend: access.friend, hasMutualGuild: access.sharedGuild};
		// the mutual lists only on the full view.
		const withMutuals = !hidden && access.view === 'full' && userId !== targetId;
		const timezoneVisible =
			!restrictProfile &&
			user.timezone != null &&
			profileFieldPrivacyContext != null &&
			this.canViewProfileField(user.timezonePrivacyFlags, profileFieldPrivacyContext);
		const [mutualFriends, mutualGuilds] = await Promise.all([
			withMutualFriends && withMutuals ? this.getMutualFriends(userId, targetId) : undefined,
			withMutualGuilds && withMutuals ? this.getMutualGuilds(userId, targetId) : undefined,
		]);
		const connections =
			restrictProfile || profileFieldPrivacyContext == null
				? []
				: view.connections.filter((connection) =>
						this.canViewProfileField(connection.visibility_flags, profileFieldPrivacyContext),
					);
		return {
			user,
			guildMember,
			guildMemberDomain,
			premiumType,
			premiumSince,
			premiumLifetimeSequence,
			mutualFriends,
			mutualGuilds,
			connections,
			badges: restrictProfile ? [] : await getBadgeService().toProfileBadges(view.badges),
			timezoneVisible,
			restrictProfile,
		};
	}

	// the owner's users row, verified connections and badges are read only when the 60 s
	// view is missing, so however many viewers open a profile its partitions are read about once a minute.
	private async loadProfileView(targetId: UserID): Promise<CachedProfileView> {
		const cache = getProfileAccessCache();
		const cached = await cache.readView(targetId);
		if (cached.state === 'hit') return decodeProfileView(cached.value);
		const [user, connections, badges] = await Promise.all([
			this.deps.userAccountRepository.findUnique(targetId),
			this.deps.connectionRepository.findByUserId(targetId),
			getBadgeRepository().listUserBadges(targetId),
		]);
		if (!user) throw new UnknownUserError();
		const view = buildProfileView(user, connections, badges);
		await cache.writeView(targetId, encodeProfileView(view), cached);
		return view;
	}

	// TEMPORARY: mutual friends read the owner's relationships partition. It runs only when a client asks
	// (the full page asks when About opens; the modal and popup still ask on open, as upstream) and only on the full view,
	// so strangers never cause it. Path: a 60 s KV set of the owner's friend IDs (built from this read, dropped on the
	// owner's relationship changes) and SISMEMBER over the viewer's friends. Trigger: more than 5 K reads/s on one
	// relationships partition, or with_mutual_friends on more than 20 % of profile requests.
	private async getMutualFriends(userId: UserID, targetId: UserID): Promise<Array<User>> {
		const [userRelationships, targetRelationships] = await Promise.all([
			this.deps.userRelationshipRepository.listRelationships(userId),
			this.deps.userRelationshipRepository.listRelationships(targetId),
		]);
		const userFriendIds = new Set(
			userRelationships
				.filter((rel) => rel.type === RelationshipTypes.FRIEND)
				.map((rel) => rel.targetUserId.toString()),
		);
		const mutualFriendIds = targetRelationships
			.filter((rel) => rel.type === RelationshipTypes.FRIEND && userFriendIds.has(rel.targetUserId.toString()))
			.map((rel) => rel.targetUserId);
		if (mutualFriendIds.length === 0) {
			return [];
		}
		const users = await this.deps.userAccountRepository.listUsers(mutualFriendIds);
		return users.sort((a, b) => this.compareUsersByIdDesc(a, b));
	}

	private compareUsersByIdDesc(a: User, b: User): number {
		if (b.id > a.id) return 1;
		if (b.id < a.id) return -1;
		return 0;
	}

	private async getMutualGuilds(
		userId: UserID,
		targetId: UserID,
	): Promise<
		Array<{
			id: string;
			nick: string | null;
		}>
	> {
		// Micup: the owner's communities from the owner side (A1 caches it), not the owner's user_guilds partition; a bot's
		// side keeps none (it may be in thousands), so a bot profile reads them as upstream does.
		const [userGuildIds, side] = await Promise.all([
			this.deps.userAccountRepository.getUserGuildIds(userId),
			this.deps.profileAccess.sideOf(targetId),
		]);
		const targetGuildIds = side.bot
			? await this.deps.userAccountRepository.getUserGuildIds(targetId)
			: side.guildIds.map((id) => createGuildID(BigInt(id)));
		const userGuildIdSet = new Set(userGuildIds.map((id) => id.toString()));
		const mutualGuildIds = targetGuildIds.filter((id) => userGuildIdSet.has(id.toString()));
		if (mutualGuildIds.length === 0) {
			return [];
		}
		const memberPromises = mutualGuildIds.map((guildId) => this.deps.guildRepository.getMember(guildId, targetId));
		const members = await Promise.all(memberPromises);
		return mutualGuildIds.map((guildId, index) => ({
			id: guildId.toString(),
			nick: members[index]?.nickname ?? null,
		}));
	}

	async checkUsernameDiscriminatorAvailability(params: {
		username: string;
		discriminator?: number;
		currentUser: User;
		includePrivateStatus?: boolean;
	}): Promise<{taken: boolean; reason?: string | null; available_at?: string | null}> {
		const {username, discriminator, currentUser} = params;
		const migration = await readUsernameMigration();
		if (migration.state !== 'legacy')
			return checkUsernameClaimAvailability(username, params.includePrivateStatus === false ? null : currentUser.id);
		if (discriminator === undefined) throw InputValidationError.create('discriminator', 'This field is required');
		if (currentUser.username.toLowerCase() === username.toLowerCase() && currentUser.discriminator === discriminator)
			return {taken: false};
		if (hasFixedDiscriminator(currentUser)) {
			return {taken: await isUsernameTaken(this.deps.userAccountRepository, username, currentUser.id)};
		}
		const isAvailable = await this.deps.discriminatorService.isDiscriminatorAvailableForUsername(
			username,
			discriminator,
		);
		return {taken: !isAvailable};
	}

	private canViewProfileField(flags: number, privacyContext: ProfileFieldPrivacyContext): boolean {
		if (privacyContext.isOwner) {
			return flags !== 0;
		}
		if (flags & ProfileFieldPrivacyFlags.EVERYONE) {
			return true;
		}
		if (flags & ProfileFieldPrivacyFlags.FRIENDS && privacyContext.isFriend) {
			return true;
		}
		if (flags & ProfileFieldPrivacyFlags.MUTUAL_GUILDS && privacyContext.hasMutualGuild) {
			return true;
		}
		return false;
	}
}
