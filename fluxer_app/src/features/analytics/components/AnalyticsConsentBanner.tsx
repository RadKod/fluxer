// SPDX-License-Identifier: AGPL-3.0-or-later

import {router} from '@app/app/Router';
import {Routes} from '@app/app/Routes';
import * as AnalyticsCommands from '@app/features/analytics/commands/AnalyticsCommands';
import styles from '@app/features/analytics/components/AnalyticsConsentBanner.module.css';
import AnalyticsConsent from '@app/features/analytics/state/AnalyticsConsent';
import {ExternalLink} from '@app/features/app/components/shared/ExternalLink';
import Config from '@app/features/app/config/Config';
import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {Button} from '@app/features/ui/button/Button';
import {isDesktop} from '@app/features/ui/utils/NativeUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

const BANNER_LABEL_DESCRIPTOR = msg({
	message: 'Google Analytics consent',
	comment: 'Accessible name of the analytics cookie consent banner.',
});
const BANNER_BODY_DESCRIPTOR = msg({
	message:
		'With your permission, we use Google Analytics to collect usage statistics that help us improve {productName}: which pages are opened and which features are used. Your messages, username, email, and server and channel details are not sent. The data is transferred abroad (Google, USA). You can withdraw your permission at any time: in Settings > Privacy when signed in, or with Cookie preferences at the bottom of the sign-in and registration pages.',
	comment:
		'Analytics cookie consent banner (legal text, KVKK), also shown to signed-out visitors. {productName} is the app name. "Settings > Privacy" names the settings tab and "Cookie preferences" the link on the sign-in pages where consent is withdrawn; keep both names as translated elsewhere. Do not call the data anonymous.',
});
const ACCEPT_DESCRIPTOR = msg({
	message: 'Accept',
	context: 'analytics-consent',
	comment: 'Analytics consent banner button that allows Google Analytics. Same weight as Reject.',
});
const REJECT_DESCRIPTOR = msg({
	message: 'Reject',
	context: 'analytics-consent',
	comment: 'Analytics consent banner button that refuses Google Analytics. Same weight as Accept.',
});
const POLICY_LINK_DESCRIPTOR = msg({
	message: 'Cookie and Privacy Policy',
	comment: 'Link from the analytics consent banner to the privacy policy.',
});

// Also the analytics host: with no measurement id configured start() does nothing and the banner never shows.
export const AnalyticsConsentBanner = observer(() => {
	const {i18n} = useLingui();
	useEffect(
		() =>
			AnalyticsCommands.start({
				measurementId: Config.PUBLIC_GA4_MEASUREMENT_ID,
				router,
				platform: isDesktop() ? 'desktop' : 'web',
				appVersion: Config.PUBLIC_BUILD_VERSION,
			}),
		[],
	);
	if (!AnalyticsConsent.shouldAsk) return null;
	return (
		<section
			className={styles.banner}
			aria-label={i18n._(BANNER_LABEL_DESCRIPTOR)}
			data-flx="analytics.analytics-consent-banner.banner"
		>
			<p className={styles.text} data-flx="analytics.analytics-consent-banner.text">
				{i18n._(BANNER_BODY_DESCRIPTOR, {productName: PRODUCT_NAME})}
			</p>
			<ExternalLink
				href={RuntimeConfig.privacyUrl ?? Routes.privacy()}
				className={styles.policyLink}
				data-flx="analytics.analytics-consent-banner.policy-link"
			>
				{i18n._(POLICY_LINK_DESCRIPTOR)}
			</ExternalLink>
			<div className={styles.actions} data-flx="analytics.analytics-consent-banner.actions">
				<Button
					variant="secondary"
					small
					onClick={AnalyticsCommands.accept}
					data-flx="analytics.analytics-consent-banner.button.accept"
				>
					{i18n._(ACCEPT_DESCRIPTOR)}
				</Button>
				<Button
					variant="secondary"
					small
					onClick={AnalyticsCommands.reject}
					data-flx="analytics.analytics-consent-banner.button.reject"
				>
					{i18n._(REJECT_DESCRIPTOR)}
				</Button>
			</div>
		</section>
	);
});
