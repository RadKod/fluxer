// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {getErrorMessageUnsafe} from '@fluxer/errors/src/i18n/ErrorI18n';
import {describe, expect, it} from 'vitest';

describe('guild roster errors', () => {
	it('MAX_GUILD_ROSTER_EVENTS is a 400 with the limit in data and message', async () => {
		expect(APIErrorCodes.MAX_GUILD_ROSTER_EVENTS).toBe('MAX_GUILD_ROSTER_EVENTS');
		const {MaxGuildRosterEventsError} = await import('@fluxer/errors/src/domains/guild/MaxGuildRosterEventsError');
		const error = new MaxGuildRosterEventsError(10);
		expect(error.status).toBe(400);
		expect(error.code).toBe(APIErrorCodes.MAX_GUILD_ROSTER_EVENTS);
		expect(error.data).toEqual({max_guild_roster_events: 10});
		expect(error.toJSON()).toMatchObject({code: 'MAX_GUILD_ROSTER_EVENTS', max_guild_roster_events: 10});
		expect(error.messageVariables).toEqual({count: 10});
		expect(getErrorMessageUnsafe(error.code, 'en-US', error.messageVariables)).toBe(
			'This community already has the maximum of 10 roster events.',
		);
	});

	it('UNKNOWN_GUILD_ROSTER_EVENT is a 404', async () => {
		expect(APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT).toBe('UNKNOWN_GUILD_ROSTER_EVENT');
		const {UnknownGuildRosterEventError} = await import(
			'@fluxer/errors/src/domains/guild/UnknownGuildRosterEventError'
		);
		const error = new UnknownGuildRosterEventError();
		expect(error.status).toBe(404);
		expect(error.code).toBe(APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT);
		expect(error.data).toBeUndefined();
		expect(error.messageVariables).toBeUndefined();
		expect(getErrorMessageUnsafe(error.code, 'en-US')).toBe('Unknown roster event.');
	});

	it('both codes have a Turkish message', () => {
		expect(getErrorMessageUnsafe('MAX_GUILD_ROSTER_EVENTS', 'tr', {count: 10})).toBe(
			'Bu toplulukta en çok 10 etkinlik olabilir.',
		);
		expect(getErrorMessageUnsafe('UNKNOWN_GUILD_ROSTER_EVENT', 'tr')).toBe('Bilinmeyen etkinlik.');
	});
});
