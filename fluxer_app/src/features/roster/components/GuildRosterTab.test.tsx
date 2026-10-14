// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import type {
	GuildRosterEventListResponse,
	GuildRosterEventResponse,
} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';
import type {ButtonHTMLAttributes, InputHTMLAttributes} from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const translations = vi.hoisted(() => new Map<string, string>());
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (descriptor: {message: string; context?: string}, values: Record<string, unknown> = {}) =>
				(translations.get(`${descriptor.context ?? ''}|${descriptor.message}`) ?? descriptor.message).replace(
					/{(\w+)}/g,
					(token, key: string) => (key in values ? String(values[key]) : token),
				),
		},
	}),
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/auth/commands/OAuthAuthorizeModalCommands', () => ({openOAuthAuthorizeModalFromUrl: vi.fn()}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getGuildChannels: vi.fn()}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuildRoles: vi.fn()}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {webAppBaseUrl: 'https://app.example.test'}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useSmoothScrolling: false}}));
vi.mock('@app/features/ui/state/Modal', async () => {
	const {observable} = await import('mobx');
	const keys = observable.set<string>();
	return {default: {hasModal: (key: string) => keys.has(key), keys}};
});
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
}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({
	Combobox: ({
		id,
		label,
		value,
		options,
		onChange,
		disabled,
		error,
	}: {
		id: string;
		label: string;
		value: string;
		options: Array<{value: string; label: string}>;
		onChange: (value: string) => void;
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
					id,
					'aria-label': label,
					value,
					disabled,
					onChange: (event: {target: {value: string}}) => onChange(event.target.value),
				},
				options.map((option) => createElement('option', {key: option.value, value: option.value}, option.label)),
			),
			error ? createElement('small', null, error) : null,
		),
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
			'button',
			{type: 'button', role: 'switch', 'aria-checked': value, disabled, onClick: () => onChange(!value)},
			label,
		),
}));
const {http} = await import('@app/features/platform/transport/RestTransport');
const authorize = await import('@app/features/auth/commands/OAuthAuthorizeModalCommands');
const {default: Channels} = await import('@app/features/channel/state/Channels');
const {default: Guilds} = await import('@app/features/guild/state/Guilds');
const {default: Modal} = await import('@app/features/ui/state/Modal');
const {runInAction} = await import('mobx');
const modalKeys = (Modal as unknown as {keys: Set<string>}).keys;
const tabModule = await import('./GuildRosterTab');

const GUILD_ID = '1485064866382176262';
const event: GuildRosterEventResponse = {
	id: '1485064866382176263',
	guild_id: GUILD_ID,
	name: 'Raid',
	voice_channel_id: '1485064866382176264',
	announce_channel_id: '1485064866382176265',
	mention_role_id: '1485064866382176266',
	main_size: 10,
	sub_size: 5,
	enabled: true,
	created_at: '2026-10-02T00:00:00.000Z',
	updated_at: '2026-10-02T00:00:00.000Z',
};
function response(extra: Partial<GuildRosterEventListResponse> = {}): GuildRosterEventListResponse {
	return {
		feature_enabled: true,
		bot: {application_id: '1485064866382176267', user_id: '1485064866382176267', in_guild: true},
		invite_permissions: '17910848',
		max_events: 10,
		events: [event],
		...extra,
	};
}

describe('GuildRosterTab', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.resetAllMocks();
		translations.clear();
		runInAction(() => modalKeys.clear());
		vi.mocked(Channels.getGuildChannels).mockReturnValue([
			{id: event.voice_channel_id, name: 'Raid room', type: 2},
			{id: event.announce_channel_id, name: 'Announcements', type: 0},
		] as never);
		vi.mocked(Guilds.getGuildRoles).mockReturnValue([
			{id: GUILD_ID, name: '@everyone', mentionable: false},
			{id: event.mention_role_id, name: 'Raiders', mentionable: false},
		] as never);
		vi.mocked(authorize.openOAuthAuthorizeModalFromUrl).mockImplementation((url) => {
			runInAction(() => modalKeys.add(`oauth-authorize:${new URL(url).search}`));
			return true;
		});
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

	async function render(data: GuildRosterEventListResponse) {
		vi.spyOn(http, 'get').mockResolvedValue({body: data} as never);
		await act(async () => root.render(createElement(tabModule.default, {guildId: GUILD_ID})));
	}

	function button(text: string) {
		const found = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === text);
		expect(found).toBeDefined();
		return found!;
	}

	it('shows the off notice while feature_enabled is false', async () => {
		await render(response({feature_enabled: false, events: []}));
		expect(container.textContent).toBe('The event bot is currently disabled.');
		expect(container.querySelector('button')).toBeNull();
	});
	it('shows Add bot when the bot is not in the guild', async () => {
		const open = vi.spyOn(authorize, 'openOAuthAuthorizeModalFromUrl');
		await render(response({bot: {...response().bot!, in_guild: false}}));
		expect(button('Add bot').disabled).toBe(false);
		expect(container.textContent).toContain('Move the bot’s role above the roles of the members it will move.');
		await act(async () => button('Add bot').click());
		const url = new URL(open.mock.calls[0]![0]);
		expect(url.origin).toBe(location.origin);
		expect(url.searchParams.get('client_id')).toBe(response().bot!.application_id);
		expect(url.searchParams.get('guild_id')).toBe(GUILD_ID);
		expect(url.searchParams.get('permissions')).toBe('17910848');
	});
	it('shows an administrator notice without an invite when no bot is configured', async () => {
		await render(response({feature_enabled: false, bot: null, events: []}));
		expect(container.textContent).toBe('The bot has not been configured yet.');
		expect(container.querySelector('button')).toBeNull();
	});
	it('keeps saved events read-only while the feature is disabled', async () => {
		await render(response({feature_enabled: false}));
		expect(container.textContent).toContain('The event bot is currently disabled.');
		expect(container.textContent).toContain('Raid room');
		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('form')).toBeNull();
	});
	it('marks missing channels and roles as deleted', async () => {
		vi.mocked(Channels.getGuildChannels).mockReturnValue([]);
		vi.mocked(Guilds.getGuildRoles).mockReturnValue([]);
		await render(response());
		expect(container.textContent).toContain('Deleted channel');
		expect(container.textContent).toContain('Deleted role');
		expect(container.textContent).not.toContain('#');
		for (const id of [event.voice_channel_id, event.announce_channel_id, event.mention_role_id!]) {
			expect(container.textContent).not.toContain(id);
		}
	});
	it('clears a deleted mention role so an event can be saved', async () => {
		vi.mocked(Guilds.getGuildRoles).mockReturnValue([]);
		await render(response());
		const patch = vi.spyOn(http, 'patch').mockResolvedValue({body: {...event, mention_role_id: null}} as never);
		await act(async () => button('Edit').click());
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(patch).toHaveBeenCalledWith(expect.any(String), {body: expect.objectContaining({mention_role_id: null})});
		expect(container.querySelector('form')).toBeNull();
	});
	it('reloads bot membership only after the invitation closes', async () => {
		await render(response({bot: {...response().bot!, in_guild: false}}));
		await act(async () => button('Add bot').click());
		expect(http.get).toHaveBeenCalledTimes(1);
		vi.mocked(http.get).mockResolvedValue({body: response()} as never);
		await act(async () => runInAction(() => modalKeys.clear()));
		expect(http.get).toHaveBeenCalledTimes(2);
		expect(container.textContent).not.toContain('Add bot');
	});
	it('does not reload an invitation after leaving the tab', async () => {
		await render(response({bot: {...response().bot!, in_guild: false}}));
		await act(async () => button('Add bot').click());
		await act(async () => root.render(null));
		await act(async () => runInAction(() => modalKeys.clear()));
		expect(http.get).toHaveBeenCalledTimes(1);
	});
	it('lists events with room, channel, role and sizes', async () => {
		await render(response());
		for (const text of ['Raid', 'Raid room', 'Announcements', 'Raiders', 'Main 10 · Subs 5', 'Enabled'])
			expect(container.textContent).toContain(text);
	});
	it('shows on and off with event status strings, not the shared Disabled', async () => {
		translations.set('|Disabled', 'Devre dışı bırakıldı');
		translations.set('event-bot-status|Enabled', 'Açık');
		translations.set('event-bot-status|Disabled', 'Kapalı');
		await render(response({events: [event, {...event, id: '1', enabled: false}]}));
		expect(
			Array.from(container.querySelectorAll('[data-flx="roster.guild-roster-tab.sizes"]'), (node) => node.textContent),
		).toEqual(['Main 10 · Subs 5 · Açık', 'Main 10 · Subs 5 · Kapalı']);
	});
	it('prefixes the announcement channel with # and names a missing role', async () => {
		await render(response({events: [{...event, mention_role_id: null}]}));
		expect(container.querySelector('[data-flx="roster.guild-roster-tab.details"]')?.textContent).toBe(
			'Raid room · #Announcements · No role',
		);
	});
	it('disables Add at 10 events', async () => {
		await render(response({events: Array.from({length: 10}, (_, index) => ({...event, id: String(index)}))}));
		expect(button('Add event').disabled).toBe(true);
		expect(container.textContent).toContain('10/10');
	});
	it('scrolls the form into view when adding or editing an event', async () => {
		const scrolled: Array<[string | null, unknown]> = [];
		vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element, options) {
			scrolled.push([this.getAttribute('data-flx'), options]);
		});
		const form = ['roster.guild-roster-tab.form', {block: 'nearest', behavior: 'auto'}];
		await render(response());
		await act(async () => button('Edit').click());
		expect(scrolled).toEqual([form]);
		await act(async () => button('Add event').click());
		expect(scrolled).toEqual([form, form]);
	});
	it('moves focus to the event name when the form opens', async () => {
		await render(response());
		await act(async () => button('Edit').click());
		expect(document.activeElement).toBe(container.querySelector('input[name="name"]'));
	});
	it('scrolls to and focuses the open form again when its button is pressed again', async () => {
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
		await render(response());
		await act(async () => button('Edit').click());
		(document.activeElement as HTMLElement).blur();
		await act(async () => button('Edit').click());
		expect(scroll).toHaveBeenCalledTimes(2);
		expect(document.activeElement).toBe(container.querySelector('input[name="name"]'));
	});
	it('warns when the chosen role is not mentionable', async () => {
		await render(response());
		await act(async () => button('Edit').click());
		expect(container.textContent).toContain('The bot cannot mention this role; make the role mentionable.');
		expect(
			container.querySelector('select[name="mention_role_id"], select[aria-label="Mention role"]')?.textContent,
		).not.toContain('@everyone');
	});
	it('uses labeled Fluxer comboboxes for channels and roles', async () => {
		await render(response());
		await act(async () => button('Edit').click());
		for (const label of ['Voice room', 'Announcement channel', 'Mention role']) {
			expect(container.querySelector(`select[aria-label="${label}"]`)).not.toBeNull();
		}
	});
	it('marks the empty voice room and announcement channel fields', async () => {
		await render(response());
		await act(async () => button('Add event').click());
		const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
		const fieldError = (label: string) => select(label).parentElement!.querySelector('small')?.textContent ?? null;
		expect([fieldError('Voice room'), fieldError('Announcement channel')]).toEqual([null, null]);
		container.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'Raid';
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect([fieldError('Voice room'), fieldError('Announcement channel')]).toEqual([
			'Select a channel',
			'Select a channel',
		]);
		select('Voice room').value = event.voice_channel_id;
		await act(async () => select('Voice room').dispatchEvent(new Event('change', {bubbles: true})));
		expect([fieldError('Voice room'), fieldError('Announcement channel')]).toEqual([null, 'Select a channel']);
	});
	it('limits main to 1..50 and subs to 0..25', async () => {
		await render(response());
		await act(async () => button('Add event').click());
		const main = container.querySelector<HTMLInputElement>('input[name="main_size"]')!;
		const subs = container.querySelector<HTMLInputElement>('input[name="sub_size"]')!;
		expect([main.min, main.max, main.value]).toEqual(['1', '50', '10']);
		expect([subs.min, subs.max, subs.value]).toEqual(['0', '25', '5']);
		const voice = container.querySelector<HTMLSelectElement>(
			'select[name="voice_channel_id"], select[aria-label="Voice room"]',
		)!;
		const announce = container.querySelector<HTMLSelectElement>(
			'select[name="announce_channel_id"], select[aria-label="Announcement channel"]',
		)!;
		expect(Array.from(voice.options).map((option) => option.value)).toEqual(['', event.voice_channel_id]);
		expect(Array.from(announce.options).map((option) => option.value)).toEqual(['', event.announce_channel_id]);
		const post = vi
			.spyOn(http, 'post')
			.mockRejectedValue(
				new HttpError({method: 'POST', path: '/', status: 400, body: {message: 'Unexpected invalid form request'}}),
			);
		container.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'Raid';
		voice.value = event.voice_channel_id;
		announce.value = event.announce_channel_id;
		await act(async () => {
			voice.dispatchEvent(new Event('change', {bubbles: true}));
			announce.dispatchEvent(new Event('change', {bubbles: true}));
		});
		for (const [mainValue, subValue] of [
			['0', '5'],
			['51', '5'],
			['10', '-1'],
			['10', '26'],
			['10', ''],
			['1.5', '5'],
		]) {
			main.value = mainValue;
			subs.value = subValue;
			await act(async () =>
				container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
			);
		}
		expect(post).not.toHaveBeenCalled();
	});
	it('saves a valid form and keeps a failed save open with the server message', async () => {
		await render(response());
		const patch = vi
			.spyOn(http, 'patch')
			.mockRejectedValueOnce(
				new HttpError({method: 'PATCH', path: '/', status: 403, body: {message: 'Bu rolü anamazsınız.'}}),
			)
			.mockResolvedValue({body: {...event, name: 'Dungeon'}} as never);
		await act(async () => button('Edit').click());
		container.querySelector<HTMLInputElement>('input[name="name"]')!.value = '  Dungeon  ';
		const submit = () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
		await act(async () => {
			submit();
		});
		expect(container.textContent).toContain('Bu rolü anamazsınız.');
		expect(container.querySelector('form')).not.toBeNull();
		await act(async () => {
			submit();
		});
		expect(patch).toHaveBeenLastCalledWith(`/guilds/${GUILD_ID}/roster-events/${event.id}`, {
			body: {
				name: 'Dungeon',
				voice_channel_id: event.voice_channel_id,
				announce_channel_id: event.announce_channel_id,
				mention_role_id: event.mention_role_id,
				main_size: 10,
				sub_size: 5,
				enabled: true,
			},
		});
		expect(container.querySelector('form')).toBeNull();
		expect(container.textContent).toContain('Dungeon');
	});
	it('turns an event off with the Fluxer switch', async () => {
		await render(response());
		const patch = vi.spyOn(http, 'patch').mockResolvedValue({body: {...event, enabled: false}} as never);
		await act(async () => button('Edit').click());
		expect(container.querySelector('input[type="checkbox"]')).toBeNull();
		const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
		expect([toggle.textContent, toggle.getAttribute('aria-checked')]).toEqual(['Enabled', 'true']);
		await act(async () => toggle.click());
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(patch).toHaveBeenCalledWith(expect.any(String), {body: expect.objectContaining({enabled: false})});
	});
	it('opens a disabled event switched off and a new event switched on', async () => {
		await render(response({events: [{...event, enabled: false}]}));
		const patch = vi.spyOn(http, 'patch').mockResolvedValue({body: {...event, enabled: false}} as never);
		const toggle = () => container.querySelector('[role="switch"]')?.getAttribute('aria-checked');
		await act(async () => button('Edit').click());
		expect(toggle()).toBe('false');
		await act(async () =>
			container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(patch).toHaveBeenCalledWith(expect.any(String), {body: expect.objectContaining({enabled: false})});
		await act(async () => button('Add event').click());
		expect(toggle()).toBe('true');
	});
	it('requires confirmation before deleting and allows cancelling', async () => {
		await render(response());
		const remove = vi.spyOn(http, 'delete').mockResolvedValue({body: null} as never);
		await act(async () => button('Delete').click());
		expect(remove).not.toHaveBeenCalled();
		expect(container.textContent).toContain('Delete event “Raid”?');
		await act(async () => button('Cancel').click());
		expect(remove).not.toHaveBeenCalled();
		await act(async () => button('Delete').click());
		await act(async () => button('Delete').click());
		expect(remove).toHaveBeenCalledWith(`/guilds/${GUILD_ID}/roster-events/${event.id}`);
		expect(container.querySelector('ul')?.textContent).toBe('');
	});
});
