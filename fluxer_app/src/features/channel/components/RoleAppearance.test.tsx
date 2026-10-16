// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type {GuildEmoji} from '@app/features/expressions/models/GuildEmoji';
import {RoleIcon, roleColorOnDarkHex} from '@app/features/guild/components/RoleAppearance';
import roleAppearanceClasses from '@app/features/guild/components/RoleAppearance.module.css';
import type {Guild} from '@app/features/guild/models/Guild';
import {GuildRole} from '@app/features/guild/models/GuildRole';
import type {GuildMember} from '@app/features/member/models/GuildMember';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import nameStyleClasses from '@app/features/name_style/components/NameStyleText.module.css';
import {mountCssModule} from '@app/features/name_style/testing/CssModuleSheet';
import {ComponentBus} from '@app/features/platform/utils/ComponentBus';
import type {User} from '@app/features/user/models/User';
import {act, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	emoji: undefined as {id: string; guildId: string; animated: boolean} | undefined,
	guildEmojis: [] as Array<GuildEmoji>,
	grouped: false,
	member: null as GuildMember | null,
}));
const requests = vi.hoisted(() => ({
	post: vi.fn(async (_url: string, _options: unknown) => ({body: {id: '400'}})),
	patch: vi.fn(async (_url: string, _options: unknown) => ({})),
}));
const editor = vi.hoisted(() => ({
	guild: null as Guild | null,
	entitled: true,
	dirty: false,
	save: null as (() => Promise<void>) | null,
	reset: null as (() => void) | null,
	duplicate: null as ((id: string) => Promise<void>) | null,
}));
vi.mock('@app/features/analytics/commands/AnalyticsCommands', () => ({}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => editor.guild}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({noteText: () => {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {resolve: () => (editor.entitled ? 1 : 0)},
}));
vi.mock('@app/features/app/components/alerts/RoleCreateFailedModal', () => ({RoleCreateFailedModal: () => null}));
vi.mock('@app/features/app/components/alerts/RoleDeleteFailedModal', () => ({RoleDeleteFailedModal: () => null}));
vi.mock('@app/features/app/components/alerts/RoleNameBlankModal', () => ({RoleNameBlankModal: () => null}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/guild/components/alerts/GuildErrorModalUtils', () => ({showGuildErrorModal: () => {}}));
vi.mock('@app/features/guild/components/modals/guild_tabs/guild_roles_tab/MobileRoleList', () => ({
	MobileRoleList: () => null,
}));
vi.mock('@app/features/guild/components/modals/guild_tabs/guild_roles_tab/RoleSidebar', () => ({
	RoleSidebar: () => null,
}));
vi.mock('@app/features/moderation/components/alerts/RoleUpdateFailedModal', () => ({
	RoleUpdateFailedModal: () => null,
}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => null}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => true}}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => true}}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (fn: unknown) => fn}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/ui/commands/UnsavedChangesCommands', () => ({
	setUnsavedChanges: (_id: string, dirty: boolean) => {
		editor.dirty = dirty;
	},
	clearUnsavedChanges: vi.fn(),
	setTabData: (_id: string, data: {onSave: () => Promise<void>; onReset: () => void}) => {
		editor.save = data.onSave;
		editor.reset = data.onReset;
	},
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
vi.mock('@app/features/ui/state/SettingsSidebar', () => ({
	default: {
		hasOverride: false,
		ownerId: 'guild-roles-100',
		setOverride: (_id: string, content: ReactElement<{onDuplicateRole: (id: string) => Promise<void>}>) => {
			editor.duplicate = content.props.onDuplicateRole;
		},
		updateOverride: (_id: string, content: ReactElement<{onDuplicateRole: (id: string) => Promise<void>}>) => {
			editor.duplicate = content.props.onDuplicateRole;
		},
		clearOverride: vi.fn(),
	},
}));
vi.mock('@app/features/invite/state/Invites', () => ({default: {}}));
vi.mock('@app/features/platform/transport/InstanceHTTP', () => ({currentInstanceTarget: () => ({})}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: requests}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
		error() {}
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react', () => ({useLingui: () => ({i18n: {locale: 'en'}})}));
vi.mock('@phosphor-icons/react', () => ({
	GridFourIcon: () => null,
	ListIcon: () => null,
	MagnifyingGlassIcon: () => null,
	RowsIcon: () => null,
	TrashIcon: () => null,
	CrownIcon: () => null,
}));
vi.mock('@app/features/game_activity/hooks/useGameActivity', () => ({useGameActivity: () => null}));
vi.mock('@app/features/game_activity/components/GameActivityRowStatus', () => ({GameActivityRowStatus: () => null}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/hooks/useContextMenuHoverState', () => ({useContextMenuHoverState: () => false}));
vi.mock('@app/features/channel/components/MessageViewContext', () => ({useMaybeMessageViewContext: () => null}));
vi.mock('@app/features/channel/components/CrosspostCommunityPopout', () => ({
	CrosspostCommunityPopout: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	PreloadableUserPopout: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: () => 'Ada'}));
vi.mock('@app/features/emoji/state/Emoji', () => ({
	default: {getEmojiById: () => state.emoji, getGuildEmoji: () => state.guildEmojis},
}));
vi.mock('@app/features/expressions/utils/CustomEmojiImageUrl', () => ({
	buildCustomEmojiURL: ({id, animated}: {id: string; animated: boolean}) => `/emoji/${id}.${animated ? 'gif' : 'webp'}`,
}));
vi.mock('@app/features/app/components/dialogs/shared/PermissionComponents', () => ({
	PermissionRoleCategory: () => null,
	sortRolesByPosition: (roles: Array<GuildRole>) => roles,
}));
vi.mock('@app/features/permissions/state/PermissionLayout', () => ({default: {}}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, disabled, onClick}: {children: ReactNode; disabled?: boolean; onClick?: () => void}) =>
		createElement('button', {type: 'button', disabled, onClick}, children),
}));
vi.mock('@app/features/ui/components/form/ColorPickerField', () => ({
	ColorPickerField: ({label, disabled}: {label: string; disabled?: boolean}) =>
		createElement('input', {'aria-label': label, disabled}),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: ({label, disabled}: {label: string; disabled?: boolean}) =>
		createElement('input', {'aria-label': label, disabled}),
}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({Switch: () => null}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({
	Combobox: ({
		label,
		disabled,
		options,
	}: {
		label: string;
		disabled?: boolean;
		options: Array<{value: string | null; label: string}>;
	}) =>
		createElement(
			'select',
			{'aria-label': label, disabled},
			options.map((option) =>
				createElement('option', {key: option.value ?? 'none', value: option.value ?? ''}, option.label),
			),
		),
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/channel/components/ChannelUserTag', () => ({UserTag: () => null}));
vi.mock('@app/features/channel/components/CompactMemberCustomStatus', () => ({
	CompactMemberCustomStatus: () => null,
	hasVisibleCompactMemberCustomStatus: () => false,
}));
vi.mock('@app/features/cosmetics/components/NameplateBackground', () => ({
	NameplateBackground: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/member/hooks/useMemberListCustomStatus', () => ({useMemberListCustomStatus: () => null}));
vi.mock('@app/features/member/hooks/useMemberListPresence', () => ({
	useMemberListPresence: () => 'online',
	resolveMemberListPresence: () => 'online',
}));
vi.mock('@app/features/presence/state/MemberPresenceSubscription', () => ({
	default: {setVisibleMembers: () => {}, touchMember: () => {}},
}));
vi.mock('@app/features/typing/state/TypingIndicator', () => ({default: {isMemberListTyping: () => false}}));
vi.mock('@app/features/ui/action_menu/GroupDMContextMenu', () => ({GroupDMMemberContextMenu: () => null}));
vi.mock('@app/features/ui/action_menu/GuildMemberContextMenu', () => ({GuildMemberContextMenu: () => null}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/components/FocusRingWrapper', () => ({
	FocusRingWrapper: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/ui/components/StatusAwareAvatar', () => ({ListStatusAwareAvatar: () => null}));
vi.mock('@app/features/ui/hooks/useTextOverflow', () => ({useTextOverflow: () => false}));
vi.mock('@app/features/user/components/PremiumUserBadge', () => ({PremiumUserBadge: () => null}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({VerifiedUserBadge: () => null}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({getGuildMemberDisplayAvatarURL: () => null}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {zoomLevel: 1}}));
vi.mock('@app/features/app/components/layout/OutlineFrame', () => ({
	OutlineFrame: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/components/skeleton/SkeletonLayoutMemory', () => ({
	getRememberedSkeletonMemberGroups: () => [],
	reportSkeletonMemberLayout: vi.fn(),
	SKELETON_UNMEASURED_WIDTH_PX: 0,
	SkeletonMemberSurfaceKind: {GUILD: 'guild', GUILD_VOICE: 'voice'},
}));
vi.mock('@app/features/app/hooks/useSkeletonLayoutMemoryCapture', () => ({useSkeletonLayoutReport: () => {}}));
vi.mock('@app/features/channel/components/MemberListContainer', () => ({
	MemberListContainer: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/channel/components/MemberListSkeleton', () => ({
	MemberListSkeleton: () => null,
	MemberListSkeletonRow: () => null,
	MemberListSkeletonVariant: {GUILD: 'guild'},
}));
vi.mock('@app/features/channel/components/shared/MemberListUnavailableFallback', () => ({
	MemberListUnavailableFallback: () => null,
}));
vi.mock('@app/features/member/hooks/useMemberListSubscription', () => ({
	useMemberListSubscription: () => ({subscribe: vi.fn()}),
}));
vi.mock('@app/features/member/state/MemberSidebar', () => ({
	default: {
		getListIdentityKey: () => '100:300',
		getList: () => ({
			memberCount: 1,
			groups: state.grouped ? [{id: 'online', count: 1}] : [],
			hasReceivedInitialPayload: true,
			subscribedRanges: [[0, 64]],
			items: new Map([[state.grouped ? 1 : 0, {}]]),
		}),
		materializeItemMember: () => state.member,
		isMobile: () => null,
	},
}));
vi.mock('@app/features/member/utils/MemberListUtils', () => ({}));
vi.mock('@app/features/permissions/utils/PermissionUtils', () => ({
	can: () => true,
	formatPermissionLabel: () => 'Permission',
	computePermissions: () => 0n,
	generatePermissionSpec: () => [],
}));
vi.mock('@app/features/presence/state/Presence', () => ({default: {}}));
vi.mock('@app/features/ui/action_menu/RoleContextMenu', () => ({}));
vi.mock('@app/features/ui/utils/AppZoomUtils', () => ({getAppRemScale: () => 1}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {id: 'me'}}}));

import {createRole, updateRole} from '@app/features/guild/commands/GuildCommands';
import GuildRolesTab from '@app/features/guild/components/modals/guild_tabs/GuildRolesTab';
import {RoleEditor} from '@app/features/guild/components/modals/guild_tabs/guild_roles_tab/RoleEditor';
import {applyRoleUpdate} from '@app/features/guild/components/modals/guild_tabs/guild_roles_tab/shared';
import {ChannelMembers} from './ChannelMembers';
import {MessageUsername} from './MessageUsername';

const colorRole = {color: 0x112233, colorSecondary: 0x445566} as GuildRole;
const iconRole = {guildId: '100', iconEmojiId: '800', unicodeEmoji: null} as GuildRole;
const member = {
	user: {id: '200'},
	isAvatarUnset: () => false,
	getColorString: () => '#112233',
	getColorRole: () => colorRole,
	getIconRole: () => iconRole,
} as unknown as GuildMember;

function renderUsername(previewColor?: string): string {
	return renderToStaticMarkup(
		createElement(MessageUsername, {
			user: {id: '200'} as User,
			message: {channelId: '300'} as Message,
			guild: {id: '100'} as Guild,
			member,
			className: 'username',
			isPreview: false,
			previewColor,
		}),
	);
}

describe('role appearance in message usernames', () => {
	beforeEach(() => {
		state.emoji = {id: '800', guildId: '100', animated: true};
	});
	it('renders the selected color role pair and a static custom icon', () => {
		const html = renderUsername();
		expect(html).toContain('--role-color-secondary:#445566');
		expect(html).toContain('/emoji/800.webp');
		expect(html).not.toContain('.gif');
	});
	it('keeps a deleted or foreign emoji empty', () => {
		state.emoji = undefined;
		expect(renderUsername()).not.toContain('<img');
		state.emoji = {id: '800', guildId: '999', animated: false};
		expect(renderUsername()).not.toContain('<img');
	});
	it('gives a role colour that fails the dark floor a lifted dark-theme colour and keeps the stored one', () => {
		const html = renderUsername();
		expect(html).toContain('--role-color:#112233');
		expect(html).toMatch(/--role-color-on-dark:#[0-9a-f]{6}/);
		expect(html).toMatch(/--role-color-secondary-on-dark:#[0-9a-f]{6}/);
		expect(html).toContain(roleAppearanceClasses.colored);
		expect(renderUsername('#ffc83d')).not.toContain('--role-color-on-dark');
	});
	it('draws the lifted colour only under a dark theme class', () => {
		document.head.querySelectorAll('style').forEach((sheet) => sheet.remove());
		mountCssModule('src/features/guild/components/RoleAppearance.module.css', roleAppearanceClasses);
		const html = document.documentElement;
		// happy-dom keeps a computed style across a class change on <html>, so each theme renders afresh.
		const colorUnder = (theme: string) => {
			html.className = theme;
			document.body.innerHTML = renderUsername('#212121');
			return getComputedStyle(document.body.querySelector(`.${roleAppearanceClasses.colored}`)!).color;
		};
		try {
			expect(colorUnder('theme-light')).toBe('#212121');
			for (const theme of ['theme-coal', 'theme-dark', 'theme-dark_legacy']) {
				expect(colorUnder(theme)).toBe(roleColorOnDarkHex('#212121'));
			}
		} finally {
			html.className = '';
			document.body.innerHTML = '';
		}
	});
	it('preserves the preview color override without the member gradient', () => {
		const html = renderUsername('#abcdef');
		expect(html).toContain('#abcdef');
		expect(html).not.toContain('--role-color-secondary');
	});
	it('draws the Plus colours over a colour role that paints the name', () => {
		const html = renderStyledUsername(member);
		expect(html).toContain('data-name-style=');
		expect(html).toContain('--name-style-1:#ff0000');
		expect(html).toContain('--name-style-2:#00ff00');
		expect(html).toContain('--role-color-secondary:#445566');
	});
	it("draws only the font when the Plus colours could pass for one of the guild's coloured roles", () => {
		const html = renderStyledUsername(member, {id: '100', roles: {mod: {color: 0xff0000}}} as unknown as Guild);
		expect(html).toContain('data-name-style=');
		expect(html).not.toContain('--name-style-1');
	});
	it("fills the Plus colours over the name's inline role colour and its role gradient", () => {
		// The role span takes the name's fill through `inherit`, which happy-dom ignores on the stand-in property; that
		// the role span's own gradient gives way shows the rule reaches it.
		const solid = mountStyledUsername(member, [0xff0000]);
		expect(solid.firstElementChild!.getAttribute('style')).toContain('color:#112233');
		expect(fill(solid)).toBe('#ff0000');
		expect(getComputedStyle(solid.firstElementChild!).backgroundImage).toBe('none');
		const gradient = mountStyledUsername(member);
		expect(getComputedStyle(gradient).backgroundImage).toBe('linear-gradient(90deg, #ff0000, #00ff00)');
		expect(fill(gradient)).toBe('transparent');
		expect(getComputedStyle(gradient.firstElementChild!).backgroundImage).toBe('none');
	});
	it('draws the Plus colours with the role icon inside when no colour role paints the name', () => {
		const iconOnly = {
			...member,
			getColorString: () => undefined,
			getColorRole: () => undefined,
			getIconRole: () => ({guildId: '100', iconEmojiId: null, unicodeEmoji: '⭐'}) as GuildRole,
		} as unknown as GuildMember;
		const html = renderStyledUsername(iconOnly);
		expect(html).toContain('--name-style-1:#ff0000');
		expect(html).toContain('--name-style-2:#00ff00');
		expect(html).toContain('⭐');
	});
	it('keeps the role icon in its own colours inside a gradient-clipped name', () => {
		const name = mountStyledUsername({
			...member,
			getIconRole: () => ({guildId: '100', iconEmojiId: null, unicodeEmoji: '⭐'}) as GuildRole,
		} as unknown as GuildMember);
		expect(fill(name)).toBe('transparent');
		expect(fill(name.querySelector('[aria-hidden="true"]')!)).toBe('currentColor');
	});
});

const fill = (element: Element) => getComputedStyle(element).getPropertyValue('--webkit-text-fill-color').trim();

// The styled name in the document with the two style sheets it is drawn with.
function mountStyledUsername(styledMember: GuildMember, colors?: ReadonlyArray<number>): Element {
	document.head.querySelectorAll('style').forEach((sheet) => sheet.remove());
	mountCssModule('src/features/name_style/components/NameStyleText.module.css', nameStyleClasses);
	mountCssModule('src/features/guild/components/RoleAppearance.module.css', roleAppearanceClasses);
	document.body.innerHTML = renderStyledUsername(styledMember, undefined, colors);
	return document.body.querySelector('[data-name-style]')!;
}

function renderStyledUsername(
	styledMember: GuildMember,
	guild = {id: '100'} as Guild,
	colors: ReadonlyArray<number> = [0xff0000, 0x00ff00],
): string {
	return renderToStaticMarkup(
		createElement(MessageUsername, {
			user: {id: '200', nameStyle: {font_id: 1, colors}} as unknown as User,
			message: {channelId: '300'} as Message,
			guild,
			member: styledMember,
			className: 'username',
			isPreview: false,
		}),
	);
}

describe('role editor draft', () => {
	it('carries explicit clears to the role model', () => {
		const withUpdates = vi.fn();
		const role = {
			name: 'Member',
			color: 1,
			colorSecondary: 2,
			iconEmojiId: '800',
			unicodeEmoji: null,
			permissions: 0n,
			withUpdates,
		} as unknown as GuildRole;
		applyRoleUpdate(role, {id: '400', colorSecondary: null, iconEmojiId: null, unicodeEmoji: null});
		expect(withUpdates).toHaveBeenCalledWith(
			expect.objectContaining({color_secondary: null, icon_emoji_id: null, unicode_emoji: null}),
		);
	});
});

describe('role editor entitlement controls', () => {
	function renderEditor(canSetRoleIcons: boolean, canSetRoleGradient: boolean): string {
		const role = {
			id: '400',
			guildId: '100',
			name: 'Member',
			color: 0x112233,
			colorSecondary: 0x445566,
			unicodeEmoji: '⭐',
			iconEmojiId: null,
			permissions: 0n,
		} as GuildRole;
		return renderToStaticMarkup(
			createElement(RoleEditor, {
				rolesScrollerKey: 'roles',
				isMobile: false,
				selectedRole: role,
				selectedRoleWithUpdates: role,
				selectedRoleLocked: false,
				canManageRoles: true,
				canSetRoleIcons,
				canSetRoleGradient,
				mentionEveryonePermissionLabel: 'Mention everyone',
				permissionSearchQuery: '',
				filteredPermissionSpecs: [],
				onMobileBack: vi.fn(),
				onDeleteRole: vi.fn(),
				onRoleUpdate: vi.fn(),
				onClearPermissions: vi.fn(),
				onPermissionToggle: vi.fn(),
				onPermissionSearchQueryChange: vi.fn(),
				getPermissionDisabledReason: () => undefined,
				getPermissionWarning: () => undefined,
			}),
		);
	}
	it('locks new assignments after downgrade but allows clearing saved appearance', () => {
		const html = renderEditor(false, false);
		expect(html).toContain('aria-label="Second role color" disabled=""');
		expect(html).toContain('aria-label="Unicode role icon" disabled=""');
		expect(html).toContain('<button type="button">Remove role gradient</button>');
		expect(html).toContain('<button type="button">Remove role icon</button>');
		expect(html).toContain('Server Boost Level 1');
		expect(html).toContain('Server Boost Level 2');
	});
	it('enables both appearance controls when their entitlements are available', () => {
		const html = renderEditor(true, true);
		expect(html).toContain('aria-label="Second role color"/>');
		expect(html).toContain('aria-label="Unicode role icon"/>');
	});
});

describe('role appearance requests', () => {
	it('serializes appearance when creating or duplicating a role', async () => {
		await createRole('100', 'Member copy', {
			color: 0x112233,
			colorSecondary: 0x445566,
			iconEmojiId: '800',
			unicodeEmoji: null,
		});
		expect(requests.post).toHaveBeenLastCalledWith(expect.anything(), {
			body: expect.objectContaining({color_secondary: 0x445566, icon_emoji_id: '800', unicode_emoji: null}),
		});
	});
	it('preserves explicit nulls in update requests', async () => {
		await updateRole('100', '400', {color_secondary: null, icon_emoji_id: null, unicode_emoji: null});
		expect(requests.patch).toHaveBeenLastCalledWith(expect.anything(), {
			body: {color_secondary: null, icon_emoji_id: null, unicode_emoji: null},
		});
	});
});

describe('role appearance in both member list branches', () => {
	it.each([false, true])('renders the same color pair and static icon with grouped=%s', (grouped) => {
		state.grouped = grouped;
		state.member = member;
		state.emoji = {id: '800', guildId: '100', animated: true};
		const html = renderToStaticMarkup(
			createElement(ChannelMembers, {
				guild: {id: '100', disabledOperations: 0, isOwner: () => false} as unknown as Guild,
				channel: {id: '300', type: 0, toJSON: () => ({})} as unknown as Channel,
			}),
		);
		expect(html).toContain('--role-color:#112233;--role-color-secondary:#445566');
		expect(html).toContain('/emoji/800.webp');
		expect(html).not.toContain('.gif');
	});
});

describe('mounted role emoji lifecycle', () => {
	it('removes a deleted icon on the real emoji event without replacing its role prop', async () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.emoji = {id: '800', guildId: '100', animated: true};
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(RoleIcon, {role: iconRole})));
			expect(container.querySelector('img')).not.toBeNull();
			state.emoji = undefined;
			await act(async () => ComponentBus.dispatch('EMOJI_PICKER_RERENDER'));
			expect(container.querySelector('img')).toBeNull();
			state.emoji = {id: '800', guildId: '100', animated: false};
			await act(async () => ComponentBus.dispatch('EMOJI_PICKER_RERENDER'));
			expect(container.querySelector('img')).not.toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});
	it('shares one event subscription and releases it after the final icon unmounts', async () => {
		const baseline = ComponentBus.listenerCount('EMOJI_PICKER_RERENDER');
		const root = createRoot(document.createElement('div'));
		try {
			await act(async () =>
				root.render([
					createElement(RoleIcon, {key: 'one', role: iconRole}),
					createElement(RoleIcon, {key: 'two', role: iconRole}),
				]),
			);
			expect(ComponentBus.listenerCount('EMOJI_PICKER_RERENDER')).toBe(baseline + 1);
			await act(async () => root.render([createElement(RoleIcon, {key: 'one', role: iconRole})]));
			expect(ComponentBus.listenerCount('EMOJI_PICKER_RERENDER')).toBe(baseline + 1);
		} finally {
			await act(async () => root.unmount());
		}
		expect(ComponentBus.listenerCount('EMOJI_PICKER_RERENDER')).toBe(baseline);
	});
});

describe('role settings save and duplicate flow', () => {
	async function withTab(run: (container: HTMLDivElement) => Promise<void>) {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const role = new GuildRole('100', {
			id: '401',
			name: 'Member',
			color: 0x112233,
			color_secondary: 0x445566,
			icon_emoji_id: '800',
			unicode_emoji: null,
			position: 1,
			permissions: '0',
			hoist: false,
			mentionable: false,
		});
		editor.guild = {id: '100', roles: {'401': role}, isOwner: () => true, toJSON: () => ({})} as unknown as Guild;
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(GuildRolesTab, {guildId: '100'})));
			await run(container);
		} finally {
			await act(async () => root.unmount());
			editor.guild = null;
			editor.entitled = true;
		}
	}
	it('marks an explicit clear dirty, saves null, and resets the dirty state', async () => {
		await withTab(async (container) => {
			expect(editor.dirty).toBe(false);
			const clear = Array.from(container.querySelectorAll('button')).find(
				(button) => button.textContent === 'Remove role gradient',
			);
			expect(clear).toBeDefined();
			await act(async () => clear!.click());
			expect(editor.dirty).toBe(true);
			await act(async () => editor.save!());
			expect(requests.patch).toHaveBeenLastCalledWith('/guilds/100/roles/401', {body: {color_secondary: null}});
			expect(editor.dirty).toBe(false);
		});
	});
	it('refreshes server emoji choices when the real emoji event removes an option', async () => {
		state.guildEmojis = [{id: '800', name: 'wave', guildId: '100'} as GuildEmoji];
		await withTab(async (container) => {
			expect(container.querySelector('option[value="800"]')).not.toBeNull();
			state.guildEmojis = [];
			await act(async () => ComponentBus.dispatch('EMOJI_PICKER_RERENDER'));
			expect(container.querySelector('option[value="800"]')).toBeNull();
		});
	});
	it.each([true, false])('duplicates appearance only with current assignment rights: %s', async (entitled) => {
		editor.entitled = entitled;
		await withTab(async () => {
			await act(async () => editor.duplicate!('401'));
			const body = requests.post.mock.calls.at(-1)?.[1] as {body: Record<string, unknown>} | undefined;
			expect(body?.body.color_secondary).toBe(entitled ? 0x445566 : undefined);
			expect(body?.body.icon_emoji_id).toBe(entitled ? '800' : undefined);
		});
	});
});
