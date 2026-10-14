// SPDX-License-Identifier: AGPL-3.0-or-later

import {Message as MessageRecord} from '@app/features/messaging/models/MessagingMessage';
import Messages from '@app/features/messaging/state/MessagingMessages';
import {LRUMap} from '@app/lib/list/ListLruMap';
import {MessageFlags, MessageReferenceTypes} from '@fluxer/constants/src/ChannelConstants';
import type {ValueOf} from '@fluxer/constants/src/ValueOf';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {makeAutoObservable, runInAction} from 'mobx';

export const MessageReferenceState = {
	LOADED: 'LOADED',
	NOT_LOADED: 'NOT_LOADED',
	DELETED: 'DELETED',
} as const;

export type MessageReferenceState = ValueOf<typeof MessageReferenceState>;

type MessageReferenceResolution =
	| {readonly state: typeof MessageReferenceState.LOADED; readonly message: MessageRecord}
	| {readonly state: typeof MessageReferenceState.NOT_LOADED}
	| {readonly state: typeof MessageReferenceState.DELETED};

const NOT_LOADED_RESOLUTION: MessageReferenceResolution = Object.freeze({
	state: MessageReferenceState.NOT_LOADED,
});

const DELETED_RESOLUTION: MessageReferenceResolution = Object.freeze({
	state: MessageReferenceState.DELETED,
});

type MessageInput = WireMessage | MessageRecord;

const REFERENCE_CACHE_CAPACITY = 1000;
type ReferenceToken = {valid: boolean; deleted?: boolean};
type SnapshotToken = {validity: ReferenceToken; deletion: ReferenceToken};

const toWireMessage = (message: MessageInput): WireMessage =>
	message instanceof MessageRecord ? message.toJSON() : message;

class MessageReferences {
	deletedMessageIds = new Set<string>();
	cachedMessages = new Map<string, MessageRecord>();
	// Only mounted reply views own active entries; history is kept in the bounded cold cache.
	activeReferences = new Map<string, {message?: MessageRecord; count: number; deleted?: boolean}>();
	generation = 0;
	private cacheOrder = new LRUMap<string, true>(REFERENCE_CACHE_CAPACITY);
	private deletedOrder = new LRUMap<string, true>(REFERENCE_CACHE_CAPACITY);
	// Weak owner keys keep invalidation for remounts without retaining historical snapshots.
	private snapshotTokens = new WeakMap<object, SnapshotToken>();
	private referenceTokens = new Map<string, ReferenceToken>();

	constructor() {
		makeAutoObservable<this, 'cacheOrder' | 'deletedOrder' | 'snapshotTokens' | 'referenceTokens'>(
			this,
			{
				cacheOrder: false,
				deletedOrder: false,
				snapshotTokens: false,
				referenceTokens: false,
				getMessageReference: false,
				getReferencedMessages: false,
			},
			{autoBind: true},
		);
	}

	private getKey(channelId: string, messageId: string): string {
		return `${channelId}:${messageId}`;
	}

	private touchCache(key: string): void {
		if (!this.cacheOrder.has(key) && this.cacheOrder.size === REFERENCE_CACHE_CAPACITY) {
			const oldest = this.cacheOrder.keys().next().value;
			if (oldest !== undefined) {
				this.cachedMessages.delete(oldest);
				if (!this.activeReferences.has(oldest)) this.invalidateSnapshots(oldest);
			}
		}
		this.cacheOrder.set(key, true);
	}

	private cacheMessage(key: string, message: MessageRecord): void {
		this.touchCache(key);
		this.cachedMessages.set(key, message);
		if (!this.referenceTokens.has(key)) this.referenceTokens.set(key, {valid: true});
		const active = this.activeReferences.get(key);
		if (active) active.message = message;
	}

	private invalidateSnapshots(key: string): void {
		const token = this.referenceTokens.get(key);
		if (token) token.valid = false;
		this.referenceTokens.delete(key);
	}

	private trackSnapshot(message: MessageRecord, token: ReferenceToken): void {
		const snapshot = this.snapshotTokens.get(message.snapshotIdentity);
		if (snapshot) snapshot.deletion = token;
		else this.snapshotTokens.set(message.snapshotIdentity, {validity: token, deletion: token});
	}

	private setCachedMessage(refChannelId: string, refMessageId: string, message: MessageInput): boolean {
		const key = this.getKey(refChannelId, refMessageId);
		if (this.deletedMessageIds.has(key) || this.activeReferences.get(key)?.deleted) return false;
		const nextMessage = new MessageRecord(toWireMessage(message), {missingReactions: 'preserve'});
		const currentMessage = this.cachedMessages.get(key);
		if (currentMessage?.equals(nextMessage)) {
			return false;
		}
		this.cacheMessage(key, nextMessage);
		return true;
	}

	private markReferenceDeleted(refChannelId: string, refMessageId: string): boolean {
		const key = this.getKey(refChannelId, refMessageId);
		const alreadyDeleted = this.deletedMessageIds.has(key);
		if (!alreadyDeleted && this.deletedOrder.size === REFERENCE_CACHE_CAPACITY) {
			const oldest = this.deletedOrder.keys().next().value;
			if (oldest !== undefined) this.deletedMessageIds.delete(oldest);
		}
		this.deletedOrder.set(key, true);
		if (alreadyDeleted && !this.cachedMessages.has(key)) {
			return false;
		}
		this.deletedMessageIds.add(key);
		this.cachedMessages.delete(key);
		this.cacheOrder.delete(key);
		const token = this.referenceTokens.get(key);
		if (token) token.deleted = true;
		this.invalidateSnapshots(key);
		const active = this.activeReferences.get(key);
		if (active) {
			active.message = undefined;
			active.deleted = true;
		}
		return true;
	}

	private updateCachedMessage(refChannelId: string, refMessageId: string, updates: Partial<WireMessage>): boolean {
		const key = this.getKey(refChannelId, refMessageId);
		if (this.deletedMessageIds.has(key) || this.activeReferences.get(key)?.deleted) return false;
		const currentMessage = this.activeReferences.get(key)?.message ?? this.cachedMessages.get(key);
		if (!currentMessage) {
			return false;
		}
		const nextMessage = currentMessage.withUpdates(updates);
		if (currentMessage.equals(nextMessage)) {
			return false;
		}
		this.cacheMessage(key, nextMessage);
		return true;
	}

	private handleReferencedMessageUpdate(message: WireMessage): void {
		this.updateCachedMessage(message.channel_id, message.id, message);
	}

	private resolvableReferenceMessageId(message: WireMessage): string | undefined {
		const reference = message.message_reference;
		if (!reference || reference.type !== MessageReferenceTypes.DEFAULT) {
			return undefined;
		}
		if ((message.flags & MessageFlags.IS_CROSSPOST) !== 0) {
			return undefined;
		}
		return reference.message_id ?? undefined;
	}

	private resolveReferenceTarget(message: WireMessage, fallbackChannelId: string): boolean {
		const refMessageId = this.resolvableReferenceMessageId(message);
		if (!refMessageId) {
			return false;
		}
		const refChannelId = message.message_reference?.channel_id ?? fallbackChannelId;
		if (!('referenced_message' in message)) {
			return false;
		}
		const referenced = message.referenced_message;
		const changed =
			referenced == null
				? this.markReferenceDeleted(refChannelId, refMessageId)
				: this.setCachedMessage(refChannelId, refMessageId, referenced);
		// Resident replies may first render after their target's tombstone has been evicted.
		const owner = Messages.getMessage(message.channel_id, message.id)?.referencedMessage;
		if (owner) this.getMessageReference(refChannelId, refMessageId, owner);
		return changed;
	}

	handleMessageCreate(message: WireMessage, _optimistic: boolean): void {
		this.resolveReferenceTarget(message, message.channel_id);
	}

	handleMessageDelete(channelId: string, messageId: string): void {
		this.markReferenceDeleted(channelId, messageId);
	}

	handleMessageDeleteBulk(channelId: string, messageIds: Array<string>): void {
		for (const messageId of messageIds) {
			this.handleMessageDelete(channelId, messageId);
		}
	}

	handleMessagesFetchSuccess(channelId: string, messages: Array<WireMessage>): void {
		for (const message of messages) {
			const active = this.activeReferences.get(this.getKey(message.channel_id, message.id));
			if (active && !active.message) this.setCachedMessage(message.channel_id, message.id, message);
			this.handleReferencedMessageUpdate(message);
			this.resolveReferenceTarget(message, channelId);
		}
	}

	handleChannelDelete(channelId: string): void {
		this.cleanupChannelMessages(channelId);
	}

	handleGatewayReady(): void {
		this.deletedMessageIds.clear();
		this.deletedOrder.clear();
		this.cachedMessages.clear();
		this.cacheOrder.clear();
		this.activeReferences.clear();
		this.referenceTokens.clear();
		this.snapshotTokens = new WeakMap();
		this.generation++;
	}

	handleMessageUpdate(message: WireMessage): void {
		this.handleReferencedMessageUpdate(message);
		this.resolveReferenceTarget(message, message.channel_id);
	}

	private cleanupChannelMessages(channelId: string): void {
		const channelPrefix = `${channelId}:`;
		for (const key of Array.from(this.deletedMessageIds)) {
			if (key.startsWith(channelPrefix)) {
				this.deletedMessageIds.delete(key);
				this.deletedOrder.delete(key);
			}
		}
		for (const key of Array.from(this.cachedMessages.keys())) {
			if (key.startsWith(channelPrefix)) {
				this.cachedMessages.delete(key);
				this.cacheOrder.delete(key);
			}
		}
		for (const key of Array.from(this.activeReferences.keys())) {
			if (key.startsWith(channelPrefix)) {
				this.activeReferences.delete(key);
			}
		}
		for (const key of this.referenceTokens.keys()) {
			if (key.startsWith(channelPrefix)) {
				this.cacheOrder.delete(key);
				this.invalidateSnapshots(key);
			}
		}
	}

	retainReference(channelId: string, messageId: string, fallback?: MessageRecord | null): () => void {
		const key = this.getKey(channelId, messageId);
		let active = this.activeReferences.get(key);
		if (!active) {
			const resolution = this.getMessageReference(channelId, messageId, fallback);
			this.activeReferences.set(key, {
				message: resolution.state === MessageReferenceState.LOADED ? resolution.message : undefined,
				count: 0,
				deleted: resolution.state === MessageReferenceState.DELETED,
			});
			active = this.activeReferences.get(key)!;
		} else if (!active.message) {
			const resolution = this.getMessageReference(channelId, messageId, fallback);
			if (resolution.state === MessageReferenceState.LOADED) active.message = resolution.message;
		}
		active.count++;
		if (active.message) {
			// Track the snapshot's validity in the same bounded LRU without duplicating its payload.
			if (!this.referenceTokens.has(key)) this.touchCache(key);
			let token = this.referenceTokens.get(key);
			if (!token) {
				token = {valid: true};
				this.referenceTokens.set(key, token);
			}
			if (fallback) this.trackSnapshot(fallback, token);
		}
		const retained = active;
		let released = false;
		return () =>
			runInAction(() => {
				if (released) return;
				released = true;
				if (this.activeReferences.get(key) === retained) this.releaseReference(channelId, messageId);
			});
	}

	releaseReference(channelId: string, messageId: string): void {
		const key = this.getKey(channelId, messageId);
		const active = this.activeReferences.get(key);
		if (active && --active.count === 0) {
			this.activeReferences.delete(key);
			if (!this.cacheOrder.has(key)) this.invalidateSnapshots(key);
		}
	}

	getMessageReference(
		channelId: string,
		messageId: string,
		fallback?: MessageInput | null,
	): MessageReferenceResolution {
		const key = this.getKey(channelId, messageId);
		const owner = fallback instanceof MessageRecord && fallback.id === messageId && fallback.channelId === channelId;
		if (
			this.deletedMessageIds.has(key) ||
			this.activeReferences.get(key)?.deleted ||
			(owner && this.snapshotTokens.get(fallback.snapshotIdentity)?.deletion.deleted)
		) {
			this.deletedOrder.get(key);
			// Owners keep deletion knowledge weakly after their global tombstone is evicted.
			if (owner) {
				const deletedToken = {valid: false, deleted: true};
				this.snapshotTokens.set(fallback.snapshotIdentity, {validity: deletedToken, deletion: deletedToken});
			}
			return DELETED_RESOLUTION;
		}
		const token = this.referenceTokens.get(key);
		if (owner && token) {
			// An old invalid owner must not become valid when the same target is cached again.
			this.trackSnapshot(fallback, token);
		}
		const activeMessage = this.activeReferences.get(key)?.message;
		if (activeMessage) return {state: MessageReferenceState.LOADED, message: activeMessage};
		const cachedMessage = this.cachedMessages.get(key);
		if (cachedMessage) {
			this.cacheOrder.get(key);
			return {state: MessageReferenceState.LOADED, message: cachedMessage};
		}
		const message = Messages.getMessage(channelId, messageId);
		if (message) {
			return {state: MessageReferenceState.LOADED, message};
		}
		const fallbackChannelId = fallback instanceof MessageRecord ? fallback.channelId : fallback?.channel_id;
		if (fallback?.id === messageId && fallbackChannelId === channelId) {
			if (
				fallback instanceof MessageRecord &&
				this.snapshotTokens.get(fallback.snapshotIdentity)?.validity.valid === false
			) {
				return NOT_LOADED_RESOLUTION;
			}
			return {
				state: MessageReferenceState.LOADED,
				message:
					fallback instanceof MessageRecord
						? fallback
						: new MessageRecord(fallback, {
								skipUserCache: true,
								skipReactionHydration: true,
							}),
			};
		}
		if (fallback === null) return DELETED_RESOLUTION;
		return NOT_LOADED_RESOLUTION;
	}

	*getReferencedMessages(): IterableIterator<MessageRecord> {
		yield* this.cachedMessages.values();
		for (const active of this.activeReferences.values()) {
			if (active.message) yield active.message;
		}
	}
}

export default new MessageReferences();
