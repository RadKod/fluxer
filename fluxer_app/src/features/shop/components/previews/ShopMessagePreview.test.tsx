// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Message} from '@app/features/channel/components/ChannelMessage';
import type {User} from '@app/features/user/models/User';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type MessageProps = React.ComponentProps<typeof Message>;
const drawn = vi.hoisted(() => [] as Array<MessageProps>);
const channels = vi.hoisted(() => ({handleChannelCreate: vi.fn(), handleChannelDelete: vi.fn()}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/channel/state/Channels', () => ({default: channels}));
vi.mock('@app/features/channel/models/Channel', () => ({
	Channel: class {
		constructor(private readonly data: {id: string}) {}
		toJSON() {
			return this.data;
		}
	},
}));
// The message itself has its own tests (UserMessage.previewAuthor.test.tsx); here it only records what it is given.
vi.mock('@app/features/channel/components/ChannelMessage', () => ({
	Message: (props: MessageProps) => {
		drawn.push(props);
		return null;
	},
}));
vi.mock('@app/features/messaging/models/MessagingMessage', () => ({
	Message: class {
		id: string;
		content: string;
		author: {id: string};
		constructor(data: {id: string; content: string; author: {id: string}}) {
			this.id = data.id;
			this.content = data.content;
			this.author = data.author;
		}
	},
}));

const {ShopMessagePreview} = await import('@app/features/shop/components/previews/ShopMessagePreview');
// The user model pulls in most of the app; the preview only hands the user on and writes it into the messages.
const user = {
	id: '1200000000000000003',
	toJSON: () => ({id: '1200000000000000003', username: 'ayse'}),
} as unknown as User;

describe('ShopMessagePreview', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		drawn.length = 0;
		vi.clearAllMocks();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		container.remove();
	});

	it('draws two comfy messages by the preview user, the second under the first, in a channel that lives while shown', () => {
		act(() => root.render(createElement(ShopMessagePreview, {user})));
		const last = drawn.slice(-2);
		expect(last.map((props) => props.message.content)).toEqual(['Hey, look at my new look!', 'Nice, right?']);
		expect(last.map((props) => props.shouldGroup)).toEqual([false, true]);
		for (const props of last) {
			expect(props.compact).toBe(false);
			expect(props.previewContext).toBe('SETTINGS');
			expect(props.previewOverrides?.author).toBe(user);
			expect(props.message.author.id).toBe(user.id);
		}
		expect(channels.handleChannelCreate).toHaveBeenCalledTimes(1);
		act(() => root.unmount());
		expect(channels.handleChannelDelete).toHaveBeenCalledTimes(1);
	});
});
