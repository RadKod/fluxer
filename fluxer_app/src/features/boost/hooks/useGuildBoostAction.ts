// SPDX-License-Identifier: AGPL-3.0-or-later

import GuildBoosts from '@app/features/boost/state/GuildBoosts';
import {showGuildErrorModal} from '@app/features/guild/components/alerts/GuildErrorModalUtils';
import {
	SOMETHING_WENT_WRONG_DESCRIPTOR,
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {useLingui} from '@lingui/react/macro';
import {useCallback, useRef, useState} from 'react';

export function useGuildBoostAction() {
	const {i18n} = useLingui();
	const [acting, setActing] = useState(false);
	const inFlight = useRef(false);
	const showError = useCallback(() => {
		showGuildErrorModal({
			title: i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR),
			message: i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR),
			dataFlx: 'boost.action.error-modal',
		});
	}, [i18n]);
	const handleBoost = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setActing(true);
		try {
			await GuildBoosts.boost();
		} catch {
			showError();
		} finally {
			inFlight.current = false;
			setActing(false);
		}
	}, [showError]);
	return {acting, handleBoost, showError};
}
