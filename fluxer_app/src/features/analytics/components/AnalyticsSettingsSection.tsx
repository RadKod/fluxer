// SPDX-License-Identifier: AGPL-3.0-or-later

import * as AnalyticsCommands from '@app/features/analytics/commands/AnalyticsCommands';
import AnalyticsConsent from '@app/features/analytics/state/AnalyticsConsent';
import {SettingsSection} from '@app/features/app/components/dialogs/shared/SettingsSection';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const SECTION_TITLE_DESCRIPTOR = msg({
	message: 'Analytics cookies',
	comment: 'Privacy settings section title for the Google Analytics consent switch.',
});
const SWITCH_LABEL_DESCRIPTOR = msg({
	message: 'Allow Google Analytics',
	comment: 'Privacy settings switch that gives or withdraws Google Analytics consent.',
});
const SWITCH_DESCRIPTION_DESCRIPTOR = msg({
	message:
		'Usage statistics (pages opened, features used) go to Google Analytics in the USA. Your messages, username, email, and server and channel details are not sent. Turning this off stops collection and deletes the analytics cookies.',
	comment: 'Description under the Google Analytics consent switch (legal text, KVKK). Do not call the data anonymous.',
});

// Shown only while a measurement id is configured; withdrawing is one switch, as easy as giving consent.
export const AnalyticsSettingsSection = observer(() => {
	const {i18n} = useLingui();
	if (!AnalyticsConsent.isAvailable) return null;
	return (
		<SettingsSection
			id="analytics"
			tabType="privacy_safety"
			linkable={false}
			title={i18n._(SECTION_TITLE_DESCRIPTOR)}
			data-flx="analytics.analytics-settings-section.settings-section"
		>
			<Switch
				label={i18n._(SWITCH_LABEL_DESCRIPTOR)}
				description={i18n._(SWITCH_DESCRIPTION_DESCRIPTOR)}
				value={AnalyticsConsent.isGranted}
				onChange={(value) => (value ? AnalyticsCommands.accept() : AnalyticsCommands.reject())}
				data-flx="analytics.analytics-settings-section.switch.analytics-consent"
			/>
		</SettingsSection>
	);
});
