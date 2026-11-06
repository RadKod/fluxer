// SPDX-License-Identifier: AGPL-3.0-or-later

import avatarArt from '@app/media/images/premium/plus/kart-avatar-600.webp';
import nameArt from '@app/media/images/premium/plus/kart-isim-600.webp';
import profileArt from '@app/media/images/premium/plus/kart-profil-600.webp';
import badgeArt from '@app/media/images/premium/plus/kart-rozet-600.webp';
import heroArt from '@app/media/images/premium/plus/plus-ana-1200.webp';
import plutoniumAtomAvif from '@app/media/images/premium/plutonium-atom.avif';
import plutoniumAtomWebp from '@app/media/images/premium/plutonium-atom.webp';
import plutoniumAtomAvif2x from '@app/media/images/premium/plutonium-atom-960w.avif';
import plutoniumAtomWebp2x from '@app/media/images/premium/plutonium-atom-960w.webp';
import premiumCrownAvif from '@app/media/images/premium/premium-crown.avif';
import premiumCrownWebp from '@app/media/images/premium/premium-crown.webp';
import premiumCrownAvif2x from '@app/media/images/premium/premium-crown-960w.avif';
import premiumCrownWebp2x from '@app/media/images/premium/premium-crown-960w.webp';

export interface HeroArt {
	avifSrcSet: string;
	webpSrcSet: string;
	src: string;
	width: number;
	height: number;
}

function densitySrcSet(oneX: string, twoX: string): string {
	return `${oneX} 1x, ${twoX} 2x`;
}

const PLUTONIUM_ATOM_ART: HeroArt = {
	avifSrcSet: densitySrcSet(plutoniumAtomAvif, plutoniumAtomAvif2x),
	webpSrcSet: densitySrcSet(plutoniumAtomWebp, plutoniumAtomWebp2x),
	src: plutoniumAtomWebp,
	width: 480,
	height: 524,
};

const PREMIUM_CROWN_ART: HeroArt = {
	avifSrcSet: densitySrcSet(premiumCrownAvif, premiumCrownAvif2x),
	webpSrcSet: densitySrcSet(premiumCrownWebp, premiumCrownWebp2x),
	src: premiumCrownWebp,
	width: 480,
	height: 415,
};

export function heroArtFor(selfHosted: boolean): HeroArt {
	return selfHosted ? PREMIUM_CROWN_ART : PLUTONIUM_ATOM_ART;
}

// Micup: the Plus page art replaces the hosted Fluxer perk images.
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
