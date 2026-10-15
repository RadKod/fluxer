// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {UserConnectionRow} from '@app/api/database/types/ConnectionTypes';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {
	buildProfileView,
	decodeProfileView,
	encodeProfileView,
	PROFILE_VIEW_USER_COLUMNS,
	projectedUser,
} from '@app/api/user/profile/ProfileViewProjection';
import {shouldStripExpiredPremium} from '@app/api/user/UserHelpers';
import {mapCosmeticAssetData, mapUserToPartialResponse, mapUserToProfileResponse} from '@app/api/user/UserMappers';
import {ConnectionTypes, ConnectionVisibilityFlags} from '@fluxer/constants/src/ConnectionConstants';
import {DeletionReasons} from '@fluxer/constants/src/Core';
import {UserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {types} from 'cassandra-driver';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const DAY = 86_400_000;

// Every column filled, so a column the projection keeps by mistake shows up.
function fullTestUser(overrides: Partial<UserRow> = {}): User {
	const at = (days: number) => new Date(Date.UTC(2026, 9, 3) + days * DAY);
	return new User({
		...EMPTY_USER_ROW,
		user_id: 1234567890123456789n as UserID,
		username: 'owner',
		discriminator: 42,
		global_name: 'Owner',
		bot: false,
		system: false,
		email: 'owner@example.com',
		email_verified: true,
		email_bounced: false,
		password_hash: '$argon2id$secret',
		password_last_changed_at: at(-30),
		totp_secret: 'TOTPSECRET',
		authenticator_types: new Set([1, 2]),
		avatar_hash: 'a_avatarhash',
		avatar_color: 0x123456,
		banner_hash: 'a_bannerhash',
		banner_color: 0x654321,
		bio: 'my bio',
		pronouns: 'they/them',
		accent_color: 0xabcdef,
		timezone: 'Europe/Istanbul',
		timezone_privacy_flags: 1,
		date_of_birth: types.LocalDate.fromString('2000-01-02'),
		locale: 'tr',
		flags: UserFlags.STAFF,
		premium_flags: 0,
		premium_type: UserPremiumTypes.SUBSCRIPTION,
		premium_since: at(-100),
		premium_until: at(+100),
		premium_gift_extension_ends_at: at(+50),
		premium_will_cancel: true,
		premium_billing_cycle: 'monthly',
		premium_lifetime_sequence: 7,
		premium_grace_ends_at: at(+103),
		stripe_subscription_id: 'sub_secret',
		stripe_customer_id: 'cus_secret',
		has_ever_purchased: true,
		terms_agreed_at: at(-200),
		privacy_agreed_at: at(-200),
		last_active_at: at(0),
		last_active_ip: '203.0.113.7',
		temp_banned_until: at(-1),
		pending_bulk_message_deletion_at: at(+2),
		pending_bulk_message_deletion_channel_count: 3,
		pending_bulk_message_deletion_message_count: 9,
		pending_deletion_at: null,
		deletion_started_at: null,
		deletion_reason_code: 1,
		deletion_public_reason: 'reason',
		deletion_audit_log_reason: 'audit',
		acls: new Set(['admin:secret']),
		traits: new Set(['beta', 'sso', 'sso_identity:0123456789abcdef']),
		first_refund_at: at(-10),
		gift_inventory_server_seq: 5,
		gift_inventory_client_seq: 6,
		premium_onboarding_dismissed_at: at(-5),
		mention_flags: 1,
		last_voice_activity_sharing_change_at: at(-3),
		avatar_decoration_id: 11n,
		avatar_ultra_id: 12n,
		profile_effect_id: 13n,
		nameplate_id: 14n,
		avatar_decoration_asset: 'decoration',
		avatar_ultra_asset: 'ultra',
		profile_effect_asset: 'effect',
		nameplate_asset: 'nameplate',
		name_font: 6,
		name_color: 0xffffff,
		name_color_2: 0x7b5cff,
		theme_primary_color: 0x1e1b4b,
		theme_accent_color: 0x07a3b2,
		version: 9,
		...overrides,
	});
}

function connection(name: string, verified: boolean): UserConnectionRow {
	return {
		user_id: 1234567890123456789n as UserID,
		connection_id: `id-${name}`,
		connection_type: ConnectionTypes.DOMAIN,
		identifier: `${name}.example`,
		name,
		verified,
		visibility_flags: ConnectionVisibilityFlags.FRIENDS,
		sort_order: 2,
		verification_token: 'verification-secret',
		oauth_grant_id: 'grant-secret',
		verified_at: new Date(),
		last_verified_at: new Date(),
		created_at: new Date(),
		version: 1,
	};
}

const BADGES = [{user_id: 1234567890123456789n as UserID, badge_id: 99n, granted_at: new Date(), sequence: 7}];

describe('the cached profile view of the owner (G-1, Epha 14:10)', () => {
	// The mappers read the global limit config (animated avatar and banner entitlements).
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('keeps only the allowed columns: no email, phone, password, MFA, date of birth, IP or billing column', () => {
		const view = buildProfileView(fullTestUser(), [connection('site', true)], BADGES);
		for (const column of Object.keys(view.row)) expect(PROFILE_VIEW_USER_COLUMNS).toContain(column);
		for (const secret of [
			'email',
			'email_verified',
			'has_verified_phone',
			'password_hash',
			'password_last_changed_at',
			'totp_secret',
			'authenticator_types',
			'date_of_birth',
			'locale',
			'last_active_at',
			'last_active_ip',
			'premium_billing_cycle',
			'premium_will_cancel',
			'stripe_subscription_id',
			'stripe_customer_id',
			'has_ever_purchased',
			'first_refund_at',
			'suspicious_activity_flags',
			'acls',
			'version',
		]) {
			expect(view.row).not.toHaveProperty(secret);
		}
		// An SSO identity is a stable external account key; the provider traits stay (limit rules may match them).
		expect(view.row.traits).toEqual(new Set(['beta', 'sso']));
		expect(encodeProfileView(view)).not.toMatch(/secret|owner@example|203\.0\.113|0123456789abcdef/);
	});

	it('keeps only verified connections and only the fields the profile shows', () => {
		const view = buildProfileView(fullTestUser(), [connection('site', true), connection('pending', false)], []);
		expect(view.connections).toEqual([
			{
				connection_id: 'id-site',
				connection_type: ConnectionTypes.DOMAIN,
				name: 'site',
				verified: true,
				visibility_flags: ConnectionVisibilityFlags.FRIENDS,
				sort_order: 2,
			},
		]);
	});

	it('round-trips bigint, Date and Set columns through KV text', () => {
		const view = buildProfileView(fullTestUser(), [connection('site', true)], BADGES);
		const decoded = decodeProfileView(encodeProfileView(view));
		expect(decoded).toEqual(view);
		expect(decoded.badges).toEqual([{badge_id: 99n, sequence: 7}]); // the catalog text is drawn per request
		expect(typeof decoded.row.user_id).toBe('bigint');
		expect(decoded.row.premium_until).toBeInstanceOf(Date);
		expect(decoded.row.traits).toBeInstanceOf(Set);
	});

	it.each([
		['an active premium staff account', {}],
		['a lapsed premium', {premium_until: new Date(Date.now() - 30 * DAY), premium_grace_ends_at: null}],
		['a lifetime premium with hidden badge parts', {premium_type: UserPremiumTypes.LIFETIME, premium_flags: 0b1111}],
		['no premium, no cosmetics', {premium_type: null, profile_effect_id: null, avatar_decoration_id: null}],
		['a deleted account', {flags: UserFlags.DELETED}],
		['a hidden profile', {flags: UserFlags.PROFILE_HIDDEN}],
		['a temporary ban', {flags: UserFlags.DISABLED, temp_banned_until: new Date(Date.now() + DAY)}],
		[
			'an enforcement deletion',
			{pending_deletion_at: new Date(Date.now() + DAY), deletion_reason_code: DeletionReasons.SPAM},
		],
		['a bot', {bot: true}],
	])('gives the same profile response fields as the full row: %s', (_name, overrides) => {
		const full = fullTestUser(overrides);
		const projected = projectedUser(decodeProfileView(encodeProfileView(buildProfileView(full, [], []))));
		expect(mapUserToPartialResponse(projected)).toEqual(mapUserToPartialResponse(full));
		expect(mapUserToProfileResponse(projected)).toEqual(mapUserToProfileResponse(full));
		expect(mapUserToProfileResponse(projected, {restrictProfile: true})).toEqual(
			mapUserToProfileResponse(full, {restrictProfile: true}),
		);
		expect(mapCosmeticAssetData(projected.profileEffectId, projected.profileEffectAsset)).toEqual(
			mapCosmeticAssetData(full.profileEffectId, full.profileEffectAsset),
		);
		expect(shouldStripExpiredPremium(projected)).toBe(shouldStripExpiredPremium(full));
		for (const field of [
			'id',
			'premiumType',
			'premiumSince',
			'premiumLifetimeSequence',
			'premiumFlags',
			'timezone',
			'timezonePrivacyFlags',
		] as const) {
			expect(projected[field]).toEqual(full[field]);
		}
	});
});
