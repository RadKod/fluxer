// SPDX-License-Identifier: AGPL-3.0-or-later

import {createLogger} from '@fluxer/logger/src/Logger';
import {renderEmailHtml} from '@pkgs/email/src/EmailHtml';
import type {EmailConfig, IEmailProvider, UserBouncedEmailChecker} from '@pkgs/email/src/EmailProviderTypes';
import {getEmailTemplate} from '@pkgs/email/src/email_i18n/EmailI18n';
import type {
	EmailTemplateVariables,
	ReporterOutcome,
	ReportReceivedTargetKind,
} from '@pkgs/email/src/email_i18n/EmailI18nTypes';
import type {EmailTemplateKey} from '@pkgs/email/src/email_i18n/EmailI18nTypes.generated';
import type {IEmailService} from '@pkgs/email/src/IEmailService';
import {ms} from 'itty-time';

const logger = createLogger('email-service');
const DEFAULT_LOCALE = 'en-US';

function capitalizeFirst(value: string, locale: string | null): string {
	const [first = ''] = value;
	let upper: string;
	try {
		upper = first.toLocaleUpperCase(locale || DEFAULT_LOCALE);
	} catch {
		upper = first.toUpperCase();
	}
	return [...upper].length === 1 ? upper + value.slice(first.length) : value;
}

function formatMinorUnitAmount(amountMinor: number, currency: string, locale: string | null): string {
	const formatter = new Intl.NumberFormat(locale || DEFAULT_LOCALE, {style: 'currency', currency});
	const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
	return formatter.format(amountMinor / 10 ** fractionDigits);
}

export class EmailService implements IEmailService {
	private readonly config: EmailConfig;
	private readonly provider: IEmailProvider | null;
	private readonly bouncedEmailChecker: UserBouncedEmailChecker | null;

	constructor(
		config: EmailConfig,
		provider: IEmailProvider | null = null,
		bouncedEmailChecker: UserBouncedEmailChecker | null = null,
	) {
		this.config = config;
		this.provider = provider;
		this.bouncedEmailChecker = bouncedEmailChecker;
	}

	async sendPasswordResetEmail(
		email: string,
		username: string,
		resetToken: string,
		locale: string | null = null,
	): Promise<boolean> {
		const resetUrl = `${this.config.appBaseUrl}/reset#token=${resetToken}`;
		return this.sendTemplatedEmail(email, 'password_reset', locale, {username, resetUrl}, resetUrl);
	}

	async sendEmailVerification(
		email: string,
		username: string,
		verificationToken: string,
		locale: string | null = null,
	): Promise<boolean> {
		const verifyUrl = `${this.config.appBaseUrl}/verify#token=${verificationToken}`;
		return this.sendTemplatedEmail(email, 'email_verification', locale, {username, verifyUrl}, verifyUrl);
	}

	async sendIpAuthorizationEmail(
		email: string,
		username: string,
		authorizationToken: string,
		ipAddress: string,
		location: string,
		locale: string | null = null,
	): Promise<boolean> {
		const authUrl = `${this.config.appBaseUrl}/authorize-ip#token=${authorizationToken}`;
		return this.sendTemplatedEmail(
			email,
			'ip_authorization',
			locale,
			{username, authUrl, ipAddress, location},
			authUrl,
		);
	}

	async sendSelfDeletionScheduledEmail(
		email: string,
		username: string,
		deletionDate: Date,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'self_deletion_scheduled', locale, {username, deletionDate});
	}

	async sendAccountDeletionRequestedEmail(
		email: string,
		username: string,
		deletionDate: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'account_deletion_scheduled_requested', locale, {
			username,
			deletion_date: deletionDate,
			safety_email: this.config.safetyEmail,
		});
	}

	async sendAccountDeletionInactivityEmail(
		email: string,
		username: string,
		deletionDate: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'account_deletion_scheduled_inactivity', locale, {
			username,
			deletion_date: deletionDate,
			support_email: this.config.supportEmail,
		});
	}

	async sendAccountDeletionCancelledEmail(
		email: string,
		username: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'account_deletion_cancelled', locale, {
			username,
			safety_email: this.config.safetyEmail,
		});
	}

	async sendEnforcementNoticeEmail(
		email: string,
		variables: EmailTemplateVariables['enforcement_notice'],
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'enforcement_notice', locale, variables);
	}

	async sendEnforcementEndedEmail(
		email: string,
		variables: EmailTemplateVariables['enforcement_ended'],
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'enforcement_ended', locale, variables);
	}

	async sendInactivityWarningEmail(
		email: string,
		username: string,
		deletionDate: Date,
		lastActiveDate: Date,
		locale: string | null = null,
	): Promise<boolean> {
		const loginUrl = `${this.config.appBaseUrl}/login`;
		return this.sendTemplatedEmail(
			email,
			'inactivity_warning',
			locale,
			{username, deletionDate, lastActiveDate, loginUrl, support_email: this.config.supportEmail},
			loginUrl,
		);
	}

	async sendHarvestCompletedEmail(
		email: string,
		username: string,
		downloadUrl: string,
		totalMessages: number,
		fileSize: number,
		expiresAt: Date,
		locale: string | null = null,
	): Promise<boolean> {
		const fileSizeMB = Number.parseFloat((fileSize / 1024 / 1024).toFixed(2));
		return this.sendTemplatedEmail(
			email,
			'harvest_completed',
			locale,
			{username, downloadUrl, totalMessages, fileSizeMB, expiresAt, support_email: this.config.supportEmail},
			downloadUrl,
		);
	}

	async sendGiftChargebackNotification(
		email: string,
		username: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'gift_chargeback_notification', locale, {
			username,
			support_email: this.config.supportEmail,
		});
	}

	async sendReferralRewardReadyEmail(email: string, username: string, locale: string | null = null): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'referral_reward_ready', locale, {username});
	}

	async sendReportResolvedEmail(
		email: string,
		username: string,
		reportId: string,
		publicComment: string,
		outcome: ReporterOutcome,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'report_resolved', locale, {
			username,
			reportId,
			publicComment,
			hasComment: publicComment ? 'yes' : 'no',
			outcome,
			appeals_email: this.config.appealsEmail,
		});
	}

	async sendDsaReportResolvedEmail(
		email: string,
		reportId: string,
		publicComment: string,
		outcome: ReporterOutcome,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'dsa_report_resolved', locale, {
			reportId,
			publicComment,
			hasComment: publicComment ? 'yes' : 'no',
			outcome,
			appeals_email: this.config.appealsEmail,
		});
	}

	async sendReportReceivedEmail(
		email: string,
		reportId: string,
		targetKind: ReportReceivedTargetKind,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'report_received', locale, {reportId, targetKind});
	}

	async sendDsaReportVerificationCode(
		email: string,
		code: string,
		expiresAt: Date,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'dsa_report_verification', locale, {code, expiresAt});
	}

	async sendRegistrationApprovedEmail(email: string, username: string, locale: string | null = null): Promise<boolean> {
		const channelsUrl = `${this.config.appBaseUrl}/channels/@me`;
		return this.sendTemplatedEmail(email, 'registration_approved', locale, {username, channelsUrl}, channelsUrl);
	}

	async sendPasswordChangeVerification(
		email: string,
		username: string,
		code: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'password_change_verification', locale, {
			username,
			code,
			expiresAt: new Date(Date.now() + ms('10 minutes')),
		});
	}

	async sendMfaBackupCodesVerification(
		email: string,
		username: string,
		code: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'mfa_backup_codes_view', locale, {
			username,
			code,
			expiresAt: new Date(Date.now() + ms('10 minutes')),
		});
	}

	async sendEmailChangeOriginal(
		email: string,
		username: string,
		code: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'email_change_original', locale, {
			username,
			code,
			expiresAt: new Date(Date.now() + ms('10 minutes')),
		});
	}

	async sendEmailChangeNew(
		email: string,
		username: string,
		code: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'email_change_new', locale, {
			username,
			code,
			expiresAt: new Date(Date.now() + ms('10 minutes')),
		});
	}

	async sendEmailChangeRevert(
		email: string,
		username: string,
		newEmail: string,
		token: string,
		locale: string | null = null,
	): Promise<boolean> {
		const revertUrl = `${this.config.appBaseUrl}/wasntme#token=${token}`;
		return this.sendTemplatedEmail(email, 'email_change_revert', locale, {username, revertUrl, newEmail}, revertUrl);
	}

	async sendDonationMagicLink(
		email: string,
		_token: string,
		manageUrl: string,
		expiresAt: Date,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(email, 'donation_magic_link', locale, {manageUrl, expiresAt}, manageUrl);
	}

	async sendDonationConfirmation(
		email: string,
		amountCents: number,
		currency: string,
		interval: string,
		manageUrl: string,
		locale: string | null = null,
	): Promise<boolean> {
		return this.sendTemplatedEmail(
			email,
			'donation_confirmation',
			locale,
			{
				amount: formatMinorUnitAmount(amountCents, currency, locale),
				currency: currency.toUpperCase(),
				interval,
				manageUrl,
			},
			manageUrl,
		);
	}

	private async sendTemplatedEmail<T extends EmailTemplateKey>(
		email: string,
		templateKey: T,
		locale: string | null,
		variables: EmailTemplateVariables[T],
		actionUrl?: string,
	): Promise<boolean> {
		const named =
			'username' in variables && typeof variables.username === 'string'
				? {...variables, username: capitalizeFirst(variables.username, locale)}
				: variables;
		const result = getEmailTemplate(templateKey, locale, named, this.config.productName);
		if (!result.ok) {
			logger.error({key: templateKey, locale: result.locale, error: result.error}, 'Failed to resolve email template');
			return false;
		}
		const {subject, body, button} = result.value;
		if (!this.config.enabled || !this.provider) {
			logger.info(
				{templateKey},
				`Email service disabled. Would have sent:\nTo: ${email}\nSubject: ${subject}\n\n${body}`,
			);
			return true;
		}
		if (this.bouncedEmailChecker) {
			const bounced = await this.bouncedEmailChecker.isEmailBounced(email);
			if (bounced) {
				logger.warn({email}, 'Refusing to send email to bounced address - email marked as hard bounced');
				return false;
			}
		}
		return this.provider.sendEmail({
			to: email,
			from: {email: this.config.fromEmail, name: this.config.fromName},
			...(this.config.replyTo ? {replyTo: this.config.replyTo} : {}),
			subject,
			text: body,
			...(this.config.html && {
				html: renderEmailHtml({
					subject,
					body,
					locale: result.locale,
					branding: this.config.html,
					action: button && actionUrl ? {url: actionUrl, label: button} : undefined,
				}),
			}),
		});
	}
}
