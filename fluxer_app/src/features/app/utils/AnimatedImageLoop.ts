// SPDX-License-Identifier: AGPL-3.0-or-later

export interface SinglePlayAnimatedImage {
	parts: Array<Uint8Array<ArrayBuffer>>;
	type: 'image/gif' | 'image/webp';
	loopOffset?: number;
}

function matches(bytes: Uint8Array, offset: number, text: string): boolean {
	return Array.from(text).every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}

function skipSubBlocks(bytes: Uint8Array, offset: number): number | null {
	while (offset < bytes.length) {
		const length = bytes[offset++];
		if (length === 0) return offset;
		offset += length;
	}
	return null;
}

function singlePlayGif(bytes: Uint8Array<ArrayBuffer>): SinglePlayAnimatedImage | null {
	if (bytes.length < 13 || !(bytes[6] || bytes[7]) || !(bytes[8] || bytes[9])) return null;
	const hasGlobalTable = Boolean(bytes[10] & 0x80);
	let offset = 13 + (hasGlobalTable ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
	let frames = 0;
	const removed: Array<[number, number]> = [];
	while (offset < bytes.length) {
		const start = offset;
		const marker = bytes[offset++];
		if (marker === 0x3b) {
			if (!frames || offset !== bytes.length) return null;
			const parts: Array<Uint8Array<ArrayBuffer>> = [];
			let source = 0;
			for (const [from, to] of removed) {
				parts.push(bytes.subarray(source, from));
				source = to;
			}
			parts.push(bytes.subarray(source));
			return {parts, type: 'image/gif'};
		}
		if (marker === 0x21) {
			const label = bytes[offset++];
			const length = bytes[offset];
			if ((label === 0xff && length !== 11) || (label === 0xf9 && length !== 4) || (label === 0x01 && length !== 12))
				return null;
			const loop =
				label === 0xff && (matches(bytes, offset + 1, 'NETSCAPE2.0') || matches(bytes, offset + 1, 'ANIMEXTS1.0'));
			if (label === 0xf9 && bytes[offset + 5] !== 0) return null;
			const end = skipSubBlocks(bytes, offset);
			if (end == null) return null;
			if (loop) removed.push([start, end]);
			offset = end;
		} else if (marker === 0x2c) {
			if (
				offset + 9 > bytes.length ||
				!(bytes[offset + 4] || bytes[offset + 5]) ||
				!(bytes[offset + 6] || bytes[offset + 7])
			)
				return null;
			const packed = bytes[offset + 8];
			if (!hasGlobalTable && !(packed & 0x80)) return null;
			offset += 9 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
			const codeSize = bytes[offset++];
			if (codeSize < 2 || codeSize > 8 || offset >= bytes.length || bytes[offset] === 0) return null;
			const end = skipSubBlocks(bytes, offset);
			if (end == null) return null;
			offset = end;
			frames++;
		} else {
			return null;
		}
	}
	return null;
}

function singlePlayWebp(bytes: Uint8Array<ArrayBuffer>): SinglePlayAnimatedImage | null {
	if (bytes.length < 12) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(4, true) + 8 !== bytes.length) return null;
	let offset = 12;
	let extended = false;
	let loopOffset: number | null = null;
	let frames = 0;
	while (offset < bytes.length) {
		if (offset + 8 > bytes.length) return null;
		const length = view.getUint32(offset + 4, true);
		const data = offset + 8;
		const end = data + length;
		const paddedEnd = end + (length % 2);
		if (paddedEnd > bytes.length) return null;
		if (matches(bytes, offset, 'VP8X')) {
			if (offset !== 12 || length !== 10 || !(bytes[data] & 2)) return null;
			extended = true;
		} else if (matches(bytes, offset, 'ANIM')) {
			if (!extended || loopOffset != null || frames || length !== 6) return null;
			loopOffset = data + 4;
		} else if (matches(bytes, offset, 'ANMF')) {
			if (loopOffset == null || length < 24) return null;
			let subOffset = data + 16;
			let hasImage = false;
			while (subOffset < end) {
				if (subOffset + 8 > end) return null;
				const subLength = view.getUint32(subOffset + 4, true);
				if (matches(bytes, subOffset, 'VP8 ') || matches(bytes, subOffset, 'VP8L')) {
					if (hasImage || subLength === 0) return null;
					hasImage = true;
				}
				subOffset += 8 + subLength + (subLength % 2);
				if (subOffset > end) return null;
			}
			if (!hasImage) return null;
			frames++;
		}
		offset = paddedEnd;
	}
	if (loopOffset == null || !frames) return null;
	return {parts: [bytes], loopOffset, type: 'image/webp'};
}

export function toSinglePlayAnimatedImage(bytes: Uint8Array<ArrayBuffer>): SinglePlayAnimatedImage | null {
	if (matches(bytes, 0, 'GIF87a') || matches(bytes, 0, 'GIF89a')) return singlePlayGif(bytes);
	if (matches(bytes, 0, 'RIFF') && matches(bytes, 8, 'WEBP')) return singlePlayWebp(bytes);
	return null;
}
