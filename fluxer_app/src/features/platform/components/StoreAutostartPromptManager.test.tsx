// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {type IObservableValue, runInAction} from 'mobx';
import {act, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	ready: null as IObservableValue<boolean> | null,
	variant: 'app',
	electron: null as Record<string, unknown> | null,
}));
const pushed = vi.hoisted(() => [] as Array<() => ReactElement>);

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: {message: string}) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (descriptor: {message: string}, values?: Record<string, string>) =>
				descriptor.message.replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? ''),
		},
	}),
}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PRODUCT_NAME: 'Micup'}));
vi.mock('@app/features/app/state/Initialization', async () => {
	const {observable} = await import('mobx');
	state.ready = observable.box(true);
	const ready = state.ready;
	return {
		default: {
			get isReady() {
				return ready.get();
			},
		},
	};
});
vi.mock('@app/features/app/state/LayoutVariantContext', () => ({useLayoutVariant: () => state.variant}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		error() {}
	},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({getElectronAPI: () => state.electron}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	modal: (render: () => ReactElement) => render,
	push: (render: () => ReactElement) => pushed.push(render),
}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({
	ConfirmModal: ({
		title,
		description,
		primaryText,
		secondaryText,
		onPrimary,
		onSecondary,
	}: {
		title: ReactNode;
		description: ReactNode;
		primaryText: ReactNode;
		secondaryText: ReactNode;
		onPrimary: () => void;
		onSecondary?: () => void;
	}) =>
		createElement(
			'div',
			null,
			createElement('h1', null, title),
			createElement('p', null, description),
			createElement('button', {type: 'button', onClick: () => onSecondary?.()}, secondaryText),
			createElement('button', {type: 'button', onClick: () => onPrimary()}, primaryText),
		),
}));

const {StoreAutostartPromptManager} = await import('@app/features/platform/components/StoreAutostartPromptManager');

const roots: Array<Root> = [];

function mount(element: ReactElement): HTMLDivElement {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement('div');
	const root = createRoot(container);
	roots.push(root);
	act(() => root.render(element));
	return container;
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function desktop(claim: boolean | undefined) {
	const api = {
		autostartClaimStorePrompt: claim === undefined ? undefined : vi.fn(async () => claim),
		autostartEnable: vi.fn(async () => {}),
		autostartDisable: vi.fn(async () => {}),
		autostartIsEnabled: vi.fn(async () => true),
	};
	state.electron = api;
	return api;
}

function setReady(value: boolean): void {
	runInAction(() => state.ready?.set(value));
}

beforeEach(() => {
	setReady(true);
	state.variant = 'app';
	state.electron = null;
	pushed.length = 0;
});

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
});

describe('StoreAutostartPromptManager', () => {
	it('asks once the main UI is ready and turns autostart on for Yes', async () => {
		const api = desktop(true);
		mount(createElement(StoreAutostartPromptManager));
		await settle();

		expect(api.autostartClaimStorePrompt).toHaveBeenCalledTimes(1);
		expect(pushed).toHaveLength(1);
		const prompt = mount(pushed[0]());
		expect(prompt.querySelector('h1')?.textContent).toBe('Start Micup when your computer starts?');
		const buttons = [...prompt.querySelectorAll('button')];
		expect(buttons.map((button) => button.textContent)).toEqual(['No', 'Yes']);

		act(() => buttons[1].click());
		await settle();
		expect(api.autostartEnable).toHaveBeenCalledTimes(1);
	});

	it('leaves autostart off for No', async () => {
		const api = desktop(true);
		mount(createElement(StoreAutostartPromptManager));
		await settle();

		const prompt = mount(pushed[0]());
		act(() => prompt.querySelectorAll('button')[0].click());
		await settle();
		expect(api.autostartEnable).not.toHaveBeenCalled();
		expect(api.autostartDisable).not.toHaveBeenCalled();
	});

	it('shows nothing when the desktop app does not hand out the question', async () => {
		for (const claim of [false, undefined]) {
			desktop(claim);
			mount(createElement(StoreAutostartPromptManager));
		}
		state.electron = null;
		mount(createElement(StoreAutostartPromptManager));
		await settle();

		expect(pushed).toHaveLength(0);
	});

	it('waits for the main UI before asking', async () => {
		const api = desktop(true);
		setReady(false);
		mount(createElement(StoreAutostartPromptManager));
		setReady(true);
		state.variant = 'call';
		mount(createElement(StoreAutostartPromptManager));
		await settle();

		expect(api.autostartClaimStorePrompt).not.toHaveBeenCalled();
		expect(pushed).toHaveLength(0);
	});

	it('asks once the main UI becomes ready after mounting', async () => {
		const api = desktop(true);
		setReady(false);
		mount(createElement(StoreAutostartPromptManager));
		await settle();
		expect(api.autostartClaimStorePrompt).not.toHaveBeenCalled();

		act(() => setReady(true));
		await settle();
		expect(api.autostartClaimStorePrompt).toHaveBeenCalledTimes(1);
		expect(pushed).toHaveLength(1);
	});
});
