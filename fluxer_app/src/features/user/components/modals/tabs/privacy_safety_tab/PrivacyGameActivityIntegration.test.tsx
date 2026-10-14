// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsSection', () => ({
	SettingsSection: ({id, children}: {id: string; children: ReactNode}) => createElement('section', {id}, children),
}));
vi.mock('@app/features/game_activity/components/GameActivitySettingsTab', () => ({
	GameActivitySettingsTab: () => createElement('div', {'data-game-settings': true}, 'Game activity controls'),
}));
vi.mock('@app/features/analytics/components/AnalyticsSettingsSection', () => ({AnalyticsSettingsSection: () => null}));
vi.mock('@app/features/auth/state/Accounts', () => ({default: {currentAccountKey: 'micup.test::owner'}}));
vi.mock('@app/features/user/hooks/useUserSettingsMutationController', () => ({
	useUserSettingsMutationController: () => ({}),
}));
vi.mock('@app/features/user/components/modals/tabs/privacy_safety_tab/ActiveNowTab', () => ({
	ActiveNowTabContent: () => null,
}));
vi.mock('@app/features/user/components/modals/tabs/privacy_safety_tab/CommunicationTab', () => ({
	CommunicationTabContent: () => null,
}));
vi.mock('@app/features/user/components/modals/tabs/privacy_safety_tab/ConnectionsTab', () => ({
	ConnectionsTabContent: () => null,
}));
vi.mock('@app/features/user/components/modals/tabs/privacy_safety_tab/DataDeletionTab', () => ({
	DataDeletionTabContent: () => null,
}));
vi.mock('@app/features/user/components/modals/tabs/privacy_safety_tab/DataExportTab', () => ({
	DataExportTabContent: () => null,
}));
vi.mock('@app/features/user/components/modals/tabs/privacy_safety_tab/ProfilePrivacyTab', () => ({
	ProfilePrivacyTabContent: () => null,
}));
vi.mock('@app/features/user/components/modals/tabs/privacy_safety_tab/SensitiveContentTab', () => ({
	SensitiveContentTabContent: () => null,
}));

describe('Privacy dashboard game activity integration', () => {
	it('mounts the controls at the registered search section', async () => {
		const {PrivacyDashboardContent} = await import(
			'@app/features/user/components/modals/tabs/privacy_safety_tab/PrivacySafetyTabInline'
		);
		const {privacySafetySections} = await import(
			'@app/features/user/components/settings_utils/section_registry/PrivacySafetySections'
		);
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(PrivacyDashboardContent)));
			expect(container.querySelector('#game-activity [data-game-settings]')).not.toBeNull();
			expect(privacySafetySections.find((section) => section.id === 'game-activity')).toMatchObject({
				id: 'game-activity',
				tabType: 'privacy_safety',
				label: {message: 'Game activity'},
			});
		} finally {
			act(() => root.unmount());
		}
	});
});
