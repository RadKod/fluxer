// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {setupI18n} from '@lingui/core';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';

// Fluxer's own Button, not the stand-in in MessageComponents.test.tsx: its submitting guard is what drops the second click.
const commands = vi.hoisted(() => ({clickMessageComponent: vi.fn()}));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/messaging/commands/MessageComponentCommands', () => commands);
vi.mock('@app/features/messaging/utils/ReactionUtils', () => ({useEmojiURL: () => null}));

const {MessageComponents} = await import('@app/features/channel/components/MessageComponents');

it('with the real Button, a second click while the first is in flight sends no second request', async () => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	let finish = () => {};
	commands.clickMessageComponent.mockReturnValueOnce(
		new Promise<void>((resolve) => {
			finish = resolve;
		}),
	);
	const message = {
		id: '1300000000000000002',
		channelId: '1300000000000000003',
		components: [
			{
				type: 1,
				components: [{type: 2, style: 3, label: 'Join', emoji: null, custom_id: 'roster:join', disabled: false}],
			},
		],
	} as unknown as Message;
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(createElement(MessageComponents, {message, isPreview: false})));
	const join = container.querySelector('button')!;

	act(() => join.click());
	act(() => join.click());
	expect(commands.clickMessageComponent).toHaveBeenCalledTimes(1);

	await act(async () => finish());
	act(() => join.click());
	expect(commands.clickMessageComponent).toHaveBeenCalledTimes(2);

	act(() => root.unmount());
	container.remove();
});
