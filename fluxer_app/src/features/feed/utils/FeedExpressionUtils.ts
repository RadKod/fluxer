// SPDX-License-Identifier: AGPL-3.0-or-later

import Emoji from '@app/features/emoji/state/Emoji';
import type {FlatEmoji} from '@app/features/emoji/types/EmojiTypes';
import {getEmojiDisplayDataWithSkinTone} from '@app/features/expressions/utils/SkinToneUtils';

/** The text with `insert` in place of the selection [start, end), and the caret right after it. */
export function insertAtSelection(
	value: string,
	start: number,
	end: number,
	insert: string,
): {value: string; caret: number} {
	const from = Math.min(Math.max(0, Math.min(start, end)), value.length);
	const to = Math.min(Math.max(from, start, end), value.length);
	return {value: value.slice(0, from) + insert + value.slice(to), caret: from + insert.length};
}

/**
 * What a picked emoji writes into a feed text box: a Unicode emoji as the character itself (with the chosen skin tone),
 * so it reads the same everywhere; a custom emoji as the `<:name:id>` markdown the message renderer draws.
 */
export function feedEmojiText(emoji: FlatEmoji): string {
	if (emoji.id) return Emoji.getEmojiMarkdown(emoji);
	return getEmojiDisplayDataWithSkinTone(emoji, Emoji.skinTone).surrogates || Emoji.getEmojiMarkdown(emoji);
}
