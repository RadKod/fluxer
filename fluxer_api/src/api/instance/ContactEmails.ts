// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';

export interface ContactEmails {
	appealsEmail: string | null;
	privacyEmail: string | null;
	safetyEmail: string | null;
	supportEmail: string | null;
}

// Micup: sanalyer runs with self_hosted=true yet answers its own support, appeals, privacy and safety mail, so these
// addresses do not depend on Config.instance.selfHosted the way upstream's fluxer.com addresses do.
const MICUP_CONTACT_EMAIL = 'info@sanalyer.com';

const CONTACT_EMAILS: ContactEmails = {
	appealsEmail: MICUP_CONTACT_EMAIL,
	privacyEmail: MICUP_CONTACT_EMAIL,
	safetyEmail: MICUP_CONTACT_EMAIL,
	supportEmail: MICUP_CONTACT_EMAIL,
};

const HOSTED_LEGAL_ADDRESS =
	'Fluxer Platform AB (org. no. 559537-3993, registered office Haninge, Sweden), c/o Embassy House, Östgötagatan 12, 116 25 Stockholm, Sweden';

export function resolveLegalAddress(): string | null {
	return Config.instance.selfHosted ? null : HOSTED_LEGAL_ADDRESS;
}

export function resolveContactEmails(): ContactEmails {
	return CONTACT_EMAILS;
}
