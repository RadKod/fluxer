// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';

export interface ContactEmails {
	appealsEmail: string | null;
	safetyEmail: string | null;
	supportEmail: string | null;
}

// Micup support address; appeals and safety share it.
const MICUP_CONTACT_EMAIL = 'info@sanalyer.com';

const HOSTED_CONTACT_EMAILS: ContactEmails = {
	appealsEmail: MICUP_CONTACT_EMAIL,
	safetyEmail: MICUP_CONTACT_EMAIL,
	supportEmail: MICUP_CONTACT_EMAIL,
};

const SELF_HOSTED_CONTACT_EMAILS: ContactEmails = {
	appealsEmail: null,
	safetyEmail: null,
	supportEmail: null,
};

export function resolveContactEmails(): ContactEmails {
	return Config.instance.selfHosted ? SELF_HOSTED_CONTACT_EMAILS : HOSTED_CONTACT_EMAILS;
}
