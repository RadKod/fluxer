// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, createRef, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'}}),
}));
vi.mock('@app/features/emoji/state/Emoji', () => ({
	default: {
		skinTone: '',
		getEmojiMarkdown: (emoji: {id?: string; uniqueName: string}) =>
			emoji.id ? `<:${emoji.uniqueName}:${emoji.id}>` : `:${emoji.uniqueName}:`,
	},
}));
vi.mock('@app/features/expressions/utils/SkinToneUtils', () => ({
	getEmojiDisplayDataWithSkinTone: (emoji: {surrogates?: string}) => ({surrogates: emoji.surrogates ?? '', url: ''}),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
// The popout and the sheet open the real picker; here each is a button that picks one emoji.
const picked = vi.hoisted(() => ({emoji: {name: 'grinning', uniqueName: 'grinning', surrogates: '😀'} as object}));
const pickButton = (onEmojiSelect: (emoji: object) => void) =>
	createElement('button', {type: 'button', 'data-pick': '', onClick: () => onEmojiSelect(picked.emoji)}, 'pick');
// Like the real PopoverPopout, which keeps the render function it was opened with: later renders of the buttons do
// not reach an open picker.
type PopoutRender = (props: {onClose: () => void}) => ReactNode;
const popout = vi.hoisted(() => ({render: null as null | ((props: {onClose: () => void}) => unknown)}));
vi.mock('@app/features/ui/popover/PopoverPopout', () => ({
	Popout: ({render, children}: {render: PopoutRender; children: ReactNode}) => {
		popout.render ??= render;
		return [children, popout.render({onClose: () => {}})];
	},
}));
vi.mock('@app/features/expressions/components/popouts/ExpressionPickerPopout', () => ({
	ExpressionPickerPopout: ({onEmojiSelect}: {onEmojiSelect: (emoji: object) => void}) => pickButton(onEmojiSelect),
}));
vi.mock('@app/features/expressions/components/modals/ExpressionPickerSheet', () => ({
	ExpressionPickerSheet: ({isOpen, onEmojiSelect}: {isOpen: boolean; onEmojiSelect: (emoji: object) => void}) =>
		isOpen ? pickButton(onEmojiSelect) : null,
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
const runtime = vi.hoisted(() => ({gifEnabled: true, mediaEndpoint: 'https://media.micup.test'}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/expressions/components/modals/GifPickerSelectModal', () => ({GifPickerSelectModal: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));

const {FeedExpressionButtons} = await import('@app/features/feed/components/FeedExpressionButtons');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');

const KLIPY_GIF = 'https://media.micup.test/external/AbC/https/static.klipy.com/ii/c8/28/HkAKKCzZ.webp';
const GIF = {
	provider: 'klipy',
	url: 'https://klipy.com/gifs/cat-1',
	slug: 'cat-1',
	media: {webp: {proxy_src: KLIPY_GIF}},
};

describe('FeedExpressionButtons', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let textarea: HTMLTextAreaElement;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		textarea = document.createElement('textarea');
		document.body.append(textarea);
		(MobileLayout as {enabled: boolean}).enabled = false;
		picked.emoji = {name: 'grinning', uniqueName: 'grinning', surrogates: '😀'};
		runtime.gifEnabled = true;
		popout.render = null;
		vi.clearAllMocks();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		textarea.remove();
	});

	const render = (value: string, maxLength = 1000, onGif?: (gif: unknown) => void) => {
		const onChange = vi.fn();
		const textareaRef = createRef<HTMLTextAreaElement>() as {current: HTMLTextAreaElement | null};
		textareaRef.current = textarea;
		textarea.value = value;
		act(() =>
			root.render(
				createElement(FeedExpressionButtons, {
					textareaRef,
					value,
					onChange,
					maxLength,
					buttonClassName: 'tool',
					iconClassName: 'icon',
					onGif,
				}),
			),
		);
		return onChange;
	};
	const pick = () => act(() => (container.querySelector('[data-pick]') as HTMLButtonElement).click());

	it('has a labelled emoji button', () => {
		render('');
		expect(container.querySelector('button[aria-label="Open emoji picker"]')).not.toBeNull();
	});

	it('puts the picked emoji at the caret', () => {
		const onChange = render('ab');
		textarea.setSelectionRange(1, 1);
		pick();
		expect(onChange).toHaveBeenCalledWith('a😀b');
	});

	it('keeps every emoji of a shift-click run, though the open picker holds its first render', () => {
		const textareaRef = {current: textarea};
		const draw = (value: string) =>
			act(() =>
				root.render(
					createElement(FeedExpressionButtons, {
						textareaRef,
						value,
						onChange,
						maxLength: 1000,
						buttonClassName: 'tool',
						iconClassName: 'icon',
					}),
				),
			);
		// The box is controlled: its text follows each change.
		const onChange = vi.fn((next: string) => {
			textarea.value = next;
			draw(next);
		});
		textarea.value = '';
		draw('');
		pick();
		pick();
		expect(onChange).toHaveBeenLastCalledWith('😀😀');
	});

	it('writes a custom emoji as its markdown', () => {
		picked.emoji = {name: 'pepe', uniqueName: 'pepe', id: '123', guildId: '9'};
		const onChange = render('hi ');
		textarea.setSelectionRange(3, 3);
		pick();
		expect(onChange).toHaveBeenCalledWith('hi <:pepe:123>');
	});

	it('leaves the text alone when the emoji would pass the length limit', () => {
		const onChange = render('abc', 4);
		textarea.setSelectionRange(3, 3);
		pick();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('opens the picker as a sheet on the phone layout', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		const onChange = render('');
		expect(container.querySelector('[data-pick]')).toBeNull();
		act(() => (container.querySelector('button[aria-label="Open emoji picker"]') as HTMLButtonElement).click());
		pick();
		expect(onChange).toHaveBeenCalledWith('😀');
	});

	// The GIF picker is Fluxer's GifPickerSelectModal; picking calls its onSelect.
	const pickGif = () => {
		act(() => (container.querySelector('button[aria-label="Choose a GIF"]') as HTMLButtonElement).click());
		const render = vi.mocked(ModalCommands.push).mock.calls[0]![0] as unknown as () => {
			props: {onSelect: (gif: unknown) => void};
		};
		act(() => render().props.onSelect(GIF));
	};

	it('has a GIF button only while GIFs are on', () => {
		render('');
		expect(container.querySelector('button[aria-label="Choose a GIF"]')).not.toBeNull();
		runtime.gifEnabled = false;
		render('');
		expect(container.querySelector('button[aria-label="Choose a GIF"]')).toBeNull();
	});

	it('writes a picked GIF into the text as its proxied link on a line of its own', () => {
		const onChange = render('haha ');
		pickGif();
		expect(onChange).toHaveBeenCalledWith(`haha
${KLIPY_GIF}`);
	});

	it('leaves the text alone when the GIF link would pass the length limit', () => {
		const onChange = render('haha', 20);
		pickGif();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('hands a picked GIF to onGif instead when the box takes it as media', () => {
		const onGif = vi.fn();
		const onChange = render('haha', 1000, onGif);
		pickGif();
		expect(onGif).toHaveBeenCalledWith(GIF);
		expect(onChange).not.toHaveBeenCalled();
	});
});
