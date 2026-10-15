// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import GlobalShortcuts from '@app/features/input/state/GlobalShortcuts';
import {openMacPermissionsModal} from '@app/features/permissions/system/commands/MacPermissionsModalCommands';
import {macPermissionNameDescriptor} from '@app/features/permissions/system/components/useMacPermissionControl';
import MacPermissions from '@app/features/permissions/system/state/MacPermissions';
import type {NativePermissionResult} from '@app/features/permissions/system/utils/NativePermissions';
import {Button} from '@app/features/ui/button/Button';
import {WarningAlert} from '@app/features/ui/warning_alert/WarningAlert';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const GLOBAL_SHORTCUTS_PERMISSION_LIMITED_DESCRIPTOR = msg({
	message: 'Global shortcuts only work while {productName} is focused until {permissionName} is enabled.',
	comment:
		'Keybinds settings warning shown on macOS when Input Monitoring is missing, so system-wide shortcuts (mute, deafen, push-to-talk) do not fire while the app is in the background. {productName} is the app name and {permissionName} is the macOS permission name.',
});
const ENABLE_PLATFORM_PERMISSION_DESCRIPTOR = msg({
	message: 'Enable {permissionName} permission',
	comment: 'Keybinds settings CTA label for opening a platform permission prompt.',
});

export interface MacInputMonitoringWarningState {
	isMacDesktop: boolean;
	hookError: 'permission' | 'start-failed' | null;
	hooksActive: boolean;
	permissionsHydrated: boolean;
	permissionStatus: NativePermissionResult;
}

// The main process reports hookError 'permission' once it tried to start the input hook without Input Monitoring.
// If the hook was never tried (the intro permission step was skipped and nothing has synced yet), the TCC status
// that MacPermissions refreshes on start and on window focus still tells us the hook cannot run.
export function shouldShowMacInputMonitoringWarning(state: MacInputMonitoringWarningState): boolean {
	if (!state.isMacDesktop) return false;
	if (state.hookError === 'permission') return true;
	if (state.hooksActive) return false;
	return (
		state.permissionsHydrated && (state.permissionStatus === 'denied' || state.permissionStatus === 'not-determined')
	);
}

export const MacInputMonitoringShortcutsAlert: React.FC<{'data-flx'?: string}> = observer(
	({'data-flx': dataFlx = 'user.keybinds-tab.mac-input-monitoring-alert'}) => {
		const {i18n} = useLingui();
		const visible = shouldShowMacInputMonitoringWarning({
			isMacDesktop: MacPermissions.isNativeMacDesktop,
			hookError: GlobalShortcuts.hookError,
			hooksActive: GlobalShortcuts.hooksActive,
			permissionsHydrated: MacPermissions.isHydrated,
			permissionStatus: MacPermissions.statuses['input-monitoring'],
		});
		if (!visible) return null;
		const permissionName = i18n._(macPermissionNameDescriptor('input-monitoring'));
		return (
			<WarningAlert
				actions={
					<Button
						variant="primary"
						small={true}
						onClick={() => openMacPermissionsModal('input-monitoring')}
						data-flx={`${dataFlx}.button.open-input-monitoring-modal`}
					>
						{i18n._(ENABLE_PLATFORM_PERMISSION_DESCRIPTOR, {permissionName})}
					</Button>
				}
				data-flx={dataFlx}
			>
				{i18n._(GLOBAL_SHORTCUTS_PERMISSION_LIMITED_DESCRIPTOR, {
					productName: RuntimeConfig.productName,
					permissionName,
				})}
			</WarningAlert>
		);
	},
);
