// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {GatewayRpcTransport} from '@app/api/infrastructure/GatewayRpcClient';
import {GatewayRpcClient} from '@app/api/infrastructure/GatewayRpcClient';
import {GatewayService} from '@app/api/infrastructure/GatewayService';
import {afterEach, describe, expect, it} from 'vitest';

function recordingService(recorded: Array<Record<string, unknown>>): GatewayService {
	const transport: GatewayRpcTransport = {
		async call(_method: string, params: Record<string, unknown>): Promise<unknown> {
			recorded.push(params);
			return {success: true};
		},
		async destroy(): Promise<void> {},
	};
	GatewayRpcClient.createForTests(transport);
	return new GatewayService();
}

describe('voice.disconnect_user_if_in_channel params', () => {
	afterEach(async () => {
		await GatewayRpcClient.resetForTests();
	});

	const base = {
		guildId: createGuildID(1n),
		channelId: createChannelID(2n),
		userId: createUserID(3n),
		connectionId: 'crayfish-cirius',
	};

	it('sends the leaving connection token nonce as token_nonce', async () => {
		const recorded: Array<Record<string, unknown>> = [];
		await recordingService(recorded).disconnectVoiceUserIfInChannel({...base, tokenNonce: 'nonce-a1'});
		expect(recorded).toEqual([expect.objectContaining({connection_id: 'crayfish-cirius', token_nonce: 'nonce-a1'})]);
	});

	it('omits token_nonce when there is none', async () => {
		const recorded: Array<Record<string, unknown>> = [];
		await recordingService(recorded).disconnectVoiceUserIfInChannel(base);
		expect(recorded[0]).not.toHaveProperty('token_nonce');
	});
});
