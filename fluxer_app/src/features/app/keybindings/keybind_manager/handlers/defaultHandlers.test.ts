// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {HandlerHost} from '@app/features/app/keybindings/keybind_manager/handlers/types';
import type {KeybindHandler} from '@app/features/app/keybindings/keybind_manager/shared';
import type {I18n} from '@lingui/core';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/user/state/SyncedField', () => ({
	makeSyncedField: vi.fn(async () => {}),
	setSyncedFieldSessionManager: vi.fn(),
	setSyncedFieldUserSettings: vi.fn(),
}));
for (const path of [
	'@app/app/Routes',
	'@app/features/app/components/dialogs/ConfirmModal',
	'@app/features/app/state/RuntimeConfig',
	'@app/features/channel/components/ChannelComposerDismissal',
	'@app/features/channel/components/modals/CreateDMModal',
	'@app/features/channel/state/Channels',
	'@app/features/devtools/commands/VoiceStateCommands',
	'@app/features/guild/components/modals/AddGuildModal',
	'@app/features/i18n/utils/CommonMessageDescriptors',
	'@app/features/inbox/commands/InboxCommands',
	'@app/features/inbox/state/Inbox',
	'@app/features/input/components/modals/KeyboardShortcutsCheatsheetModal',
	'@app/features/input/state/InputKeybind',
	'@app/features/messaging/state/MessageEdit',
	'@app/features/messaging/state/SavedMessages',
	'@app/features/messaging/utils/ChannelTextareaFocusUtils',
	'@app/features/messaging/utils/ExternalLinkUtils',
	'@app/features/messaging/utils/MessageLinkUtils',
	'@app/features/messaging/utils/MessageNavigator',
	'@app/features/navigation/state/Navigation',
	'@app/features/navigation/state/SelectedChannel',
	'@app/features/navigation/utils/RouterUtils',
	'@app/features/notification/state/MentionFeed',
	'@app/features/permissions/state/Permission',
	'@app/features/read_state/commands/ReadStateCommands',
	'@app/features/read_state/state/ReadStates',
	'@app/features/search/state/QuickSwitcher',
	'@app/features/theme_studio/commands/ThemeStudioCommands',
	'@app/features/ui/commands/ModalCommands',
	'@app/features/ui/commands/TextCopyCommands',
	'@app/features/app/components/dialogs/LoadableSettingsModals',
	'@app/features/auth/commands/AccountSwitcherModalCommands',
	'@app/features/auth/state/AccountSwitcherAccounts',
	'@app/features/auth/state/Accounts',
	'@app/features/auth/utils/AccountSwitcherModalUtils',
	'@app/features/threads/utils/ThreadViewUtils',
	'@app/features/voice/components/VoiceMessageComposerModal',
	'@app/features/voice/engine/MediaEngineFacade',
	'@app/features/voice/state/LocalVoiceState',
	'@app/features/voice/utils/CallUtils',
	'@app/features/voice/utils/VoiceMessageDescriptors',
]) {
	vi.doMock(path, () => ({default: {}}));
}

const {default: Accessibility} = await import('@app/features/accessibility/state/Accessibility');
const {registerDefaultKeybindHandlers} = await import(
	'@app/features/app/keybindings/keybind_manager/handlers/defaultHandlers'
);

describe('system_zoom_reset keybind', () => {
	it('resets app zoom to the 95% default', () => {
		const handlers = new Map<string, KeybindHandler>();
		const host = {
			register: (action, handler) => {
				handlers.set(action, handler);
			},
		} as HandlerHost;
		registerDefaultKeybindHandlers(host, {} as I18n);
		Accessibility.updateSettings({zoomLevel: 1.25});

		handlers.get('system_zoom_reset')?.({type: 'press'} as Parameters<KeybindHandler>[0]);

		expect(Accessibility.zoomLevel).toBe(0.95);
	});
});
