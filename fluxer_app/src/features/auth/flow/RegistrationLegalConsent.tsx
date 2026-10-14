// SPDX-License-Identifier: AGPL-3.0-or-later

import {ExternalLink} from '@app/features/app/components/shared/ExternalLink';
import type {RuntimeConfigSnapshot} from '@app/features/app/state/InstanceSnapshotStore';
import styles from '@app/features/auth/flow/AuthPageStyles.module.css';
import type {LegalConsentRequirement} from '@app/features/auth/flow/SubmitTooltip';
import DeveloperOptions from '@app/features/devtools/state/DeveloperOptions';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import {flxElementClassName} from '@app/lib/react';
import {Trans} from '@lingui/react/macro';
import type {ReactElement} from 'react';

export interface RegistrationLegalConsentConfig {
	termsUrl: string | null;
	privacyUrl: string | null;
	requirement: LegalConsentRequirement | null;
	collectDateOfBirth: boolean;
}

function resolveLegalConsentRequirement(
	termsUrl: string | null,
	privacyUrl: string | null,
): LegalConsentRequirement | null {
	if (termsUrl != null && privacyUrl != null) {
		return 'terms_and_privacy';
	}
	if (termsUrl != null) {
		return 'terms';
	}
	if (privacyUrl != null) {
		return 'privacy';
	}
	return null;
}

export function getRegistrationLegalConsentConfig(
	runtimeSnapshot: RuntimeConfigSnapshot,
	showLegalConsent = true,
): RegistrationLegalConsentConfig {
	const isSelfHosted = DeveloperOptions.selfHostedModeOverride || runtimeSnapshot.features.self_hosted;
	const termsUrl =
		runtimeSnapshot.appPublic.legal.terms_url ?? (isSelfHosted ? null : `${runtimeSnapshot.marketingEndpoint}/terms`);
	const privacyUrl =
		runtimeSnapshot.appPublic.legal.privacy_url ??
		(isSelfHosted ? null : `${runtimeSnapshot.marketingEndpoint}/privacy`);
	const collectDateOfBirth = runtimeSnapshot.appPublic.registration.collect_date_of_birth;
	if (!showLegalConsent) {
		return {termsUrl, privacyUrl, requirement: null, collectDateOfBirth};
	}
	return {termsUrl, privacyUrl, requirement: resolveLegalConsentRequirement(termsUrl, privacyUrl), collectDateOfBirth};
}

interface RegistrationLegalConsentProps {
	checked: boolean;
	config: RegistrationLegalConsentConfig;
	onChange: (checked: boolean) => void;
}

function RegistrationLegalConsentLabel({config}: {config: RegistrationLegalConsentConfig}): ReactElement | null {
	if (config.requirement === 'terms_and_privacy' && config.termsUrl != null && config.privacyUrl != null) {
		return (
			<Trans>
				I agree to the{' '}
				<ExternalLink
					href={config.termsUrl}
					className={styles.policyLink}
					data-flx="auth.flow.registration-legal-consent.policy-link.terms"
				>
					Terms of service
				</ExternalLink>{' '}
				and{' '}
				<ExternalLink
					href={config.privacyUrl}
					className={styles.policyLink}
					data-flx="auth.flow.registration-legal-consent.policy-link.privacy"
				>
					Privacy policy
				</ExternalLink>
			</Trans>
		);
	}
	if (config.requirement === 'terms' && config.termsUrl != null) {
		return (
			<Trans>
				I agree to the{' '}
				<ExternalLink
					href={config.termsUrl}
					className={styles.policyLink}
					data-flx="auth.flow.registration-legal-consent.policy-link.terms-only"
				>
					Terms of service
				</ExternalLink>
			</Trans>
		);
	}
	if (config.requirement === 'privacy' && config.privacyUrl != null) {
		return (
			<Trans>
				I agree to the{' '}
				<ExternalLink
					href={config.privacyUrl}
					className={styles.policyLink}
					data-flx="auth.flow.registration-legal-consent.policy-link.privacy-only"
				>
					Privacy policy
				</ExternalLink>
			</Trans>
		);
	}
	return null;
}

export function RegistrationLegalConsent({checked, config, onChange}: RegistrationLegalConsentProps) {
	if (config.requirement == null) return null;
	const consentRow = (
		<flx-auth-registration-legal-consent
			className={flxElementClassName(styles.consentRow)}
			data-flx="auth.flow.registration-legal-consent.consent-row"
		>
			<Checkbox
				checked={checked}
				onChange={onChange}
				data-flx="auth.flow.registration-legal-consent.checkbox.consent-change"
			>
				<span className={styles.consentLabel} data-flx="auth.flow.registration-legal-consent.consent-label">
					<RegistrationLegalConsentLabel
						config={config}
						data-flx="auth.flow.registration-legal-consent.registration-legal-consent-label"
					/>
				</span>
			</Checkbox>
		</flx-auth-registration-legal-consent>
	);
	// Micup: a new account of 16 or older starts with a public profile. Said only where registration
	// asks the date of birth: without one the server starts the profile on shared communities.
	// This notice follows the registration target rather than the active account.
	if (!config.collectDateOfBirth) return consentRow;
	return (
		<>
			{consentRow}
			<p className={styles.consentLabel} data-flx="auth.flow.registration-legal-consent.public-profile-note">
				<Trans comment="Registration notice under the terms consent box. Settings > Privacy is where profile visibility is changed. Legal-effect text, approved before release.">
					If you are 16 or older, your profile starts public. You can change who sees it any time in Settings &gt;
					Privacy.
				</Trans>
			</p>
		</>
	);
}
