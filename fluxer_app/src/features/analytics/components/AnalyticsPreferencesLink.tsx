// SPDX-License-Identifier: AGPL-3.0-or-later

import * as AnalyticsCommands from '@app/features/analytics/commands/AnalyticsCommands';
import styles from '@app/features/analytics/components/AnalyticsPreferencesLink.module.css';
import AnalyticsConsent from '@app/features/analytics/state/AnalyticsConsent';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const COOKIE_PREFERENCES_DESCRIPTOR = msg({
	message: 'Cookie preferences',
	comment:
		'Link under the sign-in and registration forms. Forgets the Google Analytics choice and shows the consent banner again, so a signed-out visitor can withdraw consent.',
});

// Settings > Privacy needs a session; this is the withdrawal path on the auth pages, where the banner also shows.
export const AnalyticsPreferencesLink = observer(() => {
	const {i18n} = useLingui();
	if (!AnalyticsConsent.isAvailable || AnalyticsConsent.shouldAsk) return null;
	return (
		<div className={styles.row} data-flx="analytics.analytics-preferences-link.row">
			<button
				type="button"
				className={styles.link}
				onClick={AnalyticsCommands.resetChoice}
				data-flx="analytics.analytics-preferences-link.link"
			>
				{i18n._(COOKIE_PREFERENCES_DESCRIPTOR)}
			</button>
		</div>
	);
});
