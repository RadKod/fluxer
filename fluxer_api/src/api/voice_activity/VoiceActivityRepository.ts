// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ACTIVITY_SESSION_TTL_MS} from '@fluxer/constants/src/VoiceActivityConstants';
import {VoiceActivitySession} from '@fluxer/schema/src/domains/voice_activity/VoiceActivitySchemas';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const VOICE_ACTIVITY_SESSION_TTL_S = Math.ceil(VOICE_ACTIVITY_SESSION_TTL_MS / 1000);

const sessionKey = (channelId: string) => `{voice_activity:${channelId}}`;

// One running session per voice channel; the key's TTL is what expires a session nobody ended.
export class VoiceActivityRepository {
	constructor(private readonly kv: IKVProvider) {}

	async load(channelId: string): Promise<VoiceActivitySession | null> {
		const raw = await this.kv.get(sessionKey(channelId));
		if (raw === null) return null;
		try {
			const parsed = VoiceActivitySession.safeParse(JSON.parse(raw));
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}

	// false: another session holds the channel.
	async create(channelId: string, session: VoiceActivitySession): Promise<boolean> {
		return await this.kv.setnx(sessionKey(channelId), JSON.stringify(session), VOICE_ACTIVITY_SESSION_TTL_S);
	}

	async delete(channelId: string): Promise<void> {
		await this.kv.del(sessionKey(channelId));
	}
}
