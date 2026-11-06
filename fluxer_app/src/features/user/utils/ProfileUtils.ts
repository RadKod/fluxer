// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import * as ImageCacheUtils from '@app/features/messaging/utils/ImageCacheUtils';
import {mediaUrl} from '@app/features/messaging/utils/MessagingUrlUtils';
import {Profile} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import UserProfile from '@app/features/user/state/UserProfile';
import {ProfileFieldPrivacyFlags} from '@fluxer/constants/src/UserConstants';
import {getCurrentTimeZoneOffsetMinutes} from '@fluxer/date_utils/src/TimeZoneUtils';
import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import type {ProfileBadgeResponse} from '@fluxer/schema/src/domains/user/ProfileBadgeSchemas';

export function createMockProfile(
	user: User,
	options?: {
		previewBannerUrl?: string | null;
		hasClearedBanner?: boolean;
		previewBio?: string | null;
		previewPronouns?: string | null;
		previewAccentColor?: number | null;
		previewTimezoneOffset?: number | null;
		profileBadges?: ReadonlyArray<ProfileBadgeResponse>;
		previewProfileEffect?: CosmeticAssetDataResponse | null;
		previewThemeColors?: ThemeColors | null;
	},
): Profile {
	let finalBanner: string | null;
	if (options?.hasClearedBanner) {
		finalBanner = null;
	} else if (options?.previewBannerUrl) {
		finalBanner = options.previewBannerUrl;
	} else {
		finalBanner = user.banner || null;
	}
	const finalBio = options?.previewBio !== undefined ? options.previewBio : user.bio || null;
	const finalPronouns = options?.previewPronouns !== undefined ? options.previewPronouns : user.pronouns || null;
	// Micup: badges and the profile effect live on the profile, not the user; the preview keeps the loaded ones.
	const loadedProfile = UserProfile.getProfile(user.id);
	const profileUser = user.toJSON();
	const userProfile = {
		bio: finalBio,
		banner: finalBanner,
		pronouns: finalPronouns,
		accent_color: options?.previewAccentColor !== undefined ? options.previewAccentColor : (user.accentColor ?? null),
		...(options?.previewThemeColors !== undefined && {theme_colors: options.previewThemeColors}),
	};
	let timezoneOffset: number | null;
	if (options?.previewTimezoneOffset !== undefined) {
		timezoneOffset = options.previewTimezoneOffset;
	} else if ((user.timezonePrivacyFlags ?? ProfileFieldPrivacyFlags.EVERYONE) !== 0) {
		timezoneOffset = getCurrentTimeZoneOffsetMinutes(user.timezone);
	} else {
		timezoneOffset = null;
	}
	return new Profile({
		user: profileUser,
		user_profile: userProfile,
		timezone_offset: timezoneOffset,
		profile_badges: options?.profileBadges ?? loadedProfile?.profileBadges ?? [],
		profile_effect_data:
			options?.previewProfileEffect !== undefined
				? options.previewProfileEffect
				: (loadedProfile?.profileEffect ?? null),
		badges: loadedProfile?.badges ? [...loadedProfile.badges] : undefined,
	});
}

export function customBadgeImageUrl(assetUrl: string): string {
	return `${assetUrl}?size=96`;
}

export function profileBadgeImageUrl(badge: Pick<ProfileBadgeResponse, 'asset' | 'asset_url'>): string | null {
	if (badge.asset !== null) return `${RuntimeConfig.staticCdnEndpoint}/badges/${badge.asset}.webp`;
	if (badge.asset_url) return customBadgeImageUrl(badge.asset_url);
	return null;
}

export function warmProfileBadgeImages(badges: ReadonlyArray<ProfileBadgeResponse>): void {
	for (const badge of badges) {
		const url = profileBadgeImageUrl(badge);
		if (url) ImageCacheUtils.warmImage(url);
	}
}

// Micup: catalog badges (profile.badges) are drawn after the server's profile badges, in the server's order.
// A catalog badge the server already sends as a custom profile badge is not drawn twice.
export function getProfileDisplayBadges(
	profile: Pick<Profile, 'profileBadges' | 'badges'> | null | undefined,
): ReadonlyArray<ProfileBadgeResponse> {
	if (!profile) return [];
	const catalog = profile.badges ?? [];
	if (catalog.length === 0) return profile.profileBadges;
	const seen = new Set(profile.profileBadges.map((badge) => badge.key));
	const extra: Array<ProfileBadgeResponse> = [];
	for (const badge of catalog) {
		if (seen.has(`custom:${badge.id}`) || seen.has(`catalog:${badge.id}`)) continue;
		extra.push({
			key: `catalog:${badge.id}`,
			kind: 'custom',
			label: badge.description,
			asset: null,
			asset_url: mediaUrl(`branding/badge-${badge.id}/${badge.icon}.webp`),
			aspect_ratio: null,
			caption: null,
			href: null,
		});
	}
	return extra.length > 0 ? [...profile.profileBadges, ...extra] : profile.profileBadges;
}

// Micup: the You page and the DM welcome keep their crown next to the name, so their badge rows skip the premium badge.
export function withoutPremiumBadge(badges: ReadonlyArray<ProfileBadgeResponse>): ReadonlyArray<ProfileBadgeResponse> {
	return badges.filter((badge) => badge.kind !== 'premium' && badge.kind !== 'plutonium');
}
