// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ReactElement} from 'react';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const native = vi.hoisted(() => ({windows: false, openExternalUrl: vi.fn()}));
const pushed = vi.hoisted((): {render: (() => ReactElement) | null} => ({render: null}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: {message: string}) => descriptor}));
vi.mock('@lingui/core', () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({Combobox: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	modal: (render: () => ReactElement) => render,
	pushWithKey: (render: () => ReactElement) => {
		pushed.render = render;
	},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	isCanaryDesktop: () => false,
	isNativeWindows: () => native.windows,
	openExternalUrl: native.openExternalUrl,
}));

const {pushUnsupportedUpdateModal} = await import('@app/features/updater/commands/UpdaterModalCommands');

function pressPrimary(): void {
	pushUnsupportedUpdateModal('managed-package');
	const render = pushed.render;
	if (!render) throw new Error('no modal pushed');
	(render().props as {onPrimary: () => void}).onPrimary();
}

describe('system-managed install update button', () => {
	beforeEach(() => {
		native.openExternalUrl.mockClear();
		pushed.render = null;
	});

	it('opens the sanalyer Microsoft Store page from the Store copy on Windows', () => {
		native.windows = true;

		pressPrimary();

		expect(native.openExternalUrl).toHaveBeenCalledWith('ms-windows-store://pdp/?ProductId=9P1SNJ2H2W9H');
	});

	it('keeps the software center link for Flatpak on Linux', () => {
		native.windows = false;

		pressPrimary();

		expect(native.openExternalUrl).toHaveBeenCalledWith('appstream://app.fluxer.Fluxer');
	});
});
