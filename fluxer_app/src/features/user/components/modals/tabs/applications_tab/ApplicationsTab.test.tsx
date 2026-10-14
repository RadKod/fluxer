// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	navigationState: 'LIST',
	isLoading: false,
	isListView: true,
	isDetailView: false,
	applications: [],
	contentKey: 'list',
	fetchApplications: vi.fn(),
	navigateToDetail: vi.fn(),
}));
const links = vi.hoisted(() => ({openExternalUrlWithWarning: vi.fn()}));
const modals = vi.hoisted(() => ({push: vi.fn(), modal: (render: unknown) => render}));
const user = vi.hoisted(() => ({claimed: true}));
const Surface = ({children}: {children?: ReactNode}) => createElement('div', null, children);
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
	Trans: Surface,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {isSelfHosted: () => true}}));
vi.mock('@app/features/messaging/utils/ExternalLinkUtils', () => links);
vi.mock('@app/features/ui/commands/ModalCommands', () => modals);
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {isClaimed: () => user.claimed}}}));
vi.mock('@app/features/user/components/modals/tabs/applications_tab/ApplicationsTabState', () => ({default: state}));
vi.mock('@app/features/user/hooks/useSettingsContentKey', () => ({
	useSettingsContentKey: () => ({setContentKey: vi.fn()}),
}));
vi.mock('@app/features/user/hooks/useUnsavedChangesFlash', () => ({
	useUnsavedChangesFlash: () => ({checkUnsavedChanges: () => false}),
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsSection', () => ({SettingsSection: Surface}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsTabLayout', () => ({
	SettingsTabContainer: Surface,
	SettingsTabContent: Surface,
}));
vi.mock('@app/features/app/components/dialogs/shared/StatusSlate', () => ({StatusSlate: Surface}));
vi.mock('@app/features/user/components/modals/tabs/applications_tab/ApplicationCreateModal', () => ({
	ApplicationCreateModal: Surface,
}));
vi.mock('@app/features/user/components/modals/tabs/applications_tab/ApplicationDetail', () => ({
	ApplicationDetail: Surface,
}));
vi.mock('@app/features/user/components/modals/tabs/applications_tab/ApplicationsList', () => ({
	ApplicationsList: Surface,
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: Surface}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: Surface}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled}, children),
}));
const {default: ApplicationsTab} = await import('./index');

describe('applications settings developer actions', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
		user.claimed = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	const render = () => act(() => root.render(createElement(ApplicationsTab)));
	const button = (label: string) =>
		[...container.querySelectorAll('button')].find((button) => button.textContent === label);
	it('shows documentation on self-hosted deployments and uses the external link warning', () => {
		render();
		expect(button('Developer documentation')).toBeDefined();
		act(() => button('Developer documentation')?.click());
		expect(links.openExternalUrlWithWarning).toHaveBeenCalledWith('https://docs.fluxer.app');
	});
	it('keeps application creation in the settings modal', () => {
		render();
		act(() => button('Create application')?.click());
		expect(modals.push).toHaveBeenCalledTimes(1);
		expect(button('Create your own bot')).toBeUndefined();
	});
	it('keeps the claim requirement for application creation', () => {
		user.claimed = false;
		render();
		expect(button('Create application')?.disabled).toBe(true);
	});
});
