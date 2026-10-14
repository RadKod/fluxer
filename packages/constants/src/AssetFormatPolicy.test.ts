// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ASSET_FORMAT_POLICY,
	COSMETIC_ASSET_POLICY,
	formatAssetUploadExtensions,
	formatKnownAnimatedAssetExtensions,
	getAcceptString,
	getMimeWhitelist,
	getUploadExtensions,
	isExtensionAllowed,
	isMimeAllowed,
	ULTRA_FRONT_POLICY,
} from '@fluxer/constants/src/AssetFormatPolicy';
import {describe, expect, it} from 'vitest';

describe('AssetFormatPolicy', () => {
	it('holds ultra decorations to 1,228,800 bytes and every other cosmetic to 512 KB', () => {
		expect(COSMETIC_ASSET_POLICY.maxBytes).toBe(524_288);
		expect(COSMETIC_ASSET_POLICY.ultraMaxBytes).toBe(1_228_800);
	});

	it('keeps the in-front ultra part limits of the angel-wings gate', () => {
		expect(ULTRA_FRONT_POLICY).toEqual({
			closedMaxBytes: 153_600,
			openFrameMaxBytes: 65_536,
			openTotalMaxBytes: 512_000,
			idleMaxBytes: 1_500_000,
			minFrames: 2,
			maxFrames: 30,
			height: {min: 96, max: 576},
		});
		expect(COSMETIC_ASSET_POLICY.dims).toEqual({min: 96, max: 480}); // fallback rules unchanged
	});

	describe('ASSET_FORMAT_POLICY', () => {
		it('exposes an entry for every documented asset kind', () => {
			expect(Object.keys(ASSET_FORMAT_POLICY).sort()).toEqual(
				['attachment', 'avatar', 'banner', 'embed_splash', 'emoji', 'guild_icon', 'splash', 'sticker'].sort(),
			);
		});
		it('keeps animated-only assets out of static-only kinds', () => {
			for (const kind of ['splash', 'embed_splash'] as const) {
				const entry = ASSET_FORMAT_POLICY[kind];
				expect(entry.animated).toBe('never');
				expect(entry.upload).not.toContain('gif');
				expect(entry.upload).not.toContain('apng');
			}
		});
		it('includes HEIC/JXL/AVIF on avatar uploads (iPhone + modern web)', () => {
			expect(ASSET_FORMAT_POLICY.avatar.upload).toEqual(
				expect.arrayContaining(['heic', 'heif', 'jxl', 'avif', 'apng']),
			);
		});
		it('limits sticker uploads to the historical sticker set plus jpeg and svg', () => {
			expect([...ASSET_FORMAT_POLICY.sticker.upload].sort()).toEqual([
				'apng',
				'avif',
				'gif',
				'jpeg',
				'png',
				'svg',
				'webp',
			]);
		});
		it('accepts svg uploads on every image asset kind', () => {
			for (const kind of [
				'avatar',
				'guild_icon',
				'banner',
				'splash',
				'embed_splash',
				'emoji',
				'sticker',
				'attachment',
			] as const) {
				expect(ASSET_FORMAT_POLICY[kind].upload).toContain('svg');
				expect(ASSET_FORMAT_POLICY[kind].mimes.svg).toBe('image/svg+xml');
			}
		});
		it('has a mime entry for every accepted extension', () => {
			for (const entry of Object.values(ASSET_FORMAT_POLICY)) {
				for (const ext of entry.upload) {
					expect(entry.mimes[ext]).toMatch(/^image\//);
				}
			}
		});
	});
	describe('getAcceptString', () => {
		it('returns extensions and MIMEs joined by commas', () => {
			const accept = getAcceptString('avatar');
			expect(accept).toContain('.png');
			expect(accept).toContain('image/png');
			expect(accept).toContain('.heic');
			expect(accept).toContain('image/heic');
			expect(accept).toContain('.jxl');
		});
		it('does not include image/* wildcard (we want strict negotiation)', () => {
			expect(getAcceptString('emoji')).not.toContain('image/*');
		});
		it('can filter extension-only animated formats when animation is unavailable', () => {
			const accept = getAcceptString('guild_icon', {animatedAllowed: false});
			expect(accept).not.toContain('.gif');
			expect(accept).not.toContain('image/gif');
			expect(accept).not.toContain('.apng');
			expect(accept).not.toContain('image/apng');
			expect(accept).toContain('.svg');
			expect(accept).toContain('image/svg+xml');
			expect(accept).toContain('.avif');
			expect(accept).toContain('image/avif');
		});
	});
	describe('getUploadExtensions', () => {
		it('returns the full backend upload policy by default', () => {
			expect(getUploadExtensions('avatar')).toEqual([
				'png',
				'jpeg',
				'webp',
				'gif',
				'apng',
				'avif',
				'heic',
				'heif',
				'jxl',
				'svg',
			]);
		});
		it('keeps static-capable expanded formats when filtering animation-only extensions', () => {
			expect(getUploadExtensions('avatar', {animatedAllowed: false})).toEqual([
				'png',
				'jpeg',
				'webp',
				'avif',
				'heic',
				'heif',
				'jxl',
				'svg',
			]);
		});
	});
	describe('formatAssetUploadExtensions', () => {
		it('formats user-facing labels from the upload policy', () => {
			expect(formatAssetUploadExtensions('avatar')).toBe('PNG, JPEG, WebP, GIF, APNG, AVIF, HEIC, HEIF, JXL, SVG');
		});
		it('supports extension-style labels for API validation details', () => {
			expect(formatAssetUploadExtensions('avatar', {labelStyle: 'extension'})).toBe(
				'png, jpeg, webp, gif, apng, avif, heic, heif, jxl, svg',
			);
		});
	});
	describe('formatKnownAnimatedAssetExtensions', () => {
		it('lists animated formats that are accepted as animated assets', () => {
			expect(formatKnownAnimatedAssetExtensions('avatar')).toBe('GIF, APNG, WebP');
		});
	});
	describe('getMimeWhitelist', () => {
		it('returns the per-kind MIME list', () => {
			expect(getMimeWhitelist('sticker')).toEqual([
				'image/png',
				'image/jpeg',
				'image/apng',
				'image/gif',
				'image/webp',
				'image/avif',
				'image/svg+xml',
			]);
		});
	});
	describe('isExtensionAllowed', () => {
		it('accepts both raw and dot-prefixed extensions', () => {
			expect(isExtensionAllowed('avatar', 'png')).toBe(true);
			expect(isExtensionAllowed('avatar', '.png')).toBe(true);
			expect(isExtensionAllowed('avatar', 'PNG')).toBe(true);
			expect(isExtensionAllowed('avatar', 'jpg')).toBe(true);
		});
		it('rejects extensions not in the upload list', () => {
			expect(isExtensionAllowed('splash', 'gif')).toBe(false);
			expect(isExtensionAllowed('emoji', 'mp4' as never)).toBe(false);
		});
	});
	describe('isMimeAllowed', () => {
		it('matches MIMEs case-insensitively', () => {
			expect(isMimeAllowed('avatar', 'IMAGE/PNG')).toBe(true);
			expect(isMimeAllowed('avatar', 'image/heic')).toBe(true);
		});
		it('rejects MIMEs outside the policy', () => {
			expect(isMimeAllowed('emoji', 'application/pdf')).toBe(false);
			expect(isMimeAllowed('splash', 'image/gif')).toBe(false);
		});
	});
});
