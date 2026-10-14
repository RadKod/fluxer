// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {displayNamePassesForMicup, nameContainsMicup} from '@fluxer/schema/src/primitives/MicupBrandGuard';
import {
	MAX_STRING_PROCESSING_LENGTH,
	normalizeString,
	normalizeWhitespace,
	removeStandaloneSurrogates,
	stripInvisibles,
	stripVariationSelectors,
	withOpenApiType,
	withStringLengthRangeValidation,
} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const EMAIL_LOCAL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DISCRIMINATOR_REGEX = /^\d{1,4}$/;
const FLUXER_TAG_REGEX = /^[a-zA-Z0-9_]+$/;

function sanitizeUsername(value: string): string {
	if (value.length > MAX_STRING_PROCESSING_LENGTH) {
		throw new Error(ValidationErrorCodes.STRING_LENGTH_INVALID);
	}
	let s = normalizeString(value);
	s = removeStandaloneSurrogates(s);
	s = stripInvisibles(s);
	s = stripVariationSelectors(s);
	s = normalizeWhitespace(s);
	return s;
}

export const EmailType = withOpenApiType(
	z
		.string()
		.overwrite(normalizeString)
		.pipe(
			withStringLengthRangeValidation(
				z.email(ValidationErrorCodes.INVALID_EMAIL_FORMAT),
				1,
				254,
				ValidationErrorCodes.EMAIL_LENGTH_INVALID,
			),
		)
		.refine((value: string) => {
			const atIndex = value.indexOf('@');
			if (atIndex === -1) return false;
			const local = value.slice(0, atIndex);
			return EMAIL_LOCAL_REGEX.test(local);
		}, ValidationErrorCodes.INVALID_EMAIL_LOCAL_PART),
	'EmailType',
);

const EMAIL_BLOCKLIST_DOMAIN_REGEX =
	/^@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export const EmailBlocklistEntryType = withOpenApiType(
	z
		.string()
		.overwrite(normalizeString)
		.refine(
			(value: string) =>
				EMAIL_BLOCKLIST_DOMAIN_REGEX.test(value) ? value.length <= 254 : EmailType.safeParse(value).success,
			ValidationErrorCodes.INVALID_EMAIL_FORMAT,
		),
	'EmailBlocklistEntryType',
);
export const DiscriminatorType = withOpenApiType(
	z
		.union([z.string(), z.number()])
		.transform((value) => String(value))
		.pipe(z.string().regex(DISCRIMINATOR_REGEX, ValidationErrorCodes.DISCRIMINATOR_INVALID_FORMAT))
		.transform((value) => {
			return Number.parseInt(value, 10);
		}),
	'DiscriminatorType',
);
const UpstreamUsernameType = z
	.string()
	.trim()
	.pipe(withStringLengthRangeValidation(z.string(), 1, 32, ValidationErrorCodes.USERNAME_LENGTH_INVALID))
	.refine((value) => FLUXER_TAG_REGEX.test(value), ValidationErrorCodes.USERNAME_INVALID_CHARACTERS)
	.refine((value) => {
		const lowerValue = value.toLowerCase();
		return lowerValue !== 'everyone' && lowerValue !== 'here';
	}, ValidationErrorCodes.USERNAME_RESERVED_VALUE)
	.refine((value) => {
		const lowerValue = value.toLowerCase();
		return !lowerValue.includes('fluxer') && !lowerValue.includes('system message');
	}, ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_RESERVED_TERMS);
// Micup: a username someone picks for themselves or a bot; the brand in any spelling passes for staff or the
// system account.
export const UsernameType = withOpenApiType(
	UpstreamUsernameType.refine((value) => !nameContainsMicup(value), ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_MICUP),
	'UsernameType',
);
// Micup: a username that names an existing account (friend request by tag) or that staff assign, so it must still
// reach the official micup account. Same wire contract as UsernameType.
export const UsernameLookupType = withOpenApiType(UpstreamUsernameType, 'UsernameType');
export const GlobalNameType = z
	.string()
	.superRefine((value, ctx) => {
		if (value.length > MAX_STRING_PROCESSING_LENGTH) {
			ctx.addIssue({
				code: 'custom',
				message: ValidationErrorCodes.GLOBAL_NAME_LENGTH_INVALID,
				params: {min: 1, max: 32},
			});
			return z.NEVER;
		}
	})
	.transform(sanitizeUsername)
	.pipe(withStringLengthRangeValidation(z.string(), 1, 32, ValidationErrorCodes.GLOBAL_NAME_LENGTH_INVALID))
	.refine((value) => {
		const lowerValue = value.toLowerCase();
		return lowerValue !== 'everyone' && lowerValue !== 'here';
	}, ValidationErrorCodes.GLOBAL_NAME_RESERVED_VALUE)
	.refine((value) => {
		const lowerValue = value.toLowerCase();
		return !lowerValue.includes('system message');
	}, ValidationErrorCodes.GLOBAL_NAME_CANNOT_CONTAIN_RESERVED_TERMS)
	.refine((value) => !displayNamePassesForMicup(value), ValidationErrorCodes.GLOBAL_NAME_CANNOT_IMPERSONATE_MICUP);
export const PasswordType = withOpenApiType(
	z
		.string()
		.overwrite(normalizeString)
		.pipe(withStringLengthRangeValidation(z.string(), 8, 256, ValidationErrorCodes.PASSWORD_LENGTH_INVALID)),
	'PasswordType',
);
// Micup: a webhook name is shown as the author of its messages, so it follows the display name rule.
export const WebhookNameType = z
	.string()
	.overwrite(normalizeString)
	.pipe(withStringLengthRangeValidation(z.string(), 1, 80, ValidationErrorCodes.WEBHOOK_NAME_LENGTH_INVALID))
	.refine((value) => !displayNamePassesForMicup(value), ValidationErrorCodes.GLOBAL_NAME_CANNOT_IMPERSONATE_MICUP);
