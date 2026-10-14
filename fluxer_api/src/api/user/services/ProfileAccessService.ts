// SPDX-License-Identifier: AGPL-3.0-or-later
// the one profile access rule. Every caller — the profile and its popup, follow and the follow lists,
// the post routes, the home feed's author verdict and Keşfet — asks here.

import type {UserID} from '@app/api/BrandedTypes';
import {hasStrangerFollowStanding, PUBLIC_HIDDEN_AUTHOR_FLAGS} from '@app/api/feed/discover/FeedDiscoverRules';
import {feedDayAt} from '@app/api/feed/FeedRepository';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {ProfileAccessCache} from '@app/api/user/profile/ProfileAccessCache';
import {
	decideProfileView,
	type ProfileAccessResult,
	type ProfileBond,
	type ProfileViewer,
} from '@app/api/user/profile/ProfileAccessRules';
import {type ProfileAudience, resolveProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {RelationshipTypes, UserFlags} from '@fluxer/constants/src/UserConstants';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';

/** The owner's half of every decision: one per owner, whoever views (A1 keeps it 60 s in KV). */
export interface ProfileSide {
	exists: boolean;
	bot: boolean;
	audience: ProfileAudience;
	feedHidden: boolean;
	publicHidden: boolean;
	spammer: boolean;
	guildIds: Array<string>; // empty for a bot: it is open to all
}

/** What ties a viewer to an owner, read on the viewer's partitions (A1 keeps it 60 s in KV). */
export interface Relation {
	bond: ProfileBond;
	blocked: boolean;
	friend: boolean;
	sharedGuild: boolean;
}

export interface ProfileAccessServiceDeps {
	users: Pick<UserRepository, 'findUnique' | 'getUserGuildIds'>;
	settings: Pick<UserRepository, 'findSettings'>;
	relationships: Pick<UserRepository, 'getRelationship' | 'getIncomingRelationship'>;
	channels: Pick<UserRepository, 'listPrivateChannels'>;
	follows: {
		getFollow(userId: UserID, targetId: UserID): Promise<unknown | null>;
		isFollowingCached(userId: UserID, targetId: UserID): Promise<boolean>;
	};
	cache?: ProfileAccessCache; // the 60 s KV records; without it every decision reads the partitions
}

export const MISSING_SIDE: ProfileSide = {
	exists: false,
	bot: false,
	audience: 'only_me',
	feedHidden: false,
	publicHidden: false,
	spammer: false,
	guildIds: [],
};

// The viewer's own partitions a request reads once, however many owners it judges.
interface ViewerSide {
	guildIds: () => Promise<Set<string>>;
	groupDms: () => Promise<Array<{type: number; recipientIds: Set<UserID>}>>;
}
const viewerSides = new WeakMap<RequestCache, Map<UserID, ViewerSide>>();

function sharesGuild(side: ProfileSide, viewerGuilds: Set<string>): boolean {
	return side.guildIds.some((id) => viewerGuilds.has(id));
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => (pending ??= load());
}

export class ProfileAccessService {
	constructor(protected readonly deps: ProfileAccessServiceDeps) {}

	/** Throws UnknownUserError (404) for a missing owner; a refusal is view: null. Without a viewer, no stranger path. */
	async resolve(
		viewerId: UserID,
		targetId: UserID,
		viewer?: ProfileViewer,
		requestCache?: RequestCache,
	): Promise<ProfileAccessResult> {
		const side = await this.loadSide(targetId);
		if (!side.exists) throw new UnknownUserError();
		const base = {
			audience: side.audience,
			feedHidden: side.feedHidden,
			publicHidden: side.publicHidden,
			spammer: side.spammer,
		};
		if (viewerId === targetId) return {...base, view: 'full', blocked: false, friend: true, sharedGuild: true};
		const relation = await this.loadRelation(viewerId, targetId, side, this.viewerSide(viewerId, requestCache));
		// The cheap checks first: the daily stranger budget is spent only by a view it can open.
		const strangerOk =
			(relation.bond === 'none' || relation.bond === 'weak') &&
			!relation.blocked &&
			side.audience === 'everyone' &&
			!side.publicHidden &&
			!side.spammer &&
			viewer?.human === true &&
			hasStrangerFollowStanding(viewer.user, Date.now()) &&
			(!viewer.countStranger || (await this.allowStranger(viewer, targetId)));
		const view = decideProfileView({
			audience: side.audience,
			bond: relation.bond,
			blocked: relation.blocked,
			bot: side.bot,
			strangerOk,
		});
		return {...base, view, blocked: relation.blocked, friend: relation.friend, sharedGuild: relation.sharedGuild};
	}

	// a day's distinct stranger profiles per account, counted only on the profile,
	// follow list and post list routes (ProfileViewer.countStranger); a target already opened today is free.
	// TEMPORARY: a plain daily set, not a scraping model. Path: feed the count to the account risk service
	// (AccountPolicyEvaluator). Trigger: more than 100 accounts a day reach the cap, or a scraping report.
	protected async allowStranger(viewer: ProfileViewer, targetId: UserID): Promise<boolean> {
		if (!this.deps.cache) return true;
		const allowed = await this.deps.cache.allowStranger(viewer.user.id, targetId, feedDayAt(Date.now()));
		if (!allowed) Logger.info({viewerId: viewer.user.id.toString()}, 'Stranger profile daily cap reached');
		return allowed;
	}

	async sideOf(targetId: UserID): Promise<ProfileSide> {
		return this.loadSide(targetId);
	}

	/**
	 * The owner side and a block either way, without the bond class: a public post's gate needs no more, so it
	 * reads no friendship, follow, pending request or private channel. The block comes from the pair record when it is
	 * cached (a block forgets it), else from the two block reads; nothing is written. Throws UnknownUserError (404).
	 */
	async sideAndBlock(viewerId: UserID, targetId: UserID): Promise<{side: ProfileSide; blocked: boolean}> {
		const side = await this.loadSide(targetId);
		if (!side.exists) throw new UnknownUserError();
		const cached = await this.deps.cache?.readRelation(viewerId, targetId);
		if (cached?.state === 'hit') return {side, blocked: cached.value.blocked};
		const [out, inbound] = await Promise.all([
			this.deps.relationships.getRelationship(viewerId, targetId, RelationshipTypes.BLOCKED),
			this.deps.relationships.getIncomingRelationship(viewerId, targetId, RelationshipTypes.BLOCKED),
		]);
		return {side, blocked: out !== null || inbound !== null};
	}

	async audienceOf(targetId: UserID): Promise<ProfileAudience | null> {
		const side = await this.loadSide(targetId);
		return side.exists ? side.audience : null;
	}

	protected async loadSide(targetId: UserID): Promise<ProfileSide> {
		const {cache} = this.deps;
		if (!cache) return this.readSide(targetId);
		const cached = await cache.readSide(targetId);
		if (cached.state === 'hit') return cached.value;
		const side = await this.readSide(targetId);
		await cache.writeSide(targetId, side, cached);
		return side;
	}

	// A record computed under another level is recomputed: its bond class may differ (the guilds level never asks
	// for a mutual follow). So is one whose shared guild the two side records no longer agree with: a guild joined or
	// left drops only the member's side record. A recompute replaces only the record it read, never a newer forget.
	protected async loadRelation(
		viewerId: UserID,
		targetId: UserID,
		side: ProfileSide,
		viewerSide: ViewerSide,
	): Promise<Relation> {
		const {cache} = this.deps;
		if (!cache) return this.readRelation(viewerId, targetId, side, viewerSide);
		const cached = await cache.readRelation(viewerId, targetId);
		if (
			cached.state === 'hit' &&
			cached.value.audience === side.audience &&
			cached.value.sharedGuild === sharesGuild(side, await viewerSide.guildIds())
		) {
			return cached.value;
		}
		const relation = await this.readRelation(viewerId, targetId, side, viewerSide);
		await cache.writeRelation(viewerId, targetId, {...relation, audience: side.audience}, cached);
		return relation;
	}

	private async readSide(targetId: UserID): Promise<ProfileSide> {
		const user = await this.deps.users.findUnique(targetId);
		if (!user) return MISSING_SIDE;
		const [settings, guildIds] = await Promise.all([
			this.deps.settings.findSettings(targetId),
			user.isBot ? Promise.resolve([]) : this.deps.users.getUserGuildIds(targetId), // a bot is open to all
		]);
		return {
			exists: true,
			bot: user.isBot,
			audience: resolveProfileAudience(settings?.profilePrivacy, user.dateOfBirth),
			feedHidden: (user.flags & (UserFlags.DISABLED | UserFlags.DELETED)) !== 0n,
			publicHidden: (user.flags & PUBLIC_HIDDEN_AUTHOR_FLAGS) !== 0n,
			spammer: (user.flags & UserFlags.SPAMMER) !== 0n,
			guildIds: guildIds.map(String),
		};
	}

	// Everything on the viewer's partitions; only the mutual follow check touches the target, and through the KV set.
	private async readRelation(
		viewerId: UserID,
		targetId: UserID,
		side: ProfileSide,
		viewerSide: ViewerSide,
	): Promise<Relation> {
		const {relationships} = this.deps;
		const [out, inbound, friendship, viewerGuilds] = await Promise.all([
			relationships.getRelationship(viewerId, targetId, RelationshipTypes.BLOCKED),
			relationships.getIncomingRelationship(viewerId, targetId, RelationshipTypes.BLOCKED),
			relationships.getRelationship(viewerId, targetId, RelationshipTypes.FRIEND),
			viewerSide.guildIds(),
		]);
		const blocked = out !== null || inbound !== null;
		const friend = friendship !== null;
		const sharedGuild = sharesGuild(side, viewerGuilds);
		const bond = await this.bond(viewerId, targetId, side, {blocked, friend, sharedGuild}, viewerSide);
		return {blocked, friend, sharedGuild, bond};
	}

	// Under a block, everyone or only_me any bond decides alike beyond weak-or-not; guilds and close need the class.
	private async bond(
		viewerId: UserID,
		targetId: UserID,
		side: ProfileSide,
		known: {blocked: boolean; friend: boolean; sharedGuild: boolean},
		viewerSide: ViewerSide,
	): Promise<ProfileBond> {
		if (known.friend) return 'close';
		const exact = !known.blocked && side.audience === 'close';
		if (known.sharedGuild && !exact) return 'guild';
		if (await this.mutualFollow(viewerId, targetId)) return 'close';
		if (known.sharedGuild) return 'guild';
		return (await this.weakBond(viewerId, targetId, viewerSide)) ? 'weak' : 'none';
	}

	/** Viewer follows target (the viewer's partition), then target follows viewer (the target's 60 s KV set). */
	protected async mutualFollow(viewerId: UserID, targetId: UserID): Promise<boolean> {
		if (!(await this.deps.follows.getFollow(viewerId, targetId))) return false;
		return this.deps.follows.isFollowingCached(targetId, viewerId);
	}

	/** A pending friend request either way (the viewer's partition) or a group DM both are in. */
	private async weakBond(viewerId: UserID, targetId: UserID, viewerSide: ViewerSide): Promise<boolean> {
		const {relationships} = this.deps;
		const [incoming, outgoing] = await Promise.all([
			relationships.getRelationship(viewerId, targetId, RelationshipTypes.INCOMING_REQUEST),
			relationships.getRelationship(viewerId, targetId, RelationshipTypes.OUTGOING_REQUEST),
		]);
		if (incoming !== null || outgoing !== null) return true;
		return (await viewerSide.groupDms()).some(
			(channel) => channel.type === ChannelTypes.GROUP_DM && channel.recipientIds.has(targetId),
		);
	}

	private viewerSide(viewerId: UserID, requestCache?: RequestCache): ViewerSide {
		if (!requestCache) return this.readViewerSide(viewerId);
		let sides = viewerSides.get(requestCache);
		if (!sides) viewerSides.set(requestCache, (sides = new Map()));
		let side = sides.get(viewerId);
		if (!side) sides.set(viewerId, (side = this.readViewerSide(viewerId)));
		return side;
	}

	private readViewerSide(viewerId: UserID): ViewerSide {
		return {
			guildIds: once(async () => {
				// With the cache, from the viewer's own 60 s side record (a bot's holds none: its partition is read).
				if (this.deps.cache) {
					const side = await this.loadSide(viewerId);
					if (side.exists && !side.bot) return new Set(side.guildIds);
				}
				return new Set((await this.deps.users.getUserGuildIds(viewerId)).map(String));
			}),
			groupDms: once(() => this.deps.channels.listPrivateChannels(viewerId)),
		};
	}
}
