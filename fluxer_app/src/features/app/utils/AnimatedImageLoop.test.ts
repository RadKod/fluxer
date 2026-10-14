// SPDX-License-Identifier: AGPL-3.0-or-later

import {toSinglePlayAnimatedImage} from '@app/features/app/utils/AnimatedImageLoop';
import {describe, expect, test} from 'vitest';

const ascii = (value: string) => Array.from(value, (char) => char.charCodeAt(0));
const header = [...ascii('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0];
const extension = (id: string) => [0x21, 0xff, 11, ...ascii(id), 3, 1, 0, 0, 0];
const gif = (...blocks: Array<Array<number>>) => new Uint8Array([...header, ...blocks.flat(), ...frame, 0x3b]);
const le32 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];
const chunk = (id: string, data: Array<number>) => [
	...ascii(id),
	...le32(data.length),
	...data,
	...(data.length % 2 ? [0] : []),
];
const webp = (...chunks: Array<Array<number>>) => {
	const body = [...ascii('WEBP'), ...chunks.flat()];
	return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
};
const vp8x = chunk('VP8X', [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const anim = chunk('ANIM', [4, 3, 2, 1, 0, 0]);
const anmf = chunk('ANMF', [...Array<number>(16).fill(0), ...chunk('VP8L', [0x2f, 0, 0, 0, 0])]);
function outputBytes(bytes: Uint8Array<ArrayBuffer>) {
	const image = toSinglePlayAnimatedImage(bytes);
	if (!image) return null;
	return new Uint8Array(image.parts.flatMap((part) => Array.from(part)));
}

describe('single-play GIF', () => {
	test('returns source-backed parts rather than a full GIF output copy', () => {
		const bytes = gif(extension('NETSCAPE2.0'));
		const image = toSinglePlayAnimatedImage(bytes);
		expect(image).toHaveProperty('parts');
		const parts = image!.parts;
		expect(parts).toHaveLength(2);
		for (const part of parts) expect(part.buffer).toBe(bytes.buffer);
		expect(new Uint8Array(parts.flatMap((part) => Array.from(part)))).toEqual(gif());
	});
	test.each(['NETSCAPE2.0', 'ANIMEXTS1.0'])('removes only the %s application extension', (id) => {
		expect(outputBytes(gif(extension(id)))).toEqual(gif());
	});
	test('preserves a GIF without a loop extension, including GIF87a', () => {
		const bytes = gif();
		bytes[4] = 0x37;
		expect(outputBytes(bytes)).toEqual(bytes);
		expect(toSinglePlayAnimatedImage(bytes)?.type).toBe('image/gif');
	});
	test('does not search image data for NETSCAPE2.0', () => {
		const dataFrame = [...frame.slice(0, 11), 11, ...ascii('NETSCAPE2.0'), 0];
		const bytes = new Uint8Array([...header, ...dataFrame, 0x3b]);
		expect(outputBytes(bytes)).toEqual(bytes);
	});
	test('walks local color tables, graphic control and unrelated application extensions', () => {
		const localFrame = [...frame.slice(0, 9), 0x80, 0, 0, 0, 255, 255, 255, ...frame.slice(10)];
		const blocks = [0x21, 0xf9, 4, 0, 1, 0, 0, 0, ...extension('OTHERAPP100')];
		const bytes = new Uint8Array([...header, ...extension('NETSCAPE2.0'), ...blocks, ...localFrame, 0x3b]);
		expect(outputBytes(bytes)).toEqual(new Uint8Array([...header, ...blocks, ...localFrame, 0x3b]));
	});
	test('rejects every truncated prefix', () => {
		const bytes = gif(extension('NETSCAPE2.0'));
		for (let length = 0; length < bytes.length; length++)
			expect(toSinglePlayAnimatedImage(bytes.slice(0, length))).toBeNull();
	});
	test('removes loop extensions after the final frame', () => {
		const bytes = new Uint8Array([...header, ...frame, ...extension('ANIMEXTS1.0'), 0x3b]);
		expect(outputBytes(bytes)).toEqual(gif());
	});
	test('removes adjacent loop extensions while preserving source slices and unrelated blocks', () => {
		const loops = [...extension('NETSCAPE2.0'), ...extension('ANIMEXTS1.0')];
		const other = extension('OTHERAPP100');
		const bytes = gif(loops, other);
		const image = toSinglePlayAnimatedImage(bytes)!;
		for (const part of image.parts) {
			expect(part.buffer).toBe(bytes.buffer);
		}
		expect(image.parts.filter((part) => part.length)).toEqual([
			bytes.subarray(0, header.length),
			bytes.subarray(header.length + loops.length),
		]);
		expect(outputBytes(bytes)).toEqual(gif(other));
	});
	test('recognizes loop identifiers with arbitrary payloads split into one-byte sub-blocks', () => {
		const loop = [0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 1, 7, 1, 0, 1, 255, 0];
		const comment = [0x21, 0xfe, 1, 0x21, 1, 0xff, 1, 11, 0];
		expect(outputBytes(gif(loop, comment))).toEqual(gif(comment));
	});
	test('preserves multiple frames with one graphic control each across all color table sizes', () => {
		const control = [0x21, 0xf9, 4, 0, 1, 0, 0, 0];
		for (let size = 0; size < 8; size++) {
			const table = Array<number>(3 * 2 ** (size + 1)).fill(0);
			const globalHeader = [...header.slice(0, 10), 0x80 | size, 0, 0, ...table];
			const localFrame = [...frame.slice(0, 9), 0x80 | size, ...table, ...frame.slice(10)];
			const frames = [...control, ...frame, ...control, ...localFrame];
			const bytes = new Uint8Array([...globalHeader, ...extension('NETSCAPE2.0'), ...frames, 0x3b]);
			expect(outputBytes(bytes)).toEqual(new Uint8Array([...globalHeader, ...frames, 0x3b]));
		}
	});
	test('rejects a non-trailer marker after a complete frame', () => {
		const bytes = gif(extension('NETSCAPE2.0'));
		bytes[bytes.length - 1] = 0x3a;
		expect(toSinglePlayAnimatedImage(bytes)).toBeNull();
	});
});

describe('single-play WebP', () => {
	test('returns the local buffer and loop offset without a WebP output copy', () => {
		const bytes = webp(vp8x, anim, anmf);
		const image = toSinglePlayAnimatedImage(bytes);
		expect(image).toHaveProperty('parts', [bytes]);
		expect(image).toHaveProperty('loopOffset', 42);
		expect(bytes[42]).toBe(0);
	});
	test('identifies ANIM loop bytes and leaves every source byte untouched', () => {
		const bytes = webp(vp8x, anim, anmf);
		const original = bytes.slice();
		const image = toSinglePlayAnimatedImage(bytes)!;
		expect(image.type).toBe('image/webp');
		expect(image.loopOffset).toBe(42);
		expect(Array.from(bytes.subarray(image.loopOffset!, image.loopOffset! + 2))).toEqual([0, 0]);
		expect(outputBytes(bytes)).toEqual(original);
	});
	test('rejects a WebP without ANIM', () => expect(toSinglePlayAnimatedImage(webp(vp8x, anmf))).toBeNull());
	test('rejects every truncated prefix', () => {
		const bytes = webp(vp8x, anim, anmf);
		for (let length = 0; length < bytes.length; length++)
			expect(toSinglePlayAnimatedImage(bytes.slice(0, length))).toBeNull();
	});
	test('rejects missing VP8X, missing frames and malformed chunk lengths', () => {
		expect(toSinglePlayAnimatedImage(webp(anim, anmf))).toBeNull();
		expect(toSinglePlayAnimatedImage(webp(vp8x, anim))).toBeNull();
		const bytes = webp(vp8x, anim, anmf);
		bytes[34] = 255;
		expect(toSinglePlayAnimatedImage(bytes)).toBeNull();
	});
	test('walks padded ICCP and unknown chunks before ANIM', () => {
		const bytes = webp(vp8x, chunk('ICCP', [1, 2, 3]), chunk('JUNK', [9]), anim, anmf);
		const image = toSinglePlayAnimatedImage(bytes);
		expect(image).toHaveProperty('loopOffset', 64);
		expect(outputBytes(bytes)).toEqual(bytes);
	});
	test('walks padded ALPH and VP8 sub-chunks inside multiple frames', () => {
		const alphaFrame = chunk('ANMF', [
			...Array<number>(16).fill(0),
			...chunk('ALPH', [0, 1, 2]),
			...chunk('VP8 ', [1, 2, 3]),
		]);
		const bytes = webp(vp8x, anim, alphaFrame, anmf);
		expect(toSinglePlayAnimatedImage(bytes)).toHaveProperty('loopOffset', 42);
		expect(outputBytes(bytes)).toEqual(bytes);
	});
	test('rejects duplicate ANIM chunks before the first frame', () => {
		expect(toSinglePlayAnimatedImage(webp(vp8x, anim, anim, anmf))).toBeNull();
	});
	test('rejects duplicate image sub-chunks in a frame', () => {
		const duplicateFrame = chunk('ANMF', [
			...Array<number>(16).fill(0),
			...chunk('VP8 ', [1]),
			...chunk('VP8L', [0x2f]),
		]);
		expect(toSinglePlayAnimatedImage(webp(vp8x, anim, duplicateFrame))).toBeNull();
	});
	test('returns a relative loop offset and source slices for an input with a nonzero byteOffset', () => {
		const bytes = webp(vp8x, anim, anmf);
		const backing = new Uint8Array(bytes.length + 17).fill(0xa5);
		backing.set(bytes, 7);
		const slice = backing.subarray(7, 7 + bytes.length);
		const image = toSinglePlayAnimatedImage(slice);
		expect(image).toHaveProperty('parts', [slice]);
		expect(image).toHaveProperty('loopOffset', 42);
		expect(image!.parts[0].buffer).toBe(backing.buffer);
		expect(image!.parts[0].byteOffset).toBe(7);
		expect(outputBytes(slice)).toEqual(bytes);
	});
});

test('rejects unknown magic bytes', () =>
	expect(toSinglePlayAnimatedImage(new Uint8Array(ascii('not an image')))).toBeNull());
