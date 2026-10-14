// SPDX-License-Identifier: AGPL-3.0-or-later

import emojiData from '@app/media/data/emojis.json';
import {SKIN_TONE_SURROGATES} from '@fluxer/constants/src/EmojiConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

// Category icons do not participate in matching; avoid importing the full icon barrel.
vi.mock('@phosphor-icons/react', () => ({
	BicycleIcon: () => null,
	BowlFoodIcon: () => null,
	FlagIcon: () => null,
	GameControllerIcon: () => null,
	HeartIcon: () => null,
	LeafIcon: () => null,
	MagnetIcon: () => null,
	SmileyIcon: () => null,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
// Keep asset URL generation independent of application runtime configuration.
vi.mock('@app/features/expressions/utils/EmojiUtils', () => ({
	getEmojiURL: vi.fn((surrogate: string) => `/emoji/${surrogate}.svg`),
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

describe('Unicode emoji matching', () => {
	it.each(['', 'Plain text 123 # * :smile: :)', 'Yerel ölçüm gönderisi: şğüıöç İĞÜŞÖÇ.'])(
		'does not build the emoji index for plain text %j',
		async (text) => {
			const {default: emojis} = await import('./UnicodeEmojis');
			const {getEmojiURL} = await import('./EmojiUtils');
			expect([...emojis.matchEmojiSurrogates(text)]).toEqual([]);
			expect(vi.mocked(getEmojiURL).mock.calls.length).toBe(0);
			// Prove that this observation detects a real, cold index build.
			expect([...emojis.matchEmojiSurrogates('😀')]).toHaveLength(1);
			expect(getEmojiURL).toHaveBeenCalled();
		},
	);

	it('matches every catalog entry and skin with its full UTF-16 offsets', async () => {
		const {default: emojis} = await import('./UnicodeEmojis');
		const sequences = Object.values(emojiData.categories).flatMap((entries) =>
			entries.flatMap((entry) => [
				entry.surrogates,
				...((entry as {skins?: Array<{surrogates: string}>}).skins ?? []).map((skin) => skin.surrogates),
			]),
		);
		for (const sequence of sequences) {
			const name = emojis.getSurrogateName(sequence);
			expect(name, sequence).not.toBeNull();
			expect([...emojis.matchEmojiSurrogates(`x${sequence}y`)], sequence).toEqual([
				{start: 1, end: 1 + sequence.length, name},
			]);
		}
	});

	it('preserves standalone components, keycaps, variation selectors, ZWJ and copyright symbols', async () => {
		const {default: emojis} = await import('./UnicodeEmojis');
		expect([...emojis.matchEmojiSurrogates('© ® ️ ‍')]).toEqual([]);
		const sequences = [
			...SKIN_TONE_SURROGATES,
			'🦰',
			'🦱',
			'🦳',
			'🦲',
			'1️⃣',
			'1⃣',
			'#️⃣',
			'*️⃣',
			'❤️',
			'👩‍💻',
			'👁️‍🗨️',
			'©️',
			'®️',
		];
		for (const sequence of sequences) {
			expect([...emojis.matchEmojiSurrogates(`a${sequence}b`)], sequence).toEqual([
				{start: 1, end: 1 + sequence.length, name: emojis.getSurrogateName(sequence)},
			]);
		}
	});

	it('preserves startIndex coercion, UTF-16 positions and unknown regional indicator pairs', async () => {
		const {default: emojis} = await import('./UnicodeEmojis');
		const text = 'x😀©️®️';
		const expected = [
			{start: 1, end: 3, name: emojis.getSurrogateName('😀')},
			{start: 3, end: 5, name: emojis.getSurrogateName('©️')},
			{start: 5, end: 7, name: emojis.getSurrogateName('®️')},
		];
		for (const start of [-10, Number.NaN, 0, 1, 1.5]) {
			expect([...emojis.matchEmojiSurrogates(text, start)]).toEqual(expected);
		}
		expect([...emojis.matchEmojiSurrogates(text, 2)]).toEqual(expected.slice(1));
		expect([...emojis.matchEmojiSurrogates(text, 5)]).toEqual(expected.slice(2));
		expect([...emojis.matchEmojiSurrogates(text, Number.POSITIVE_INFINITY)]).toEqual([]);
		const unknownPair = '🇦🇦';
		expect([...emojis.matchEmojiSurrogates(unknownPair)]).toEqual([
			{start: 0, end: 2, name: emojis.getSurrogateName('🇦')},
			{start: 2, end: 4, name: emojis.getSurrogateName('🇦')},
		]);
		expect([...emojis.matchEmojiSurrogates('🇹🇷', 2)]).toEqual([{start: 2, end: 4, name: emojis.getSurrogateName('🇷')}]);
	});

	it('keeps suspended match iterators independent when plain text is scanned between them', async () => {
		const {default: emojis} = await import('./UnicodeEmojis');
		const first = emojis.matchEmojiSurrogates('😀©️');
		const second = emojis.matchEmojiSurrogates('x®️');
		expect(first.next().value).toEqual({start: 0, end: 2, name: emojis.getSurrogateName('😀')});
		expect(second.next().value).toEqual({start: 1, end: 3, name: emojis.getSurrogateName('®️')});
		expect([...emojis.matchEmojiSurrogates('Türkçe metin')]).toEqual([]);
		expect(first.next().value).toEqual({start: 2, end: 4, name: emojis.getSurrogateName('©️')});
		expect(second.next().done).toBe(true);
		expect(first.next().done).toBe(true);
	});

	it('still resolves shortcodes after a plain-text scan', async () => {
		const {default: emojis} = await import('./UnicodeEmojis');
		expect([...emojis.matchEmojiSurrogates(':smile:')]).toEqual([]);
		expect(emojis.shortcodeTextToSurrogates(':smile:')).toBe('😄');
		expect(emojis.findEmojiByShortcodeName('smile')?.surrogates).toBe('😄');
	});
});
