// SPDX-License-Identifier: AGPL-3.0-or-later

// A personal referral code: 10 base32 characters from crypto randomness, 50 bits. The server
// generates and checks this shape; the client checks it before keeping a /r/<code> visit.
export const REFERRAL_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const REFERRAL_CODE_LENGTH = 10;
const REFERRAL_CODE_PATTERN = /^[a-z2-7]{10}$/;

export function isReferralCodeShape(code: string): boolean {
	return REFERRAL_CODE_PATTERN.test(code);
}
