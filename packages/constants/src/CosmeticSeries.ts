// SPDX-License-Identifier: AGPL-3.0-or-later

// sanalyer: a cosmetic series is nothing more than the items that share a series slug. The display name is free
// text written by the admin or the bulk uploader; the slug is derived here, in one place, so the API, the admin
// panel and the app group the same way. There is no series table.

export const COSMETIC_SERIES_MAX_LENGTH = 64;

// Trims and collapses whitespace; an empty result reads as "no series".
export function normalizeCosmeticSeriesName(value: string | null | undefined): string | null {
	if (value == null) return null;
	const name = value.replace(/\s+/g, ' ').trim();
	return name.length === 0 ? null : name.slice(0, COSMETIC_SERIES_MAX_LENGTH);
}

// Lowercase, Turkish letters folded (ı→i, ş→s, ğ→g, ç→c, ö→o, ü→u), accents stripped, non-alphanumerics to one dash.
// "Jujutsu Kaisen" and "jujutsu kaisen " land on the same slug; "All Ears" → "all-ears".
export function cosmeticSeriesSlug(name: string | null | undefined): string | null {
	const normalized = normalizeCosmeticSeriesName(name);
	if (normalized === null) return null;
	const slug = normalized
		.replace(/ı/g, 'i')
		.replace(/İ/g, 'i')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug.length === 0 ? null : slug;
}
