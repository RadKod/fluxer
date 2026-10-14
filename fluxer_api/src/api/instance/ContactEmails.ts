// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ContactEmails {
	appealsEmail: string | null;
	safetyEmail: string | null;
	supportEmail: string | null;
}

// Micup: sanalyer runs with self_hosted=true yet answers its own support, appeals and safety mail, so these
// addresses do not depend on Config.instance.selfHosted the way upstream's fluxer.com addresses do.
const MICUP_CONTACT_EMAIL = 'info@sanalyer.com';

const CONTACT_EMAILS: ContactEmails = {
	appealsEmail: MICUP_CONTACT_EMAIL,
	safetyEmail: MICUP_CONTACT_EMAIL,
	supportEmail: MICUP_CONTACT_EMAIL,
};

export function resolveContactEmails(): ContactEmails {
	return CONTACT_EMAILS;
}
