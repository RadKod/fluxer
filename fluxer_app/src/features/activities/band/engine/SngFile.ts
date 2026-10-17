// SPDX-License-Identifier: AGPL-3.0-or-later

// Reader for the .sng container (https://github.com/mdsitton/SngFileFormat). parse-sng is not used because its
// header parser compiles code with `new Function`, which the app's CSP (no 'unsafe-eval') blocks.

export interface SongFile {
	readonly fileName: string;
	readonly data: Uint8Array;
}

export interface SngContents {
	readonly version: number;
	readonly metadata: Readonly<Record<string, string>>;
	readonly files: ReadonlyArray<SongFile>;
}

const SNG_IDENTIFIER = 'SNGPKG';
const XOR_MASK_LENGTH = 16;

export class SngFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SngFormatError';
	}
}

class SngCursor {
	private offset = 0;
	private readonly view: DataView;
	private readonly decoder = new TextDecoder('utf-8');

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	private claim(length: number): number {
		if (length < 0 || this.offset + length > this.bytes.length) {
			throw new SngFormatError(`.sng ended early at byte ${this.offset}`);
		}
		const start = this.offset;
		this.offset += length;
		return start;
	}

	bytesOf(length: number): Uint8Array {
		const start = this.claim(length);
		return this.bytes.subarray(start, start + length);
	}

	string(length: number): string {
		return this.decoder.decode(this.bytesOf(length));
	}

	uint8(): number {
		return this.view.getUint8(this.claim(1));
	}

	int32(): number {
		return this.view.getInt32(this.claim(4), true);
	}

	uint32(): number {
		return this.view.getUint32(this.claim(4), true);
	}

	uint64(): number {
		const value = this.view.getBigUint64(this.claim(8), true);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new SngFormatError('.sng size field is out of range');
		}
		return Number(value);
	}
}

export function parseSng(bytes: Uint8Array): SngContents {
	const cursor = new SngCursor(bytes);
	if (cursor.string(SNG_IDENTIFIER.length) !== SNG_IDENTIFIER) {
		throw new SngFormatError('Not a .sng file');
	}
	const version = cursor.uint32();
	const xorMask = cursor.bytesOf(XOR_MASK_LENGTH);

	cursor.uint64();
	const metadataCount = cursor.uint64();
	const metadata: Record<string, string> = {};
	for (let i = 0; i < metadataCount; i++) {
		const key = cursor.string(cursor.int32());
		metadata[key] = cursor.string(cursor.int32());
	}

	cursor.uint64();
	const fileCount = cursor.uint64();
	const entries: Array<{fileName: string; length: number; index: number}> = [];
	for (let i = 0; i < fileCount; i++) {
		const fileName = cursor.string(cursor.uint8());
		const length = cursor.uint64();
		const index = cursor.uint64();
		if (index + length > bytes.length) {
			throw new SngFormatError(`.sng entry "${fileName}" points past the end of the file`);
		}
		entries.push({fileName, length, index});
	}

	const files = entries.map(({fileName, length, index}) => ({
		fileName,
		data: unmask(bytes.subarray(index, index + length), xorMask),
	}));
	return {version, metadata, files};
}

function unmask(masked: Uint8Array, xorMask: Uint8Array): Uint8Array {
	const unmasked = new Uint8Array(masked.length);
	for (let i = 0; i < masked.length; i++) {
		const cyclicIndex = i & 0xff;
		unmasked[i] = masked[i] ^ xorMask[cyclicIndex & 0x0f] ^ cyclicIndex;
	}
	return unmasked;
}
