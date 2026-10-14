// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({evaluations: 0, push: vi.fn()}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/guild/components/modals/GuildSettingsModal', () => ({GuildSettingsModal: () => null}));
vi.mock('@app/features/boost/components/GuildBoostPanel', () => {
	state.evaluations++;
	return {GuildBoostPanel: () => null};
});
vi.mock('@app/features/app/components/alerts/GenericErrorModalCommands', () => ({showGenericErrorModal: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	modal: (render: () => React.ReactElement) => render,
	pushWithKey: state.push,
}));

const {openGuildBoostPanel, openGuildBoostSettings} = await import(
	'@app/features/boost/commands/GuildBoostPanelCommands'
);
const {GuildSettingsModal} = await import('@app/features/guild/components/modals/GuildSettingsModal');

describe('lazy community boost entry', () => {
	it('does not load the panel until selected, and shares one modal key with the singleton boost store', async () => {
		expect(state.evaluations).toBe(0);
		openGuildBoostPanel('42');
		await vi.dynamicImportSettled();
		expect(state.evaluations).toBe(1);
		expect(state.push.mock.calls[0]?.[1]).toBe('guild-boost-panel');
		const render = state.push.mock.calls[0]?.[0] as () => React.ReactElement<{guildId: string}>;
		expect(render().props.guildId).toBe('42');
		openGuildBoostPanel('43');
		await vi.dynamicImportSettled();
		expect(state.push.mock.calls[1]?.[1]).toBe('guild-boost-panel');
	});
	it('replaces the panel with the existing settings under the same key, preserving booster management', () => {
		state.push.mockClear();
		openGuildBoostSettings('42');
		expect(state.push.mock.calls[0]?.[1]).toBe('guild-boost-panel');
		const render = state.push.mock.calls[0]?.[0] as () => React.ReactElement;
		expect(render().type).toBe(GuildSettingsModal);
		expect(render().props).toMatchObject({guildId: '42', initialTab: 'boost', initialMobileTab: 'boost'});
	});
});
