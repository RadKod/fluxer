// SPDX-License-Identifier: AGPL-3.0-or-later

import Sudo from '@app/features/auth/state/AuthSudo';
import SudoPrompt from '@app/features/auth/state/SudoPrompt';
import SessionManager from '@app/features/platform/state/AuthSession';
import {http} from '@app/features/platform/transport/RestTransport';
import UsernameSelection from '@app/features/user/state/UsernameSelection';
import Users from '@app/features/user/state/Users';
import {isUsernameSelectionRequired} from '@app/features/user/utils/UsernameSelectionGateUtils';

export function setupHttp(): void {
	http.installAuth(() => SessionManager.token);
	http.installResponseObserver((response) => {
		if (response.status === 403 && isUsernameSelectionRequired(response.body)) {
			UsernameSelection.requireSelection(SessionManager.currentAccountKey, Users.currentUser?.identityVersion);
		}
	});
	Sudo.init();
	SudoPrompt.init();
}
