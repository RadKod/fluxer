// SPDX-License-Identifier: AGPL-3.0-or-later

import avatarArt from '@app/media/images/premium/plus/kart-avatar-600.webp';
import nameArt from '@app/media/images/premium/plus/kart-isim-600.webp';
import profileArt from '@app/media/images/premium/plus/kart-profil-600.webp';
import badgeArt from '@app/media/images/premium/plus/kart-rozet-600.webp';
import heroArt from '@app/media/images/premium/plus/plus-ana-1200.webp';

export const CROWN_WEBP = heroArt;
export const AVATAR_LSF = avatarArt;
export const BANNER_LSF = profileArt;
export const EMOJI_CATVIBE = badgeArt;
export const EMOJI_CATWAVE = avatarArt;
export const STICKER_FEEL_THAT = heroArt;

type ShotSet = [string, string, string];
export interface ShotFamily {
	webp: ShotSet;
}
function shotFamily(asset: string): ShotFamily {
	return {webp: [asset, asset, asset]};
}
export const EXPRESSIONS_SHOTS = shotFamily(badgeArt);
export const PROFILE_SHOTS = shotFamily(avatarArt);
export const STREAM_SHOTS = shotFamily(nameArt);
export const UPLOAD_SHOTS = shotFamily(profileArt);
