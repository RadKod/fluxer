// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {LiveKitService} from '@app/api/infrastructure/LiveKitService';
import {server} from '@app/api/test/msw/server';
import {SignalRequest, SignalResponse, UpdateParticipantMetadata} from '@livekit/protocol';
import {RoomServiceClient} from 'livekit-server-sdk';
import {http, passthrough, ws} from 'msw';
import {describe, expect, it} from 'vitest';

// a participant holding a production voice token must not be able to set its own micup.seat
// attribute over the signal connection; only the API's RoomService write may. Needs a real LiveKit server:
// MICUP_LIVEKIT_TEST_URL=ws://localhost:7880 with `livekit-server --dev` (keys devkey/secret). CI KL2 starts it.
const LIVEKIT_URL = process.env.MICUP_LIVEKIT_TEST_URL;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!LIVEKIT_URL)('LiveKit voice seat attribute grant', () => {
	it('a voice token cannot write its own micup.seat attribute; the server write can', async () => {
		const url = LIVEKIT_URL!;
		const httpUrl = url.replace(/^ws/, 'http');
		// The test MSW server refuses unknown traffic; this test talks to the real LiveKit on purpose.
		server.use(
			http.all(`${httpUrl}/*`, () => passthrough()),
			ws.link(`${url}/rtc`).addEventListener('connection', ({server: livekit}) => livekit.connect()),
		);
		const roomService = new RoomServiceClient(httpUrl, 'devkey', 'secret');
		const service = Object.create(LiveKitService.prototype) as LiveKitService;
		Reflect.set(
			service,
			'serverClients',
			new Map([
				[
					'local',
					new Map([
						[
							'local-1',
							{endpoint: url, apiKey: 'devkey', apiSecret: 'secret', isActive: true, roomServiceClient: roomService},
						],
					]),
				],
			]),
		);
		const participant = {
			userId: createUserID(42n),
			guildId: createGuildID(1n),
			channelId: createChannelID(BigInt(Date.now())),
			connectionId: 'grant-test',
			regionId: 'local',
			serverId: 'local-1',
		};
		const room = `guild_${participant.guildId}_channel_${participant.channelId}`;
		const identity = `user_${participant.userId}_${participant.connectionId}`;
		const {token} = await service.createToken({...participant, tokenNonce: 'nonce'});

		const socket = new WebSocket(`${url}/rtc?access_token=${token}&auto_subscribe=0&sdk=js&protocol=15`);
		socket.binaryType = 'arraybuffer';
		const joined = new Promise<void>((resolve, reject) => {
			socket.addEventListener('message', (event) => {
				const response = SignalResponse.fromBinary(new Uint8Array(event.data as ArrayBuffer));
				if (response.message.case === 'join') resolve();
			});
			socket.addEventListener('error', () => reject(new Error('LiveKit signal connection failed')));
		});
		try {
			await joined;
			socket.send(
				new SignalRequest({
					message: {
						case: 'updateMetadata',
						value: new UpdateParticipantMetadata({attributes: {'micup.seat': 'seat_A_01'}, requestId: 1}),
					},
				}).toBinary(),
			);
			await sleep(3_000);
			expect((await roomService.getParticipant(room, identity)).attributes['micup.seat']).toBeUndefined();

			expect(await service.setParticipantAttributes({...participant, attributes: {'micup.seat': 'seat_A_01'}})).toBe(
				'ok',
			);
			expect((await roomService.getParticipant(room, identity)).attributes['micup.seat']).toBe('seat_A_01');
		} finally {
			socket.close();
		}
	}, 30_000);
});
