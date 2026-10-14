// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/channel/components/MessageComponents.module.css';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import type {MessageActionRow} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';
import {setupI18n} from '@lingui/core';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const commands = vi.hoisted(() => ({clickMessageComponent: vi.fn()}));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});

vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/messaging/commands/MessageComponentCommands', () => commands);
vi.mock('@app/features/messaging/utils/ReactionUtils', () => ({
	useEmojiURL: ({emoji}: {emoji: {id?: string | null; name: string}}) =>
		emoji.id ? `https://cdn.micup.test/emojis/${emoji.id}.webp` : `https://static.micup.test/emoji/${emoji.name}.svg`,
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		variant,
		small: _small,
		fitContent: _fitContent,
		submitting,
		contentClassName,
		leftIcon,
		onClick,
		children,
		...props
	}: ButtonHTMLAttributes<HTMLButtonElement> & {
		variant?: string;
		small?: boolean;
		fitContent?: boolean;
		submitting?: boolean;
		contentClassName?: string;
		leftIcon?: ReactNode;
	}) =>
		createElement(
			'button',
			{
				type: 'button',
				...props,
				// Fluxer's Button swallows clicks (and Enter/Space) while submitting: ui/button/Button.tsx handleClick.
				onClick: submitting ? undefined : onClick,
				'data-variant': variant,
				'data-submitting': submitting ? 'true' : undefined,
				'data-content-class': contentClassName,
			},
			leftIcon,
			children,
		),
}));

const {MessageComponents} = await import('@app/features/channel/components/MessageComponents');

const button = (overrides: Partial<MessageActionRow['components'][number]>) => ({
	type: 2 as const,
	style: 2,
	label: null,
	emoji: null,
	custom_id: 'roster:join',
	disabled: false,
	...overrides,
});
const ROSTER_ROWS: ReadonlyArray<MessageActionRow> = [
	{
		type: 1,
		components: [
			button({style: 3, label: 'Join', emoji: {name: '✅', id: null, animated: false}, custom_id: 'roster:join'}),
			button({style: 2, label: 'Leave', custom_id: 'roster:leave'}),
		],
	},
	{
		type: 1,
		components: [button({style: 1, emoji: {name: 'micup', id: '1300000000000000009', animated: false}})],
	},
];
const messageWith = (components: ReadonlyArray<MessageActionRow>) =>
	({id: '1300000000000000002', channelId: '1300000000000000003', components}) as unknown as Message;

describe('MessageComponents', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		commands.clickMessageComponent.mockReset();
		commands.clickMessageComponent.mockResolvedValue(undefined);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const show = (message: Message, isPreview = false) => {
		act(() => root.render(createElement(MessageComponents, {message, isPreview})));
	};
	const buttons = () => [...container.querySelectorAll('button')];

	it('renders one row per action row and one button per component with its label and emoji', () => {
		show(messageWith(ROSTER_ROWS));

		const rows = [...container.querySelectorAll('[role="group"]')];
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.querySelectorAll('button').length)).toEqual([2, 1]);
		expect(buttons().map((b) => b.textContent)).toEqual(['Join', 'Leave', '']);
		const images = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
		expect(images).toEqual([
			'https://static.micup.test/emoji/✅.svg',
			'https://cdn.micup.test/emojis/1300000000000000009.webp',
		]);
	});

	it('maps PRIMARY, SECONDARY, SUCCESS and DANGER to their styles', () => {
		show(
			messageWith([
				{
					type: 1,
					components: [1, 2, 3, 4].map((style) => button({style, label: `s${style}`, custom_id: `roster:${style}`})),
				},
			]),
		);

		expect(buttons().map((b) => b.dataset.variant)).toEqual(['primary', 'secondary', 'primary', 'danger']);
		const successClass = buttons()[2].className;
		expect(successClass).not.toBe('');
		expect(buttons().filter((b) => b.className === successClass)).toHaveLength(1);
	});

	it('a disabled button is disabled', () => {
		show(messageWith([{type: 1, components: [button({label: 'Join', disabled: true})]}]));

		expect(buttons()[0].disabled).toBe(true);
		act(() => buttons()[0].click());
		expect(commands.clickMessageComponent).not.toHaveBeenCalled();
	});

	it('a message without components renders no button row', () => {
		show(messageWith([]));

		expect(container.innerHTML).toBe('');
	});

	it('buttons in a preview (pins, search, reply preview) are disabled and do not click', () => {
		show(messageWith(ROSTER_ROWS), true);

		expect(buttons().every((b) => b.disabled)).toBe(true);
		for (const b of buttons()) act(() => b.click());
		expect(commands.clickMessageComponent).not.toHaveBeenCalled();
	});

	it('the button is submitting while its click is in flight', async () => {
		let finish = () => {};
		commands.clickMessageComponent.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		const message = messageWith(ROSTER_ROWS);
		show(message);

		act(() => buttons()[0].click());

		expect(commands.clickMessageComponent).toHaveBeenCalledWith(i18n, message, 'roster:join');
		expect(buttons()[0].dataset.submitting).toBe('true');
		act(() => buttons()[0].click());
		expect(commands.clickMessageComponent).toHaveBeenCalledTimes(1);

		await act(async () => finish());

		expect(buttons()[0].dataset.submitting).toBeUndefined();
	});

	it('a button keeps keyboard focus while its click is in flight', async () => {
		let finish = () => {};
		commands.clickMessageComponent.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		show(messageWith(ROSTER_ROWS));
		const join = buttons()[0];
		join.focus();

		act(() => join.click());

		expect(join.disabled).toBe(false);
		expect(document.activeElement).toBe(join);
		act(() => join.click());
		expect(commands.clickMessageComponent).toHaveBeenCalledTimes(1);

		await act(async () => finish());

		expect(document.activeElement).toBe(join);
	});

	it('a pending button is announced as busy', async () => {
		let finish = () => {};
		commands.clickMessageComponent.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		show(messageWith(ROSTER_ROWS));
		expect(buttons()[0].getAttribute('aria-busy')).toBeNull();

		act(() => buttons()[0].click());

		expect(buttons()[0].getAttribute('aria-busy')).toBe('true');
		expect(buttons()[1].getAttribute('aria-busy')).toBeNull();

		await act(async () => finish());

		expect(buttons()[0].getAttribute('aria-busy')).toBeNull();
	});

	it('a long label can shrink: the button content box gets the shrinkable class', () => {
		show(messageWith(ROSTER_ROWS));

		expect(styles.content).toBeTruthy();
		expect(buttons().map((b) => b.dataset.contentClass)).toEqual([styles.content, styles.content, styles.content]);
	});

	it('buttons carry data-flx attributes and accessible names', () => {
		show(messageWith(ROSTER_ROWS));

		for (const element of container.querySelectorAll('*')) {
			expect(element.getAttribute('data-flx'), element.outerHTML).toBeTruthy();
		}
		expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Join', 'Leave', 'micup']);
		for (const img of container.querySelectorAll('img')) {
			expect(img.getAttribute('aria-hidden')).toBe('true');
		}
	});
});
