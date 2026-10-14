// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApplicationPublicResponse} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import {act, type ButtonHTMLAttributes, createElement, type HTMLAttributes} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const officialApps = [
	{application_id: '123456789012345678', invite_permissions: '1099780156480'},
	{application_id: '223456789012345678', invite_permissions: '68608'},
];
const publicApp = (id: string): ApplicationPublicResponse => ({
	id,
	name: `Public app ${id}`,
	icon: 'icon-hash',
	description: 'Public description',
	redirect_uris: [],
	scopes: ['bot'],
	bot_public: true,
	bot: null,
});
const Surface = ({children}: HTMLAttributes<HTMLDivElement>) => createElement('div', null, children);
const Icon = () => createElement('svg', {'aria-hidden': true});

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
const http = {get: vi.fn<(path: string) => Promise<{body: ApplicationPublicResponse}>>()};
const authorize = {openOAuthAuthorizeModalFromUrl: vi.fn((_url: string) => true)};
const modals = {push: vi.fn(), modal: (render: unknown) => render};
const links = {openExternalUrlWithWarning: vi.fn()};
const runtimeConfig = {officialApps, webAppBaseUrl: 'https://app.example.test'};
vi.mock('@app/features/messaging/utils/ExternalLinkUtils', () => links);
vi.mock('@app/features/ui/commands/ModalCommands', () => modals);
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: Surface}));
vi.mock('@app/features/channel/components/direct_message/DMPageFrame', () => ({
	DMPageFrame: ({children, title}: HTMLAttributes<HTMLDivElement> & {title: string}) =>
		createElement('div', null, createElement('header', null, title), children),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtimeConfig}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/auth/commands/OAuthAuthorizeModalCommands', () => authorize);
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => createElement('button', {type: 'button', ...props}),
}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({
	getUserAvatarURL: ({id, avatar}: {id: string; avatar: string}) => `https://cdn.test/avatars/${id}/${avatar}.png`,
}));
vi.mock('@phosphor-icons/react', () => ({
	AppWindowIcon: Icon,
	PaletteIcon: Icon,
	UsersThreeIcon: Icon,
	RobotIcon: Icon,
	BookOpenIcon: Icon,
}));
const {BotsPage} = await import('@app/features/bots/components/pages/BotsPage');

describe('Bot System catalog', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		vi.clearAllMocks();
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
		apps = officialApps,
		get = async (path: string) => ({body: publicApp(path.split('/').at(-2)!)}),
	) {
		runtimeConfig.officialApps = apps;
		http.get.mockImplementation(get);
		await act(async () => root.render(createElement(BotsPage)));
		return {http, authorize};
	}
	function button(text: string) {
		const node = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === text);
		expect(node).toBeDefined();
		return node!;
	}
	it('shows Bot System and opens the applications settings for bot creation', async () => {
		await render([]);
		expect(container.querySelector('h1')?.textContent).toBe('Bot System');
		await act(async () => button('Create your own bot').click());
		expect(modals.push).toHaveBeenCalledTimes(1);
		const modal = modals.push.mock.calls[0][0] as () => {props: {initialTab: string}};
		expect(modal().props.initialTab).toBe('applications');
	});
	it('opens developer documentation through the external link warning', async () => {
		await render([]);
		await act(async () => button('Developer documentation').click());
		expect(links.openExternalUrlWithWarning).toHaveBeenCalledWith('https://micup.gg/docs');
		expect(container.querySelector('[data-flx="discovery.apps.scroller"]')).toBeNull();
	});
	it('each card shows the public application name and icon', async () => {
		const {http} = await render();
		expect(Array.from(container.querySelectorAll('h2'), (node) => node.textContent)).toEqual(
			officialApps.map((app) => publicApp(app.application_id).name),
		);
		expect(Array.from(container.querySelectorAll('img'), (node) => node.src)).toEqual(
			officialApps.map((app) => `https://cdn.test/avatars/${app.application_id}/icon-hash.png`),
		);
		expect(container.textContent).toContain('Public description');
		expect(http.get).toHaveBeenCalledTimes(2);
	});
	it('Add to community opens the authorize modal without a fixed community', async () => {
		const {authorize} = await render();
		await act(async () => button('Add to community').click());
		const url = new URL(authorize.openOAuthAuthorizeModalFromUrl.mock.calls[0]![0]);
		expect(url.pathname).toBe('/oauth2/authorize');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: officialApps[0].application_id,
			scope: 'bot',
			permissions: officialApps[0].invite_permissions,
		});
	});
	it('an empty list shows No apps yet', async () => {
		const {http} = await render([]);
		expect(container.textContent).toContain('No apps yet.');
		expect(http.get).not.toHaveBeenCalled();
	});
	it('announces loading until the configured application requests settle', async () => {
		let resolve!: (value: {body: ApplicationPublicResponse}) => void;
		const pending = new Promise<{body: ApplicationPublicResponse}>((complete) => {
			resolve = complete;
		});
		await render([officialApps[0]], () => pending);
		expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading apps');
		expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
		await act(async () => resolve({body: publicApp(officialApps[0].application_id)}));
		expect(container.querySelector('[role="status"]')).toBeNull();
		expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
		expect(container.querySelector('h2')?.textContent).toBe(publicApp(officialApps[0].application_id).name);
	});
	it('a failed card is hidden and an error is shown beside successful cards', async () => {
		await render(officialApps, async (path) => {
			if (path.includes(officialApps[0].application_id)) throw new Error('unavailable');
			return {body: {...publicApp(officialApps[1].application_id), icon: null}};
		});
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		expect(container.querySelectorAll('h2')).toHaveLength(1);
		expect(container.querySelector('h2')?.textContent).toBe(publicApp(officialApps[1].application_id).name);
		expect(container.querySelectorAll('img')).toHaveLength(0);
	});
});
