// SPDX-License-Identifier: AGPL-3.0-or-later

export interface EmailConfig {
	enabled: boolean;
	fromEmail: string;
	fromName: string;
	replyTo?: string | null;
	appBaseUrl: string;
	appealsEmail: string | null;
	safetyEmail: string | null;
	supportEmail: string | null;
	productName: string;
	html?: EmailHtmlBranding | null;
}

export interface EmailHtmlBranding {
	productName: string;
	logoUrl: string | null;
	headerColor: string | null;
	footer: Readonly<Record<string, string>>;
}

export interface EmailMessage {
	to: string;
	from: {
		email: string;
		name: string;
	};
	replyTo?: string;
	subject: string;
	text: string;
	html?: string;
}

export interface IEmailProvider {
	sendEmail(message: EmailMessage): Promise<boolean>;
}

export interface UserBouncedEmailChecker {
	isEmailBounced(email: string): Promise<boolean>;
}
