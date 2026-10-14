// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {MessageViewContextValue} from '@app/features/channel/components/MessageViewContext';
import type {UserPrivate} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (d: {message: string}) => d.message, locale: 'en'}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => null,
		isSelfHosted: () => true,
		inviteUrlBase: 'https://micup.test/invite',
		giftUrlBase: 'https://micup.test/gift',
		webAppBaseUrl: 'https://micup.test',
		marketingEndpoint: 'https://micup.test',
		mediaEndpoint: 'https://media.micup.test/',
		staticCdnEndpoint: 'https://static.micup.test',
	},
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static create = () => new this();
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup-test-account', userId: '1200000000000000003'},
}));
// libfluxcore and the markdown parser are Rust compiled to WASM and exist only after `wasm:codegen` (Linux, KL7).
vi.mock('@app/features/messaging/utils/markdown/parser/MarkdownParserWasm', () => ({
	preloadMarkdownParserWasm: async () => {},
	parseMarkdownAstWithWasm: () => ({nodes: []}),
}));
vi.mock('@app/features/platform/utils/LibFluxcore', () => ({
	isLibfluxcoreReady: () => false,
	ensureLibfluxcoreReady: async () => {},
}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {layoutFor: () => null, frontFor: () => null},
}));
vi.mock('@app/features/messaging/utils/ImageCacheUtils', () => ({loadImage: () => () => {}}));
// The avatar itself has its own tests; here it only shows what it draws behind and over the avatar.
vi.mock('@app/features/ui/components/BaseAvatar', () => ({
	BaseAvatar: ({underlay}: {underlay?: React.ReactNode}) => createElement('span', {'data-slot': 'under'}, underlay),
}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	PreloadableUserPopout: ({children}: {children: React.ReactNode}) => children,
}));
// Everything around the avatar is out of scope for this test.
vi.mock('@app/features/channel/components/MessageUsername', () => ({MessageUsername: () => null}));
vi.mock('@app/features/channel/components/TimestampWithTooltip', () => ({
	TimestampWithTooltip: () => null,
}));
vi.mock('@app/features/channel/components/MessageTimeoutIndicator', () => ({MessageTimeoutIndicator: () => null}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({VerifiedUserBadge: () => null}));
vi.mock('@app/features/channel/components/ReplyPreview', () => ({ReplyPreview: () => null}));
vi.mock('@app/features/channel/components/MessageAttachments', () => ({MessageAttachments: () => null}));
vi.mock('@app/features/channel/components/EditingMessageInput', () => ({EditingMessageInput: () => null}));
vi.mock('@app/features/messaging/components/markdown', () => ({SafeMarkdown: () => null}));
vi.mock('@app/features/messaging/components/markdown/renderers', () => ({parse: () => ({nodes: []})}));

// The message imports stores that read the page bootstrap at import time.
(window as unknown as {__FLUXER_BOOTSTRAP__: unknown}).__FLUXER_BOOTSTRAP__ = {
	instance: {app_public: {branding: {product_name: 'sanalyer'}}},
	config: {releaseChannel: 'stable', bootstrapApiEndpoint: 'https://micup.test/api'},
	geoip: {
		countryCode: 'TR',
		regionCode: null,
		latitude: null,
		longitude: null,
		ageRestrictedGeos: [],
		ageBlockedGeos: [],
	},
};

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {UserMessage} = await import('@app/features/channel/components/UserMessage');
const {MessageViewContextProvider} = await import('@app/features/channel/components/MessageViewContext');
const {Channel} = await import('@app/features/channel/models/Channel');
const {Message} = await import('@app/features/messaging/models/MessagingMessage');
const {User} = await import('@app/features/user/models/User');
const {default: Users} = await import('@app/features/user/state/Users');
const {MessagePreviewContext, MessageStates, MessageTypes} = await import('@fluxer/constants/src/ChannelConstants');

const ULTRA = {asset: '9a8b7c6d', item_id: '1300000000000000009'};
const ME = {
	id: '1200000000000000003',
	username: 'ayse',
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
	email: 'ayse@micup.test',
} as UserPrivate;

const channel = new Channel({
	id: '1000000000000000051',
	type: 0,
	name: 'shop-preview',
	position: 0,
	parent_id: null,
	topic: null,
	url: null,
	nsfw: false,
	last_message_id: null,
	last_pin_timestamp: null,
	bitrate: null,
	user_limit: null,
	permission_overwrites: [],
});
const message = new Message(
	{
		id: '1000000000000000052',
		channel_id: channel.id,
		author: ME,
		type: MessageTypes.DEFAULT,
		flags: 0,
		pinned: false,
		mention_everyone: false,
		content: 'Hey, look at my new look!',
		timestamp: new Date('2026-09-28T20:00:00Z').toISOString(),
		state: MessageStates.SENT,
	},
	{skipUserCache: true},
);

describe('UserMessage preview author', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Users.handleGatewayReady('micup-test-account', ME);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (previewOverrides?: MessageViewContextValue['previewOverrides']) => {
		const value: MessageViewContextValue = {
			channel,
			message,
			shouldGroup: false,
			isHovering: false,
			messageDisplayCompact: false,
			previewContext: MessagePreviewContext.SETTINGS,
			previewOverrides,
			handleDelete: () => {},
		};
		act(() => root.render(createElement(MessageViewContextProvider, {value}, createElement(UserMessage))));
	};
	const ultraSource = () => container.querySelector('[data-slot="under"] img')?.getAttribute('src') ?? null;

	it('a settings preview draws the author it is given instead of the stored user', () => {
		render({author: new User({...ME, avatar_ultra_data: ULTRA})});
		expect(ultraSource() ?? 'no ultra layer').toContain('cosmetic-avatar_ultra-1300000000000000009');
	});

	it('without the override nothing changes', () => {
		render();
		expect(container.querySelector('[data-slot="under"]')).not.toBeNull();
		expect(ultraSource()).toBeNull();
	});
});
