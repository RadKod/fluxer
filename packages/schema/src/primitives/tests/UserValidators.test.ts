// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ChangeUsernameRequest} from '@fluxer/schema/src/domains/admin/AdminUserSchemas';
import {FriendRequestByTagRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {SlackWebhookRequest, WebhookMessageRequest} from '@fluxer/schema/src/domains/webhook/WebhookRequestSchemas';
import {
	GlobalNameType,
	PasswordType,
	UsernameLookupType,
	UsernameType,
	WebhookNameType,
} from '@fluxer/schema/src/primitives/UserValidators';
import {describe, expect, it} from 'vitest';

describe('UsernameType', () => {
	it('accepts valid alphanumeric usernames', () => {
		const result = UsernameType.parse('testuser');
		expect(result).toBe('testuser');
	});
	it('accepts usernames with underscores', () => {
		const result = UsernameType.safeParse('test_user');
		expect(result.success).toBe(true);
	});
	it('accepts usernames with numbers', () => {
		const result = UsernameType.safeParse('user123');
		expect(result.success).toBe(true);
	});
	it('trims whitespace', () => {
		const result = UsernameType.parse('  testuser  ');
		expect(result).toBe('testuser');
	});
	it('rejects empty usernames', () => {
		const result = UsernameType.safeParse('');
		expect(result.success).toBe(false);
	});
	it('rejects usernames exceeding max length', () => {
		const result = UsernameType.safeParse('a'.repeat(33));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_LENGTH_INVALID);
		}
	});
	it('rejects usernames with invalid characters', () => {
		const result = UsernameType.safeParse('test-user');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_INVALID_CHARACTERS);
		}
	});
	it('rejects "everyone" as username', () => {
		const result = UsernameType.safeParse('everyone');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_RESERVED_VALUE);
		}
	});
	it('rejects "here" as username', () => {
		const result = UsernameType.safeParse('here');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_RESERVED_VALUE);
		}
	});
	it('rejects usernames containing "fluxer"', () => {
		const result = UsernameType.safeParse('fluxeruser');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_RESERVED_TERMS);
		}
	});
	it('rejects reserved terms case-insensitively', () => {
		const result = UsernameType.safeParse('EVERYONE');
		expect(result.success).toBe(false);
	});
	it.each(['micupdestek', 'MiCuP', 'resmi_Micup'])('rejects the sanalyer brand in %s', (username) => {
		const result = UsernameType.safeParse(username);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_MICUP);
		}
	});
	it('still rejects "fluxer" itself with the reserved terms code', () => {
		const result = UsernameType.safeParse('fluxer');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_RESERVED_TERMS);
		}
	});
	it.each(['oyuncu', 'microphone'])('accepts the ordinary username %s', (username) => {
		expect(UsernameType.safeParse(username).success).toBe(true);
	});
	it.each(['m1cup', 'rnicup', 'mi_cup', 'MlCUP', 'micup_official', 'Resmi_M1CUP'])(
		'rejects the look-alike brand spelling %s',
		(username) => {
			const result = UsernameType.safeParse(username);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0].message).toBe(ValidationErrorCodes.USERNAME_CANNOT_CONTAIN_MICUP);
			}
		},
	);
	it.each(['destek', 'ekip_lideri', 'micro_cup'])('accepts %s, which does not spell the brand', (username) => {
		expect(UsernameType.safeParse(username).success).toBe(true);
	});
});

describe('UsernameLookupType', () => {
	it('lets a friend request by tag and a staff rename name the official micup account', () => {
		expect(UsernameLookupType.safeParse('micup').success).toBe(true);
		expect(FriendRequestByTagRequest.safeParse({username: 'micup', discriminator: '0001'}).success).toBe(true);
		expect(ChangeUsernameRequest.safeParse({user_id: '1', username: 'micup'}).success).toBe(true);
	});
	it('keeps the upstream username rules', () => {
		expect(UsernameLookupType.safeParse('everyone').success).toBe(false);
		expect(UsernameLookupType.safeParse('fluxer').success).toBe(false);
		expect(UsernameLookupType.safeParse('has space').success).toBe(false);
	});
});

describe('GlobalNameType', () => {
	it('rejects "everyone" as global name', () => {
		const result = GlobalNameType.safeParse('everyone');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.GLOBAL_NAME_RESERVED_VALUE);
		}
	});
	it('rejects "here" as global name', () => {
		const result = GlobalNameType.safeParse('here');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.GLOBAL_NAME_RESERVED_VALUE);
		}
	});
	it('rejects names containing "system message"', () => {
		const result = GlobalNameType.safeParse('My System Message');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.GLOBAL_NAME_CANNOT_CONTAIN_RESERVED_TERMS);
		}
	});
	it.each([
		'sanalyer Destek',
		'sanalyer Resmi',
		'micup_official',
		'MİCUP DESTEK',
		'M1cup Support',
		'Rnicup Yönetim',
		'Мicup Ekibi',
		'ＭＩＣＵＰ Resmi',
		'sanalyer Mod',
		'sanalyer',
		'sanalyer Yetkili',
		'sanalyer Yardım',
		'sanalyer Güvenlik',
		'sanalyer Sistem',
		'sanalyer Duyuru',
		'sanalyer Moderasyon',
		'MICUP YETKİLİSİ',
		'MicupDuyurular',
		'sanalyer Güvenliği',
		'sanalyer Desteği',
		'sanalyer System',
		'sanalyer Security',
		'sanalyer Help',
		'sanalyer Announcements',
		'sanalyer Moderation',
		'ᴍɪᴄᴜᴘ Destek',
		'ᴍɪᴄᴜᴘ',
		'ｍｉｃｕｐ Destek',
	])('rejects %s, which passes for an official sanalyer account', (name) => {
		const result = GlobalNameType.safeParse(name);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.GLOBAL_NAME_CANNOT_IMPERSONATE_MICUP);
		}
	});
	it.each([
		'Ekip Lideri',
		'Destek',
		'Resmi Ali',
		'sanalyer sever Ali',
		'sanalyer Badminton',
		'sanalyer Modern',
		'Sunucu Yetkilisi',
		'Duyurular',
		'Sistem Botu',
		'Yardım Masası',
		'Güvenlik Görevlisi',
		'Moderasyon Ekibi',
		'System Help',
		'Micuplu değil',
		'ᴍɪᴄᴜᴘ sever',
	])('accepts %s, which mentions the brand or an official word but not both', (name) => {
		expect(GlobalNameType.safeParse(name).success).toBe(true);
	});
});

describe('PasswordType', () => {
	it('accepts valid passwords', () => {
		const result = PasswordType.parse('securepassword123');
		expect(result).toBe('securepassword123');
	});
	it('accepts passwords at minimum length', () => {
		const result = PasswordType.safeParse('12345678');
		expect(result.success).toBe(true);
	});
	it('rejects passwords shorter than minimum', () => {
		const result = PasswordType.safeParse('1234567');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe(ValidationErrorCodes.PASSWORD_LENGTH_INVALID);
		}
	});
	it('rejects passwords exceeding maximum length', () => {
		const result = PasswordType.safeParse('a'.repeat(257));
		expect(result.success).toBe(false);
	});
	it('trims and normalizes password', () => {
		const result = PasswordType.parse('  password123  ');
		expect(result).toBe('password123');
	});
});

describe('WebhookNameType', () => {
	it.each(['sanalyer', 'sanalyer Duyuru', 'ᴍɪᴄᴜᴘ Destek'])(
		'rejects %s, which passes for an official sanalyer account',
		(name) => {
			const result = WebhookNameType.safeParse(name);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues[0].message).toBe(ValidationErrorCodes.GLOBAL_NAME_CANNOT_IMPERSONATE_MICUP);
			}
		},
	);
	it('refuses the same name as a per-message override and on a Slack-compatible hook', () => {
		expect(WebhookMessageRequest.safeParse({content: 'x', username: 'sanalyer Sistem'}).success).toBe(false);
		expect(SlackWebhookRequest.safeParse({text: 'x', username: 'sanalyer Yetkili'}).success).toBe(false);
		expect(WebhookMessageRequest.safeParse({content: 'x', username: 'Sistem Botu'}).success).toBe(true);
	});
	it.each(['Duyurular', 'Sistem Botu', 'sanalyer Haberci'])('accepts %s', (name) => {
		expect(WebhookNameType.safeParse(name).success).toBe(true);
	});
});
