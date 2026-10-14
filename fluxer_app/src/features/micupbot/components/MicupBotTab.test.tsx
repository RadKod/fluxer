// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {GUILD_ID, responseFor, settingsResponse} from '@app/features/micupbot/testing/MicupBotTestData';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {MicupBotSettingsResponse} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
import {
	act,
	type ButtonHTMLAttributes,
	createElement,
	type InputHTMLAttributes,
	type TextareaHTMLAttributes,
} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/core', () => ({
	i18n: {
		_: (descriptor: {message: string}, values: Record<string, unknown> = {}) =>
			descriptor.message.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token)),
	},
}));
vi.mock('@lingui/react/macro', async () => {
	const {i18n} = await import('@lingui/core');
	return {useLingui: () => ({i18n})};
});
const http = {
	get: vi.fn<(path: string, options?: unknown) => Promise<{body: unknown}>>(),
	patch: vi.fn(),
	put: vi.fn(),
	post: vi.fn(),
	delete: vi.fn(),
};
const authorize = {openOAuthAuthorizeModalFromUrl: vi.fn((_url: string) => false)};
const permissions = {canModerate: true, canManageMessages: true};
const searchGuildMembers = vi.fn(async () => ({members: [{user_id: '123', username: 'Member'}]}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/auth/commands/OAuthAuthorizeModalCommands', () => authorize);
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {
		getGuildChannels: () => [
			{id: '123', name: 'Text channel', type: 0},
			{id: '124', name: 'Voice channel', type: 2},
		],
	},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {
		getGuildRoles: () => [
			{id: GUILD_ID, name: '@everyone'},
			...Array.from({length: 6}, (_, i) => ({id: String(i + 1), name: `Role ${i + 1}`})),
		],
	},
}));
vi.mock('@app/features/permissions/state/Permission', () => ({
	default: {
		can: (permission: bigint) =>
			permission === Permissions.MODERATE_MEMBERS
				? permissions.canModerate
				: permission !== Permissions.MANAGE_MESSAGES || permissions.canManageMessages,
	},
}));
vi.mock('@app/features/ui/state/Modal', () => ({default: {hasModal: () => false}}));
vi.mock('@app/features/emoji/components/popouts/EmojiPickerPopout', () => ({
	EmojiPickerPopout: ({handleSelect}: {handleSelect: (emoji: object) => void}) =>
		createElement(
			'button',
			{
				type: 'button',
				onClick: () => handleSelect({name: 'thumbsup', uniqueName: 'thumbsup', surrogates: '👍', hasSkinTones: true}),
			},
			'Pick thumbs up',
		),
}));
vi.mock('@app/app/I18n', async () => ({default: (await import('@lingui/core')).i18n}));
vi.mock('@app/features/app/hooks/useShouldAnimate', () => ({useShouldAnimate: () => false}));
vi.mock('@app/features/emoji/state/Emoji', () => ({default: {skinTone: 'tone3'}}));
vi.mock('@app/features/expressions/utils/UnicodeEmojis', () => ({
	default: {findEmojiWithSkinTone: () => ({surrogates: '👍🏽'})},
}));
vi.mock('@app/features/expressions/utils/EmojiUtils', () => ({}));
vi.mock('@app/features/expressions/utils/CustomEmojiImageUrl', () => ({}));
vi.mock('@app/features/messaging/state/MessageReactions', () => ({default: {}}));
const getNickname = vi.fn((user: {displayName: string}, _guildId?: string) =>
	user === users['789'] ? 'Mod Nick' : user.displayName,
);
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getTimeFormat: () => 2}}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'tr'}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useBrowserLocaleForTimeFormat: false}}));

vi.mock('@app/features/channel/components/guild_members_page/SearchApi', () => ({searchGuildMembers}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		variant: _variant,
		small: _small,
		submitting,
		...props
	}: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: string; small?: boolean; submitting?: boolean}) =>
		createElement('button', {type: 'button', ...props, disabled: props.disabled || submitting}),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: ({label, ...props}: InputHTMLAttributes<HTMLInputElement> & {label: string}) =>
		createElement('label', null, label, createElement('input', props)),
	Textarea: ({label, ...props}: TextareaHTMLAttributes<HTMLTextAreaElement> & {label: string}) =>
		createElement('label', null, label, createElement('textarea', props)),
}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({
	Switch: ({
		label,
		value,
		onChange,
		disabled,
	}: {
		label: string;
		value: boolean;
		onChange: (value: boolean) => void;
		disabled?: boolean;
	}) =>
		createElement(
			'label',
			null,
			createElement('input', {
				type: 'checkbox',
				role: 'switch',
				checked: value,
				disabled,
				onChange: (e: {currentTarget: HTMLInputElement}) => onChange(e.currentTarget.checked),
			}),
			label,
		),
}));
const users: Record<string, {displayName: string}> = {'789': {displayName: 'Moderator One'}};
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => users[id]}}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({
	Combobox: ({
		label,
		value,
		options,
		onChange,
		isMulti,
		disabled,
		error,
	}: {
		label: string;
		value: string | number | Array<string>;
		options: Array<{value: string | number; label: string; isDisabled?: boolean}>;
		onChange: (v: string | number | Array<string | number>) => void;
		isMulti?: boolean;
		disabled?: boolean;
		error?: string;
	}) =>
		createElement(
			'label',
			null,
			label,
			createElement(
				'select',
				{
					multiple: isMulti,
					value,
					disabled,
					onChange: (e: {currentTarget: HTMLSelectElement}) =>
						onChange(
							isMulti
								? Array.from(e.currentTarget.selectedOptions, (o) => options[o.index]!.value)
								: options[e.currentTarget.selectedIndex]!.value,
						),
				},
				options.map((o) => createElement('option', {key: o.value, value: o.value, disabled: o.isDisabled}, o.label)),
			),
			error && createElement('span', {role: 'note'}, error),
		),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {webAppBaseUrl: 'https://app.example.test'}}));
vi.mock('@phosphor-icons/react', () => ({RobotIcon: () => null, WarningIcon: () => null}));
const tab = await import('./MicupBotTab');
const {getFormattedDateTime} = await import('@app/features/user/utils/DateFormatting');

describe('MicupBotTab', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		vi.clearAllMocks();
		permissions.canManageMessages = true;
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	async function render(
		data: MicupBotSettingsResponse,
		canModerate = true,
		panelCount = 0,
		overrides: Record<string, unknown> = {},
	) {
		permissions.canModerate = canModerate;
		http.get.mockImplementation(async (path: string) => ({
			body:
				Object.entries(overrides).find(([suffix]) => path.includes(suffix))?.[1] ??
				(path.endsWith('/reaction-roles')
					? {
							panels: Array.from({length: panelCount}, (_, i) => ({
								message_id: String(i),
								channel_id: '123',
								title: 'Panel',
								mode: 'normal',
								description: null,
								entries: [],
							})),
							max_panels: 25,
						}
					: responseFor(path, data)),
		}));
		await act(async () => root.render(createElement(tab.default, {guildId: GUILD_ID})));
		return {http, authorize, tab, searchGuildMembers};
	}
	function button(text: string) {
		const node = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === text);
		expect(node).toBeDefined();
		return node!;
	}
	it('shows the off notice while feature_enabled is false', async () => {
		await render(settingsResponse({feature_enabled: false}));
		expect(container.textContent).toContain('The community bot is turned off.');
		expect(container.querySelector('form')).toBeNull();
	});
	it('shows Add bot while the bot is not in the community', async () => {
		const {authorize} = await render(settingsResponse({bot: {...settingsResponse().bot!, in_guild: false}}));
		await act(async () => button('Add bot').click());
		const url = new URL(authorize.openOAuthAuthorizeModalFromUrl.mock.calls[0]![0]);
		expect(url.searchParams.get('guild_id')).toBe(GUILD_ID);
		expect(url.searchParams.get('permissions')).toBe('1099780156480');
		expect(container.textContent).toContain("Move the bot's role above the roles it should give.");
	});
	it('warns when mfa_blocked', async () => {
		await render(settingsResponse({bot: {...settingsResponse().bot!, mfa_blocked: true}}));
		expect(container.textContent).toContain(
			'This community requires two-factor authentication for moderators; the bot cannot give roles, delete messages or time members out.',
		);
	});
	it('lists role_warnings', async () => {
		await render(settingsResponse({role_warnings: ['1']}));
		expect(container.querySelector('[data-flx="micupbot.micup-bot-tab.role-warning"]')?.textContent).toContain(
			'Role 1',
		);
	});
	it('disables Create panel at 25', async () => {
		await render(settingsResponse(), true, 25);
		await act(async () => button('Roles').click());
		expect(button('Create panel').disabled).toBe(true);
		expect(container.textContent).toContain('25/25');
	});
	it('limits auto roles to 5', async () => {
		await render(
			settingsResponse({settings: {...settingsResponse().settings, autorole_ids: ['1', '2', '3', '4', '5']}}),
		);
		await act(async () => button('Welcome').click());
		const select = Array.from(container.querySelectorAll('select')).find((node) => node.multiple)!;
		expect(Array.from(select.options).find((o) => o.value === '6')?.disabled).toBe(true);
		expect(Array.from(select.options).some((o) => o.value === GUILD_ID)).toBe(false);
	});
	it('hides Warnings without MODERATE_MEMBERS', async () => {
		const {http} = await render(settingsResponse(), false);
		expect(container.textContent).not.toContain('Warnings');
		expect(http.get.mock.calls.some(([path]) => path.includes('/warnings/'))).toBe(false);
	});
	it('shows the join message conflict hint', async () => {
		await render(settingsResponse({join_notification_conflict: true}));
		await act(async () => button('Welcome').click());
		expect(container.textContent).toContain(
			'The built-in join message also goes to this channel; you can turn it off in Overview.',
		);
	});
	it('uses the public application name as the title', async () => {
		await render(settingsResponse());
		expect(container.querySelector('h2')?.textContent).toBe('Official test application');
	});
	it('saves welcome changes and offers only text channels', async () => {
		const {http} = await render(settingsResponse());
		http.patch.mockResolvedValue({body: settingsResponse()});
		await act(async () => button('Welcome').click());
		const select = container.querySelector('select')!;
		expect(Array.from(select.options).map((option) => option.value)).toEqual(['', '123']);
		await act(async () => {
			select.value = '123';
			select.dispatchEvent(new Event('change', {bubbles: true}));
		});
		await act(async () =>
			container.querySelector('input[type="checkbox"]')!.dispatchEvent(new MouseEvent('click', {bubbles: true})),
		);
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(http.patch).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/settings`, {
			body: {welcome_enabled: true, welcome_channel_id: '123'},
		});
		expect(container.querySelector('textarea')?.placeholder).toBe('Welcome {user}');
	});
	it('shows all six automod rules and disables timeout without permission', async () => {
		const {http} = await render(settingsResponse(), false);
		await act(async () => button('Automod').click());
		expect(container.querySelectorAll('section h3')).toHaveLength(6);
		const timeoutOptions = Array.from(container.querySelectorAll('option')).filter(
			(option) => option.value === 'delete_mute',
		);
		expect(timeoutOptions).toHaveLength(6);
		expect(timeoutOptions.every((option) => option.disabled)).toBe(true);
		const threshold = container.querySelector('input[type="number"]') as HTMLInputElement;
		expect([threshold.min, threshold.max]).toEqual(['3', '20']);
		http.put.mockResolvedValue({body: responseFor(`/guilds/${GUILD_ID}/micupbot/automod`)});
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(http.put.mock.calls[0]?.[0]).toBe(`/guilds/${GUILD_ID}/micupbot/automod`);
	});
	it('confirms panel deletion before making the request', async () => {
		const {http} = await render(settingsResponse(), true, 1);
		await act(async () => button('Roles').click());
		await act(async () => button('Delete').click());
		expect(http.delete).not.toHaveBeenCalled();
		expect(container.textContent).toContain('Delete this reaction role panel?');
		await act(async () => button('Delete').click());
		expect(http.delete).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/reaction-roles/0`);
		expect(container.textContent).toContain('0/25');
	});
	it('loads warnings only for the selected search result and confirms clearing them', async () => {
		const {http, searchGuildMembers} = await render(settingsResponse());
		await act(async () => button('Warnings').click());
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(searchGuildMembers).toHaveBeenCalledWith(GUILD_ID, {query: '', limit: 25, offset: 0});
		http.get.mockResolvedValue({
			body: {warnings: [{id: '456', moderator_id: '789', reason: 'A reason', created_at: '2026-10-02T00:00:00.000Z'}]},
		});
		const select = container.querySelector('select')!;
		await act(async () => {
			select.value = '123';
			select.dispatchEvent(new Event('change', {bubbles: true}));
		});
		expect(http.get).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/warnings/123`);
		expect(container.textContent).toContain('A reason');
		await act(async () => button('Clear all warnings').click());
		expect(http.delete).not.toHaveBeenCalled();
		const confirm = Array.from(container.querySelectorAll('button'))
			.filter((node) => node.textContent === 'Delete')
			.at(-1)!;
		await act(async () => confirm.click());
		expect(http.delete).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/warnings/123`);
		expect(container.textContent).toContain('No warnings.');
	});
	async function change(select: HTMLSelectElement, value: string) {
		await act(async () => {
			select.value = value;
			select.dispatchEvent(new Event('change', {bubbles: true}));
		});
	}
	async function submit() {
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
	}
	async function showWarnings() {
		await render(settingsResponse());
		await act(async () => button('Warnings').click());
		await submit();
		http.get.mockResolvedValue({
			body: {warnings: [{id: '456', moderator_id: '789', reason: 'A reason', created_at: '2026-10-02T13:14:00.000Z'}]},
		});
		await change(container.querySelector('select')!, '123');
	}
	async function fillPanel() {
		await render(settingsResponse());
		await act(async () => button('Roles').click());
		await act(async () => button('Create panel').click());
		await change(container.querySelectorAll('select')[0]!, '123');
		await change(container.querySelectorAll('select')[1]!, 'unique');
		const input = container.querySelector('input')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Panel title');
			input.dispatchEvent(new Event('input', {bubbles: true}));
		});
		await act(async () => button('Choose emoji').click());
		await act(async () => button('Pick thumbs up').click());
		await change(container.querySelectorAll('select')[2]!, '1');
		http.post.mockImplementation(async (_path, {body}) => ({
			body: {...body, message_id: '456', description: null, created_at: '2026-10-03'},
		}));
	}
	it('shows a deleted saved channel and lets the user clear it', async () => {
		await render(settingsResponse({settings: {...settingsResponse().settings, welcome_channel_id: '999'}}));
		await act(async () => button('Welcome').click());
		const select = container.querySelector('select')!;
		expect(select.selectedOptions[0]?.textContent).toBe('Deleted channel (999)');
		http.patch.mockResolvedValue({body: settingsResponse()});
		await change(select, '');
		await submit();
		expect(http.patch).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/settings`, {
			body: {welcome_channel_id: null},
		});
	});
	it('keeps the chosen skin tone in a reaction role panel', async () => {
		await fillPanel();
		await submit();
		expect(http.post).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/reaction-roles`, {
			body: expect.objectContaining({entries: [{emoji: {name: '👍🏽'}, role_id: '1'}]}),
		});
	});
	it('resets the panel draft after a successful creation', async () => {
		await fillPanel();
		await submit();
		expect(http.post).toHaveBeenCalledTimes(1);
		await act(async () => button('Create panel').click());
		expect(container.querySelector('input')!.value).toBe('');
		expect(Array.from(container.querySelectorAll('select'), (s) => s.value)).toEqual(['', 'normal', '']);
		expect(button('Choose emoji')).toBeDefined();
		await submit();
		expect(http.post).toHaveBeenCalledTimes(1);
	});
	it('retains the panel draft when creation fails', async () => {
		await fillPanel();
		http.post.mockRejectedValueOnce(new Error('offline'));
		await submit();
		expect(container.querySelector('input')!.value).toBe('Panel title');
	});
	it('separates warning metadata with a middle dot', async () => {
		await showWarnings();
		expect(container.querySelector('[data-flx="micupbot.micup-bot-warnings.separator"]')!.textContent).toBe(' · ');
	});
	it('formats warning dates with the app locale and time preference', async () => {
		await showWarnings();
		expect(container.querySelector('time')!.textContent).toBe(getFormattedDateTime('2026-10-02T13:14:00.000Z'));
	});
	it('clears the warning selection and pending deletion when a new search starts', async () => {
		await showWarnings();
		await act(async () => button('Clear all warnings').click());
		searchGuildMembers.mockResolvedValueOnce({members: []});
		await submit();
		expect(container.textContent).not.toContain('A reason');
		expect(container.textContent).not.toContain('Delete all warnings for this member?');
		expect(container.querySelector('select')!.value).toBe('');
		expect(http.delete).not.toHaveBeenCalled();
	});
	it('shows a search error instead of an update error', async () => {
		await render(settingsResponse());
		await act(async () => button('Warnings').click());
		searchGuildMembers.mockRejectedValueOnce(new Error('offline'));
		await submit();
		expect(container.querySelector('[role="alert"]')!.textContent).toBe('An error occurred while searching.');
	});
	function automodWith(patch: Record<string, unknown>) {
		const {rules} = responseFor(`/guilds/${GUILD_ID}/micupbot/automod`) as {rules: Array<Record<string, unknown>>};
		return {rules: rules.map((rule) => (rule.rule === 'spam' ? {...rule, ...patch} : rule))};
	}
	function field(text: string) {
		const node = Array.from(container.querySelectorAll('label')).find((label) => label.textContent?.startsWith(text));
		expect(node).toBeDefined();
		return node!;
	}
	it('shows the welcome conflict as a warning under the welcome channel', async () => {
		await render(settingsResponse({join_notification_conflict: true}));
		await act(async () => button('Welcome').click());
		const warning = container.querySelector('[data-flx="micupbot.micup-bot-welcome.conflict"]')!;
		expect(warning.textContent).toContain('The built-in join message also goes to this channel');
		const card = container.querySelector('section')!;
		expect(card.contains(warning)).toBe(true);
		expect(
			card.querySelector('select')!.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
	it('shows critical bot warnings with the warning alert', async () => {
		await render(settingsResponse({bot: {...settingsResponse().bot!, mfa_blocked: true}, role_warnings: ['1', '999']}));
		expect(container.querySelector('[data-flx="micupbot.micup-bot-tab.mfa-warning"]')!.textContent).toContain(
			'two-factor authentication',
		);
		expect(container.querySelector('[data-flx="micupbot.micup-bot-tab.role-warning"]')!.textContent).toContain(
			'Role 1, Deleted role (999)',
		);
	});
	it('names warning moderators instead of showing raw IDs', async () => {
		await render(settingsResponse());
		await act(async () => button('Warnings').click());
		await submit();
		http.get.mockResolvedValue({
			body: {
				warnings: [
					{id: '1', moderator_id: '789', reason: 'Known', created_at: '2026-10-02T00:00:00.000Z'},
					{
						id: '2',
						moderator_id: settingsResponse().bot!.user_id,
						reason: 'Automod',
						created_at: '2026-10-02T00:00:00.000Z',
					},
					{id: '3', moderator_id: '555', reason: 'Unknown', created_at: '2026-10-02T00:00:00.000Z'},
				],
			},
		});
		await change(container.querySelector('select')!, '123');
		const moderators = Array.from(
			container.querySelectorAll('[data-flx="micupbot.micup-bot-warnings.p--3"]'),
			(node) => node.firstChild?.textContent,
		);
		expect(moderators).toEqual(['Moderator: Mod Nick', 'Moderator: Official test application', 'Moderator: 555']);
		expect(getNickname).toHaveBeenCalledWith(users['789'], GUILD_ID);
	});
	it('explains blocked timeout rules and shows the save error beside Save', async () => {
		await render(settingsResponse(), false, 0, {'/automod': automodWith({enabled: true, action: 'delete_mute'})});
		await act(async () => button('Automod').click());
		const save = button('Save');
		expect(save.parentElement!.previousElementSibling?.textContent).toContain('Time out members');
		expect(field('Timeout duration').querySelector('select')!.disabled).toBe(true);
		http.put.mockRejectedValueOnce(new Error('forbidden'));
		await submit();
		expect(save.parentElement!.textContent).toContain('Could not update community bot settings. Please try again.');
	});
	it('saves Fluxer Switch and Textarea values', async () => {
		await render(settingsResponse());
		http.patch.mockResolvedValue({body: settingsResponse()});
		await act(async () => button('Welcome').click());
		await act(async () =>
			container.querySelector('[role="switch"]')!.dispatchEvent(new MouseEvent('click', {bubbles: true})),
		);
		const textarea = container.querySelector('textarea')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Hi {user}');
			textarea.dispatchEvent(new Event('input', {bubbles: true}));
		});
		await submit();
		expect(http.patch).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/micupbot/settings`, {
			body: {welcome_enabled: true, welcome_message: 'Hi {user}'},
		});
	});
	it('numbers the leaderboard and groups XP with the app locale', async () => {
		await render(settingsResponse({settings: {...settingsResponse().settings, levels_enabled: true}}), true, 0, {
			'/leaderboard': {
				levels_enabled: true,
				total: 1,
				entries: [{rank: 1, user_id: '7', xp: 48210, level: 38, user: {username: 'zeynep', global_name: 'Zeynep'}}],
			},
		});
		await act(async () => button('Levels').click());
		expect(container.querySelector('[data-flx="micupbot.micup-bot-levels.li"]')!.textContent).toBe(
			'1. Zeynep — Level 38 · 48.210 XP',
		);
	});
	it('prefixes reaction role panel channels with #', async () => {
		await render(settingsResponse(), true, 1);
		await act(async () => button('Roles').click());
		expect(container.querySelector('[data-flx="micupbot.micup-bot-roles.p"]')!.textContent).toBe(
			'#Text channel · Normal — add and remove roles with reactions',
		);
	});
	it('says the bot is missing before offering Add bot', async () => {
		await render(settingsResponse({bot: {...settingsResponse().bot!, in_guild: false}}));
		const card = container.querySelector('[data-flx="micupbot.micup-bot-tab.card"]')!;
		expect(Array.from(card.children, (node) => node.textContent)).toEqual([
			'Official test application is not in this community.',
			'Add bot',
			"Move the bot's role above the roles it should give.",
		]);
		expect(card.lastElementChild!.className).toContain('muted');
	});
	it('labels thresholds with units and offers Fluxer timeout durations', async () => {
		await render(settingsResponse(), true, 0, {'/automod': automodWith({action: 'delete_mute', mute_seconds: 900})});
		await act(async () => button('Automod').click());
		for (const label of ['Messages per 5 seconds', 'Mentions per message', 'Capital letters (%)'])
			expect(field(label).querySelector('input')).not.toBeNull();
		const duration = field('Timeout duration').querySelector('select')!;
		expect(Array.from(duration.options, (option) => option.value)).toEqual([
			'60',
			'300',
			'600',
			'3600',
			'86400',
			'604800',
			'900',
		]);
		await change(duration, '3600');
		http.put.mockResolvedValue({body: responseFor(`/guilds/${GUILD_ID}/micupbot/automod`)});
		await submit();
		expect(http.put.mock.calls[0]?.[1]).toMatchObject({
			body: {rules: expect.arrayContaining([expect.objectContaining({rule: 'spam', mute_seconds: 3600})])},
		});
	});
	it('asks for a channel and a role where they are required', async () => {
		await render(settingsResponse());
		await act(async () => button('Roles').click());
		await act(async () => button('Create panel').click());
		const [channel, , role] = Array.from(container.querySelectorAll('select'));
		expect(channel!.options[0]!.textContent).toBe('Select a channel');
		expect(role!.options[0]!.textContent).toBe('Select a role');
	});
	it('warns under fields that still point at deleted channels and roles', async () => {
		await render(
			settingsResponse({
				settings: {...settingsResponse().settings, welcome_channel_id: '999', autorole_ids: ['1', '998']},
			}),
		);
		await act(async () => button('Welcome').click());
		const notes = Array.from(container.querySelectorAll('[role="note"]'), (node) => node.textContent);
		expect(notes).toEqual(['This channel no longer exists.', 'Deleted items are still selected: Deleted role (998)']);
	});
	it('disables automod switches and timeout without MANAGE_MESSAGES', async () => {
		permissions.canManageMessages = false;
		await render(settingsResponse(), true, 0, {'/automod': automodWith({action: 'delete_mute'})});
		await act(async () => button('Automod').click());
		const switches = Array.from(container.querySelectorAll<HTMLInputElement>('[role="switch"]'));
		expect(switches).toHaveLength(6);
		expect(switches.every((node) => node.disabled)).toBe(true);
		expect(field('Timeout duration').querySelector('select')!.disabled).toBe(true);
	});
	it('keeps an unlisted saved timeout duration when saving unchanged', async () => {
		await render(settingsResponse(), true, 0, {'/automod': automodWith({action: 'delete_mute', mute_seconds: 900})});
		await act(async () => button('Automod').click());
		http.put.mockResolvedValue({body: responseFor(`/guilds/${GUILD_ID}/micupbot/automod`)});
		await submit();
		expect(http.put.mock.calls[0]?.[1]).toMatchObject({
			body: {rules: expect.arrayContaining([expect.objectContaining({rule: 'spam', mute_seconds: 900})])},
		});
	});
	it('does not show another tab error beside the automod Save button', async () => {
		await render(settingsResponse());
		await act(async () => button('Warnings').click());
		await submit();
		http.get.mockRejectedValueOnce(new Error('offline'));
		await change(container.querySelector('select')!, '123');
		expect(container.querySelector('[role="alert"]')!.textContent).toBe('Failed to load');
		await act(async () => button('Automod').click());
		expect(button('Save').parentElement!.textContent).toBe('Save');
	});
	it('labels unlisted timeout durations with the largest whole unit', async () => {
		const {rules} = automodWith({action: 'delete_mute', mute_seconds: 2_419_200});
		rules[5] = {...rules[5], action: 'delete_mute', mute_seconds: 900};
		await render(settingsResponse(), true, 0, {'/automod': {rules}});
		await act(async () => button('Automod').click());
		const labels = Array.from(container.querySelectorAll('label'))
			.filter((label) => label.textContent?.startsWith('Timeout duration'))
			.map((label) => Array.from(label.querySelector('select')!.options).at(-1)!.textContent);
		expect(labels).toEqual(['28 gün', '15 dakika']);
	});
});
