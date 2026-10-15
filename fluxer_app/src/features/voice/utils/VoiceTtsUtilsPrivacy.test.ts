// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Message} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {setupI18n} from '@lingui/core';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	referenceState: 'loaded',
	referenceAuthor: {id: 'quoted', username: 'Private Quoted Author'},
	users: new Map([
		['sender', {id: 'sender', username: 'Visible Sender'}],
		['quoted', {id: 'quoted', username: 'Private Quoted Author'}],
	]),
}));

vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {ttsRate: 1}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'self'}}));
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {getChannel: () => ({id: 'channel', guildId: null})},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/messaging/state/MessageReferences', () => ({
	MessageReferenceState: {LOADED: 'loaded'},
	default: {
		getMessageReference: () => ({
			state: state.referenceState,
			message: {author: state.referenceAuthor, blocked: false},
		}),
	},
}));
vi.mock('@app/features/messaging/utils/SystemMessageUtils', () => ({SystemMessageUtils: {}}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {currentChannelId: 'channel'}}));
vi.mock('@app/features/ui/state/Notification', () => ({
	// Upstream 2026-10: /tts only plays for the channel in view; these tests read messages in the viewed channel.
	default: {ttsNotificationMode: 'all', isViewingChannel: () => true},
	TTSNotificationMode: {NEVER: 'never', FOR_CURRENT_CHANNEL: 'current', FOR_ALL_CHANNELS: 'all'},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getNativePlatformSync: () => null,
	isChromiumBrowser: () => false,
}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({
	default: {isGuildOrChannelMuted: () => false, isParentCategoryMuted: () => false},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {locale: 'en-US'}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => state.users.get(id)}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({shouldUse12HourFormat: () => false}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en-US'}));
vi.mock('@lingui/core/macro', () => ({
	msg: (descriptor: {message: string}) => ({...descriptor, id: descriptor.message}),
}));

const speech = {
	speak: vi.fn(),
	getVoices: () => [],
	cancel: vi.fn(),
	resume: vi.fn(),
	addEventListener: vi.fn(),
	removeEventListener: vi.fn(),
};
Object.defineProperty(window, 'speechSynthesis', {value: speech, configurable: true});
vi.stubGlobal(
	'SpeechSynthesisUtterance',
	class {
		constructor(public text: string) {}
	},
);

// Keep the relationship store, formatter and native speech adapter real. The
// reference fixture deliberately has a stale unblocked snapshot.
const {default: Relationships} = await import('@app/features/relationship/state/Relationships');
const {RelationshipTypes} = await import('@fluxer/constants/src/UserConstants');
const {default: VoiceTtsUtils} = await import('@app/features/voice/utils/VoiceTtsUtils');

const reply = (id: string): Message =>
	({
		id,
		channel_id: 'channel',
		author: {id: 'sender'},
		type: 19,
		content: 'Visible reply body',
		message_reference: {message_id: 'target'},
	}) as Message;

function spokenText(): string {
	return speech.speak.mock.calls.map(([utterance]) => utterance.text).join(' ');
}

beforeEach(() => {
	speech.speak.mockClear();
	Relationships.loadRelationships([]);
	state.referenceState = 'loaded';
	state.users.set('quoted', state.referenceAuthor);
	VoiceTtsUtils.setI18n(setupI18n({locale: 'en', messages: {en: {}}}));
});

afterEach(() => VoiceTtsUtils.dispose());

describe('incoming TTS reply author visibility', () => {
	it('omits the blocked quoted name from actual speech while keeping the visible reply', () => {
		Relationships.updateRelationship({
			id: 'quoted',
			type: RelationshipTypes.BLOCKED,
			since: '2026-10-05T00:00:00.000Z',
		});
		VoiceTtsUtils.handleIncomingTtsMessage(reply('blocked-quote'));
		expect(spokenText()).toBe('Visible Sender said: Visible reply body');
		expect(spokenText()).not.toContain('Private Quoted Author');
	});

	it('reads current blocking state after block and unblock rather than the cached quote flag', () => {
		VoiceTtsUtils.handleIncomingTtsMessage(reply('before-block'));
		expect(spokenText()).toContain('Replying to Private Quoted Author');
		speech.speak.mockClear();
		Relationships.updateRelationship({
			id: 'quoted',
			type: RelationshipTypes.BLOCKED,
			since: '2026-10-05T00:00:00.000Z',
		});
		VoiceTtsUtils.handleIncomingTtsMessage(reply('after-block'));
		expect(spokenText()).toBe('Visible Sender said: Visible reply body');
		speech.speak.mockClear();
		Relationships.removeRelationship('quoted');
		VoiceTtsUtils.handleIncomingTtsMessage(reply('after-unblock'));
		expect(spokenText()).toBe('Replying to Private Quoted Author, Visible Sender said: Visible reply body');
	});

	it.each(['deleted', 'unloaded'])('omits the quote author for a %s reference', (status) => {
		state.referenceState = status;
		VoiceTtsUtils.handleIncomingTtsMessage(reply(status));
		expect(spokenText()).toBe('Visible Sender said: Visible reply body');
	});

	it('keeps the visible reply when its quoted user cannot be resolved', () => {
		state.users.delete('quoted');
		VoiceTtsUtils.handleIncomingTtsMessage(reply('missing-user'));
		expect(spokenText()).toBe('Visible Sender said: Visible reply body');
	});

	it('still suppresses incoming messages whose own author is blocked', () => {
		Relationships.updateRelationship({
			id: 'sender',
			type: RelationshipTypes.BLOCKED,
			since: '2026-10-05T00:00:00.000Z',
		});
		VoiceTtsUtils.handleIncomingTtsMessage(reply('blocked-sender'));
		expect(speech.speak).not.toHaveBeenCalled();
	});
});
