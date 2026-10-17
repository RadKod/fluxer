// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, UserID} from '@app/api/BrandedTypes';
import type {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import type {ILiveKitService} from '@app/api/infrastructure/ILiveKitService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import type {VoiceActivityRepository} from '@app/api/voice_activity/VoiceActivityRepository';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {VOICE_ACTIVITY_METADATA_KEY} from '@fluxer/constants/src/VoiceActivityConstants';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {UserNotInVoiceError} from '@fluxer/errors/src/domains/user/UserNotInVoiceError';
import {VoiceActivityConflictError} from '@fluxer/errors/src/domains/voice/VoiceActivityConflictError';
import {resolveVoiceRoomAssignment} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import type {
	VoiceActivityId,
	VoiceActivitySession,
} from '@fluxer/schema/src/domains/voice_activity/VoiceActivitySchemas';

export interface VoiceActivityVoiceSeats {
	membership(p: {
		guildId: GuildID;
		channelId: ChannelID;
		userId: UserID;
		connectionId: string;
	}): Promise<{regionId: string; serverId: string} | null>;
}

export interface VoiceActivityServiceDeps {
	repository: VoiceActivityRepository;
	instanceConfigRepository: InstanceConfigRepository;
	channelAuthService: ChannelAuthService;
	voiceSeatService: VoiceActivityVoiceSeats;
	liveKitService: ILiveKitService;
	snowflakeService: ISnowflakeService;
}

interface MemberRef {
	userId: UserID;
	channelId: ChannelID;
	connectionId: string;
}

interface Room {
	guildId: GuildID;
	channelId: ChannelID;
	regionId: string;
	serverId: string;
}

// The KV key decides who holds the channel; the room metadata is how clients see it. Clients never write metadata.
export class VoiceActivityService {
	constructor(readonly deps: VoiceActivityServiceDeps) {}

	async get(p: MemberRef): Promise<VoiceActivitySession | null> {
		await this.requireMembership(p);
		return await this.deps.repository.load(String(p.channelId));
	}

	async start(p: MemberRef & {activityId: VoiceActivityId}): Promise<VoiceActivitySession> {
		const room = await this.requireMembership(p);
		const session: VoiceActivitySession = {
			activity_id: p.activityId,
			session_id: String(await this.deps.snowflakeService.generate()),
			started_by: String(p.userId),
			started_at: Date.now(),
		};
		const channelId = String(p.channelId);
		if (!(await this.deps.repository.create(channelId, session))) throw new VoiceActivityConflictError();
		if ((await this.writeMetadata(room, session)) !== 'ok') {
			await this.deps.repository.delete(channelId);
			throw new ServiceUnavailableError();
		}
		return session;
	}

	// Any member may end it. The metadata goes first so a start racing this one meets the still-held key, and a key
	// that already expired still gets its leftover metadata cleared.
	async end(p: MemberRef): Promise<void> {
		const room = await this.requireMembership(p);
		const written = await this.writeMetadata(room, null);
		await this.deps.repository.delete(String(p.channelId));
		if (written === 'error') throw new ServiceUnavailableError();
	}

	// The room and its metadata are gone with it; only the key is left.
	async onRoomFinished(channelId: ChannelID): Promise<void> {
		await this.deps.repository.delete(String(channelId));
	}

	private async writeMetadata(room: Room, session: VoiceActivitySession | null): Promise<'ok' | 'not_found' | 'error'> {
		return await this.deps.liveKitService.updateRoomMetadata({
			...room,
			entries: {[VOICE_ACTIVITY_METADATA_KEY]: session},
		});
	}

	// Same gate as table games plus the guild feature: the switch, VIEW_CHANNEL (inside getChannelAuthenticated), a guild voice channel,
	// CONNECT, then the caller's own connection through the seat hash.
	private async requireMembership(p: MemberRef): Promise<Room> {
		if (!resolveVoiceRoomAssignment(await this.deps.instanceConfigRepository.getVoiceRoomConfig()).games) {
			throw new FeatureTemporarilyDisabledError();
		}
		const auth = await this.deps.channelAuthService.getChannelAuthenticated({
			viewer: {kind: 'user', userId: p.userId, bot: false, capable: false},
			userId: p.userId,
			channelId: p.channelId,
		});
		if (auth.channel.type !== ChannelTypes.GUILD_VOICE) throw new InvalidChannelTypeError();
		// Activities are per guild: only where an admin set VOICE_ACTIVITIES.
		if (!auth.guild?.features.includes(GuildFeatures.VOICE_ACTIVITIES)) throw new FeatureTemporarilyDisabledError();
		await auth.checkPermission(Permissions.CONNECT);
		const guildId = auth.channel.guildId;
		if (guildId === null) throw new UserNotInVoiceError();
		const member = await this.deps.voiceSeatService.membership({
			guildId,
			channelId: p.channelId,
			userId: p.userId,
			connectionId: p.connectionId,
		});
		if (member === null) throw new UserNotInVoiceError();
		return {guildId, channelId: p.channelId, regionId: member.regionId, serverId: member.serverId};
	}
}
