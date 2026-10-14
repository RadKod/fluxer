// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/emoji/state/Emoji', () => ({
	default: {
		skinTone: '',
		getEmojiMarkdown: (emoji: {id?: string; animated?: boolean; uniqueName: string}) =>
			emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.uniqueName}:${emoji.id}>` : `:${emoji.uniqueName}:`,
	},
}));
vi.mock('@app/features/expressions/utils/SkinToneUtils', () => ({
	getEmojiDisplayDataWithSkinTone: (emoji: {surrogates?: string}) => ({surrogates: emoji.surrogates ?? '', url: ''}),
}));

const {feedEmojiText, insertAtSelection} = await import('@app/features/feed/utils/FeedExpressionUtils');

describe('insertAtSelection', () => {
	it('puts the text at the caret and moves the caret after it', () => {
		expect(insertAtSelection('ab', 1, 1, '😀')).toEqual({value: 'a😀b', caret: 3});
	});

	it('replaces the selected text', () => {
		expect(insertAtSelection('a big b', 2, 5, '😀')).toEqual({value: 'a 😀 b', caret: 4});
	});

	it('clamps a stale selection to the text', () => {
		expect(insertAtSelection('ab', 9, 9, '😀')).toEqual({value: 'ab😀', caret: 4});
	});
});

const EMOJI = {allNamesString: ''};

describe('feedEmojiText', () => {
	it('writes a Unicode emoji as the character itself', () => {
		expect(feedEmojiText({...EMOJI, name: 'grinning', uniqueName: 'grinning', surrogates: '😀'})).toBe('😀');
	});

	it('writes a custom emoji in the markdown form the message renderer draws', () => {
		expect(feedEmojiText({...EMOJI, name: 'pepe', uniqueName: 'pepe', id: '123', guildId: '9'})).toBe('<:pepe:123>');
		expect(feedEmojiText({...EMOJI, name: 'dance', uniqueName: 'dance', id: '5', animated: true})).toBe('<a:dance:5>');
	});
});
