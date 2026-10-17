// SPDX-License-Identifier: AGPL-3.0-or-later

// Wire format of one data channel message: {t, seq, d}. There is no sender field; the receiver takes the sender
// from LiveKit, so a payload cannot speak for someone else.
export type ActivityEnvelopeType = 'app' | 'ping' | 'pong' | 'state' | 'state_req';

const ENVELOPE_TYPES: ReadonlySet<string> = new Set<ActivityEnvelopeType>([
	'app',
	'ping',
	'pong',
	'state',
	'state_req',
]);

// LiveKit splits nothing above this for a reliable packet; a bigger message would be dropped on the way.
export const ACTIVITY_MESSAGE_MAX_BYTES = 15_000;

export interface ActivityEnvelope {
	readonly type: ActivityEnvelopeType;
	readonly seq: number;
	readonly from: string;
	readonly data: unknown;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function encodeActivityEnvelope(
	type: ActivityEnvelopeType,
	seq: number,
	data: unknown,
): Uint8Array<ArrayBuffer> {
	const bytes = TEXT_ENCODER.encode(JSON.stringify(data === undefined ? {t: type, seq} : {t: type, seq, d: data}));
	if (bytes.byteLength > ACTIVITY_MESSAGE_MAX_BYTES) {
		throw new RangeError(`Activity message is ${bytes.byteLength} bytes, over ${ACTIVITY_MESSAGE_MAX_BYTES}`);
	}
	return bytes;
}

export function decodeActivityEnvelope(bytes: Uint8Array, senderIdentity: string): ActivityEnvelope | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(TEXT_DECODER.decode(bytes));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const {t, seq, d} = parsed as {t?: unknown; seq?: unknown; d?: unknown};
	if (typeof t !== 'string' || !ENVELOPE_TYPES.has(t)) return null;
	if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
	return {type: t as ActivityEnvelopeType, seq, from: senderIdentity, data: d};
}
