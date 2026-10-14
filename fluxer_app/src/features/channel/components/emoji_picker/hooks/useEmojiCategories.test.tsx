// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {useEmojiCategories} from '@app/features/channel/components/emoji_picker/hooks/useEmojiCategories';
import {useVirtualRows} from '@app/features/channel/components/emoji_picker/hooks/useVirtualRows';
import EmojiPicker, {getEmojiUsageKey} from '@app/features/emoji/state/EmojiPicker';
import type {FlatEmoji} from '@app/features/emoji/types/EmojiTypes';
import SelectedGuild from '@app/features/navigation/state/SelectedGuild';
import {create} from '@bufbuild/protobuf';
import {
	type EmojiPickerState,
	EmojiPickerStateSchema,
} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/pickers_pb';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const persistence = vi.hoisted(() => ({
	applyMessage: undefined as ((store: typeof EmojiPicker, message: EmojiPickerState) => void) | undefined,
}));
vi.mock('@app/features/user/state/SyncedField', () => ({
	makeSyncedField: async (
		_store: unknown,
		config: {applyMessage: (store: typeof EmojiPicker, message: EmojiPickerState) => void},
	) => {
		persistence.applyMessage = config.applyMessage;
	},
}));
vi.mock('@app/features/platform/utils/ComponentBus', () => ({ComponentBus: {dispatch: vi.fn()}}));
vi.mock('@app/features/guild/state/GuildList', () => ({default: {guilds: []}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: (id: string) => ({id, name: id})}}));
vi.mock('@app/features/navigation/state/SelectedGuild', async () => {
	const {makeAutoObservable} = await import('mobx');
	return {default: makeAutoObservable({selectedGuildId: null as string | null})};
});
vi.mock('@app/features/expressions/utils/UnicodeEmojis', () => ({
	default: {
		getCategoryForEmoji: () => 'people',
		getCategories: () => ['people'],
		getCategoryLabel: () => 'People',
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => {
	const i18n = {locale: 'en', _: (descriptor: {message: string}) => descriptor.message};
	return {useLingui: () => ({i18n})};
});

const emojis: Array<FlatEmoji> = ['smile', 'heart', 'wave'].map((name, index) => ({
	name,
	uniqueName: name,
	allNamesString: name,
	index,
}));
const emptySearch: Array<FlatEmoji> = [];

describe('useEmojiCategories', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let latest: ReturnType<typeof useEmojiCategories>;
	let rows: ReturnType<typeof useVirtualRows>;
	let revision = 0;

	const Picker = observer(
		({
			allEmojis,
			search = '',
			searchResults = emptySearch,
		}: {
			allEmojis: Array<FlatEmoji>;
			search?: string;
			searchResults?: Array<FlatEmoji>;
			revision: number;
		}) => {
			latest = useEmojiCategories(allEmojis, searchResults);
			rows = useVirtualRows(
				search,
				searchResults,
				latest.favoriteEmojis,
				latest.frequentlyUsedEmojis,
				latest.customEmojisByGuildId,
				latest.unicodeEmojisByCategory,
			);
			return createElement(
				'div',
				null,
				rows
					.map((row) => (row.type === 'emoji-row' ? row.emojis.map((emoji) => emoji.name).join(',') : row.name))
					.join('|'),
			);
		},
	);
	const renderPicker = (allEmojis = emojis, search = '', searchResults = emptySearch) =>
		act(() => root.render(createElement(Picker, {allEmojis, search, searchResults, revision: revision++})));
	const applyRemote = (favoriteEmojiIds: Array<string>) =>
		runInAction(() => persistence.applyMessage!(EmojiPicker, create(EmojiPickerStateSchema, {favoriteEmojiIds})));

	beforeEach(async () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		await Promise.resolve();
		applyRemote([]);
		runInAction(() => {
			SelectedGuild.selectedGuildId = null;
		});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});

	it('keeps the derived favorites and virtual rows when rerenders do not change favorite content', () => {
		applyRemote([getEmojiUsageKey(emojis[0]!)]);
		const allEmojis = emojis.slice();
		const iterations = vi.spyOn(allEmojis, Symbol.iterator);
		renderPicker(allEmojis);
		const favorites = latest.favoriteEmojis;
		const initialRows = rows;
		const scans = iterations.mock.calls.length;
		renderPicker(allEmojis);
		expect(latest.favoriteEmojis).toBe(favorites);
		expect(rows).toBe(initialRows);
		expect(iterations).toHaveBeenCalledTimes(scans);
		act(() => applyRemote([getEmojiUsageKey(emojis[0]!)]));
		expect(latest.favoriteEmojis).toBe(favorites);
		expect(rows).toBe(initialRows);
		expect(iterations).toHaveBeenCalledTimes(scans);
	});

	it('observes in-place favorite push and splice after unchanged rerenders', () => {
		renderPicker();
		renderPicker();
		const initialIds = EmojiPicker.favoriteEmojis;
		act(() => EmojiPicker.toggleFavorite(getEmojiUsageKey(emojis[0]!)));
		expect(EmojiPicker.favoriteEmojis).toBe(initialIds);
		expect(latest.favoriteEmojis).toEqual([emojis[0]]);
		expect(container.textContent).toContain('Favorited|smile');
		renderPicker();
		act(() => EmojiPicker.toggleFavorite(getEmojiUsageKey(emojis[0]!)));
		expect(EmojiPicker.favoriteEmojis).toBe(initialIds);
		expect(latest.favoriteEmojis).toEqual([]);
		expect(container.textContent).not.toContain('Favorited');
	});

	it('observes same-length remote replacement and in-place same-length replacement', () => {
		applyRemote([getEmojiUsageKey(emojis[0]!)]);
		renderPicker();
		renderPicker();
		const favorites = latest.favoriteEmojis;
		act(() => applyRemote([getEmojiUsageKey(emojis[1]!)]));
		expect(latest.favoriteEmojis).not.toBe(favorites);
		expect(latest.favoriteEmojis).toEqual([emojis[1]]);
		expect(container.textContent).toContain('Favorited|heart');
		act(() => {
			EmojiPicker.toggleFavorite(getEmojiUsageKey(emojis[1]!));
			EmojiPicker.toggleFavorite(getEmojiUsageKey(emojis[2]!));
		});
		expect(latest.favoriteEmojis).toEqual([emojis[2]]);
		expect(container.textContent).toContain('Favorited|wave');
	});

	it('refreshes favorite objects and ordering when allEmojis changes', () => {
		applyRemote([getEmojiUsageKey(emojis[0]!), getEmojiUsageKey(emojis[1]!)]);
		renderPicker();
		const favorites = latest.favoriteEmojis;
		const replacement = [
			{...emojis[1]!, name: 'new heart'},
			{...emojis[0]!, name: 'new smile'},
		];
		renderPicker(replacement);
		expect(latest.favoriteEmojis).not.toBe(favorites);
		expect(latest.favoriteEmojis).toEqual(replacement);
		expect(latest.favoriteEmojis[0]).toBe(replacement[0]);
	});

	it('updates search results and category collapse without rebuilding unchanged favorites', () => {
		applyRemote([getEmojiUsageKey(emojis[0]!)]);
		renderPicker();
		const favorites = latest.favoriteEmojis;
		renderPicker(emojis, 'heart', [emojis[1]!]);
		expect(container.textContent).toBe('heart');
		expect(latest.favoriteEmojis).toBe(favorites);
		renderPicker();
		act(() => EmojiPicker.toggleCategory('favorites'));
		expect(container.textContent).toBe('Favorited|People|smile,heart,wave');
		expect(latest.favoriteEmojis).toBe(favorites);
		act(() => EmojiPicker.toggleCategory('favorites'));
		expect(container.textContent).toBe('Favorited|smile|People|smile,heart,wave');
		act(() => EmojiPicker.toggleCategory('people'));
		expect(container.textContent).toBe('Favorited|smile|People');
	});
});
