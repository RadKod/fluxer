// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelID,
	createChannelID,
	createEmojiID,
	createMessageID,
	type EmojiID,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import type {IChannelRepository} from '@app/api/channel/IChannelRepository';
import type {IMessageInteractionRepository} from '@app/api/channel/repositories/IMessageInteractionRepository';
import {
	type CounterFlusher,
	counterDirtyKey,
	counterKey,
	counterPartition,
} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {MAX_USERS_PER_MESSAGE_REACTION} from '@fluxer/constants/src/LimitConstants';

export const MESSAGE_REACTION_USERS_COUNTER = 'message_reaction_users';
const REACTION_USER_SAMPLE_SIZE = 100;

export function messageReactionUserCounterId(
	channelId: ChannelID,
	messageId: MessageID,
	emojiName: string,
	emojiId?: EmojiID,
): string {
	return `${channelId}:${messageId}:${emojiId ?? 0n}:${emojiName}`;
}

export function createMessageReactionUserCounterFlusher(
	channelRepository: Pick<IChannelRepository, 'countReactionUsersUpTo'>,
): CounterFlusher {
	const readBase = (id: string) => {
		const [channelId, messageId, emojiId, ...name] = id.split(':');
		return channelRepository.countReactionUsersUpTo(
			createChannelID(BigInt(channelId)),
			createMessageID(BigInt(messageId)),
			name.join(':'),
			emojiId === '0' ? undefined : createEmojiID(BigInt(emojiId)),
			MAX_USERS_PER_MESSAGE_REACTION + 1,
		);
	};
	return {
		namespace: MESSAGE_REACTION_USERS_COUNTER,
		readBase,
		// Cassandra reaction rows are authoritative; the shared flush only gives this cache a 24-hour TTL.
		async flush() {},
		recount: readBase,
	};
}

async function adjustExistingCounter(id: string, delta: number): Promise<void> {
	try {
		// The no-base primitive changes only an existing key, atomically. KVCounterService.add could seed
		// synchronously if a key expired between an existence check and the write.
		await getKVClient().counterAdd(
			counterKey(MESSAGE_REACTION_USERS_COUNTER, id),
			counterDirtyKey(counterPartition(MESSAGE_REACTION_USERS_COUNTER, id)),
			`${MESSAGE_REACTION_USERS_COUNTER}:${id}`,
			delta,
			null,
		);
	} catch (error) {
		Logger.warn({error, id}, 'Failed to update a message reaction user counter');
	}
}

export async function getMessageReactionCount(
	repository: IMessageInteractionRepository,
	channelId: ChannelID,
	messageId: MessageID,
	emojiName: string,
	emojiId?: EmojiID,
): Promise<{reactionCount: number; count: number | null; increment: () => Promise<void>}> {
	const sample = await repository.countReactionUsersUpTo(
		channelId,
		messageId,
		emojiName,
		emojiId,
		REACTION_USER_SAMPLE_SIZE,
	);
	const id = messageReactionUserCounterId(channelId, messageId, emojiName, emojiId);
	let count: number | null = sample;
	let counterPresent = false;
	if (sample >= REACTION_USER_SAMPLE_SIZE) {
		count = null;
		try {
			const kv = getKVClient();
			const raw = await kv.get(counterKey(MESSAGE_REACTION_USERS_COUNTER, id));
			if (raw !== null) {
				const value = Number(raw);
				if (!Number.isSafeInteger(value) || raw.trim() === '') throw new Error('Invalid reaction user count');
				count = Math.max(sample, value);
				counterPresent = true;
			} else if (await kv.setnx(`counter:seed:${id}`, '1', 60)) {
				// TEMPORARY: no cap check while the background seed is missing (60-second retry lease).
				// Relevant near the cap; if seeding exceeds the lease or partitions exceed 100 MB,
				// move role panels to buttons. Never wait for the base read here.
				void getKVCounterService()
					.add(MESSAGE_REACTION_USERS_COUNTER, id, 0)
					.catch((error: unknown) => {
						Logger.warn({error, id}, 'Failed to seed a message reaction user counter');
					});
			}
		} catch (error) {
			Logger.warn({error, id}, 'Failed to read a message reaction user counter');
		}
	}
	return {
		reactionCount: sample,
		count,
		async increment() {
			if (counterPresent) await adjustExistingCounter(id, 1);
		},
	};
}

export async function removeMessageReactionCounted(
	repository: IMessageInteractionRepository,
	channelId: ChannelID,
	messageId: MessageID,
	userId: UserID,
	emojiName: string,
	emojiId?: EmojiID,
): Promise<void> {
	const id = messageReactionUserCounterId(channelId, messageId, emojiName, emojiId);
	let counterPresent = false;
	try {
		counterPresent = (await getKVClient().exists(counterKey(MESSAGE_REACTION_USERS_COUNTER, id))) > 0;
	} catch (error) {
		Logger.warn({error, id}, 'Failed to read a message reaction user counter');
	}
	const existed =
		counterPresent && (await repository.checkUserReactionExists(channelId, messageId, userId, emojiName, emojiId));
	await repository.removeReaction(channelId, messageId, userId, emojiName, emojiId);
	if (existed) await adjustExistingCounter(id, -1);
	// TEMPORARY: bulk removals leave a high cached count for at most 24 hours. If messages approach the cap,
	// rebuild on bulk removal; small reactions always use the exact bounded sample.
}
