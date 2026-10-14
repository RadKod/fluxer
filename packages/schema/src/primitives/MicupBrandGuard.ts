// SPDX-License-Identifier: AGPL-3.0-or-later

// Micup: vanity codes and names that could pass for Micup itself, its founder, its staff, or a page of the app.
// Every word rule is checked on the text as written and with look-alikes folded (see foldLookalikes).

const BRAND = 'micup';
// Rejected anywhere in a vanity code, hyphens ignored (mi-cup, resmidestek, destekekibi). Accepted side effect:
// ordinary words that contain one are refused too (ekipler, ekipman, destekci, supporters).
const OFFICIAL_WORDS = ['destek', 'resmi', 'official', 'support', 'admin', 'yonetim', 'ekip', 'staff', 'moderator'];
// Names are free text in Turkish, so they also catch the inflected forms "Micup Ekibi", "Micup Yöneticisi",
// "Micup Desteği" and "Micup Güvenliği". The staff words from 'yetkili' on are name-only: like every name word they
// count only when the name also carries the brand ("Sunucu Yetkilisi" stays free), and vanity codes never check them
// (duyurular, oyunsistemi stay free). Accepted side effect: "Micup Ekosistemi", "Micup yardımsever".
const NAME_OFFICIAL_WORDS = [
	...OFFICIAL_WORDS,
	'ekib',
	'yonetici',
	'desteg',
	'team',
	'yetkili',
	'yardim',
	'guvenlik',
	'guvenlig',
	'sistem',
	'duyuru',
	'moderasyon',
	'system',
	'security',
	'help',
	'announce',
	'moderation',
];
// Ordinary words that host an official word and stay accepted on their own.
const HOST_WORDS = ['badminton'];
// Rejected at the start of a vanity code or of a hyphen-separated part (ephax, epha1); refusing it anywhere
// would also refuse stephan and cephane.
const PART_START_WORDS = ['epha'];
// Rejected only as a whole code, name or part: too short to refuse inside words (modern, moda).
const WHOLE_PART_WORDS = ['mod'];
// Rejected as a whole vanity code: first path segments the short invite link (micup.gg/<code>) must never shadow.
// Mirrors micup-v2-infra robot/fluxer/uygulama-yollari.txt; add new segments to both.
const VANITY_APP_PATHS = [
	'login',
	'register',
	'forgot',
	'reset',
	'verify',
	'authorize-ip',
	'wasntme',
	'pending',
	'oauth2',
	'auth',
	'invite',
	'gift',
	'theme',
	'theme-studio',
	'channels',
	'bookmarks',
	'mentions',
	'notifications',
	'you',
	'report',
	'premium-callback',
	'age-verification-callback',
	'connection-callback',
	'users',
	'api',
	'gateway',
	'media',
	'livekit',
	'admin',
	'yasal',
	'web',
	'emoji',
	'libs',
	'avatars',
	'badges',
	'desktop',
	'embeds',
	'.well-known',
	'_health',
	'assets',
	'apple-app-site-association',
	'_ready',
	'marketing',
	'settings',
	'akis',
	'feed',
	'indir',
	'download',
	'premium',
	'shop',
	'bots',
	'docs',
];

const LOOKALIKE_DIGITS: Readonly<Record<string, string>> = {'0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b'};
// Lowercase letters of other scripts that render like a Latin letter (Turkish dotless i, Cyrillic, Greek), and the
// small capitals (ᴍɪᴄᴜᴘ), which NFKD leaves alone. Full-width letters (ｍｉｃｕｐ) need no entry: NFKD folds them.
const LOOKALIKE_LETTERS: Readonly<Record<string, string>> = {
	ᴀ: 'a',
	ʙ: 'b',
	ᴄ: 'c',
	ᴅ: 'd',
	ᴇ: 'e',
	ꜰ: 'f',
	ɢ: 'g',
	ʜ: 'h',
	ɪ: 'i',
	ᴊ: 'j',
	ᴋ: 'k',
	ʟ: 'l',
	ᴍ: 'm',
	ɴ: 'n',
	ᴏ: 'o',
	ᴘ: 'p',
	ʀ: 'r',
	ꜱ: 's',
	ᴛ: 't',
	ᴜ: 'u',
	ᴠ: 'v',
	ᴡ: 'w',
	ʏ: 'y',
	ᴢ: 'z',
	ı: 'i',
	а: 'a',
	с: 'c',
	е: 'e',
	і: 'i',
	ј: 'j',
	к: 'k',
	м: 'm',
	о: 'o',
	р: 'p',
	т: 't',
	у: 'y',
	х: 'x',
	ѕ: 's',
	ԁ: 'd',
	α: 'a',
	ε: 'e',
	ι: 'i',
	κ: 'k',
	μ: 'm',
	ν: 'v',
	ο: 'o',
	ρ: 'p',
	τ: 't',
	υ: 'u',
};

// Takes [a-z0-9-]; 1 stands for either i or l, so each reading is folded separately.
function foldLookalikes(code: string, one: 'i' | 'l'): string {
	return code
		.replace(/[0-9]/gu, (digit) => (digit === '1' ? one : (LOOKALIKE_DIGITS[digit] ?? digit)))
		.replaceAll('rn', 'm');
}

function joinParts(variant: string): string {
	return variant.replaceAll('-', '');
}

function containsWord(variant: string, anywhere: ReadonlyArray<string>, partStart: ReadonlyArray<string>): boolean {
	const parts = variant.split('-');
	const joined = parts.join('');
	const unhosted = HOST_WORDS.reduce((text, host) => text.replaceAll(host, ''), joined);
	return (
		anywhere.some((word) => unhosted.includes(word)) ||
		[joined, ...parts].some(
			(piece) => partStart.some((word) => piece.startsWith(word)) || WHOLE_PART_WORDS.includes(piece),
		)
	);
}

export function isReservedVanityCode(code: string): boolean {
	return (
		VANITY_APP_PATHS.includes(code) ||
		[code, foldLookalikes(code, 'i'), foldLookalikes(code, 'l')].some((variant) =>
			containsWord(variant, [BRAND, ...OFFICIAL_WORDS], PART_START_WORDS),
		)
	);
}

// A name as [a-z0-9] runs joined by hyphens, in each way it can be read. Names keep their case on screen, so a
// lowercase l can also stand in for a capital I (MlCUP).
function readName(name: string): Array<string> {
	const unaccented = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
	const latin = Array.from(unaccented, (char) => LOOKALIKE_LETTERS[char] ?? char).join('');
	const code = latin.replace(/[^a-z0-9]+/gu, '-');
	return [code, foldLookalikes(code.replaceAll('l', 'i'), 'i'), foldLookalikes(code, 'l')];
}

export function nameContainsMicup(name: string): boolean {
	return readName(name).some((reading) => joinParts(reading).includes(BRAND));
}

// A display name may mention Micup ("Micup sever Ali") or an official word ("Ekip Lideri") on its own. It is
// refused when it is the bare brand or pairs the brand with an official word ("Micup Destek", "M1cup Resmi").
export function displayNamePassesForMicup(name: string): boolean {
	const readings = readName(name);
	if (!readings.some((reading) => joinParts(reading).includes(BRAND))) return false;
	return readings.some((reading) => joinParts(reading) === BRAND || containsWord(reading, NAME_OFFICIAL_WORDS, []));
}

export {LOOKALIKE_DIGITS, LOOKALIKE_LETTERS};
