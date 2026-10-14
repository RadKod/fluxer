// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {getErrorMessageUnsafe} from '@fluxer/errors/src/i18n/ErrorI18n';
import {describe, expect, it} from 'vitest';

describe('MicupBOT errors', () => {
	it('MAX_MICUPBOT_REACTION_ROLE_PANELS is a 400 with the limit in data and message', async () => {
		expect(APIErrorCodes.MAX_MICUPBOT_REACTION_ROLE_PANELS).toBe('MAX_MICUPBOT_REACTION_ROLE_PANELS');
		const {MaxMicupBotReactionRolePanelsError} = await import(
			'@fluxer/errors/src/domains/guild/MaxMicupBotReactionRolePanelsError'
		);
		const error = new MaxMicupBotReactionRolePanelsError(25);
		expect(error.status).toBe(400);
		expect(error.code).toBe(APIErrorCodes.MAX_MICUPBOT_REACTION_ROLE_PANELS);
		expect(error.data).toEqual({max_micupbot_reaction_role_panels: 25});
		expect(error.toJSON()).toMatchObject({
			code: 'MAX_MICUPBOT_REACTION_ROLE_PANELS',
			max_micupbot_reaction_role_panels: 25,
		});
		expect(error.messageVariables).toEqual({count: 25});
		expect(getErrorMessageUnsafe(error.code, 'en-US', error.messageVariables)).toBe(
			'This community already has the maximum of 25 reaction role panels.',
		);
	});

	it('the two unknown codes are 404s', async () => {
		expect(APIErrorCodes.UNKNOWN_MICUPBOT_REACTION_ROLE_PANEL).toBe('UNKNOWN_MICUPBOT_REACTION_ROLE_PANEL');
		expect(APIErrorCodes.UNKNOWN_MICUPBOT_WARNING).toBe('UNKNOWN_MICUPBOT_WARNING');
		const {UnknownMicupBotReactionRolePanelError} = await import(
			'@fluxer/errors/src/domains/guild/UnknownMicupBotReactionRolePanelError'
		);
		const {UnknownMicupBotWarningError} = await import('@fluxer/errors/src/domains/guild/UnknownMicupBotWarningError');
		const panelError = new UnknownMicupBotReactionRolePanelError();
		const warningError = new UnknownMicupBotWarningError();
		for (const error of [panelError, warningError]) {
			expect(error.status).toBe(404);
			expect(error.data).toBeUndefined();
			expect(error.messageVariables).toBeUndefined();
		}
		expect(panelError.code).toBe(APIErrorCodes.UNKNOWN_MICUPBOT_REACTION_ROLE_PANEL);
		expect(warningError.code).toBe(APIErrorCodes.UNKNOWN_MICUPBOT_WARNING);
		expect(getErrorMessageUnsafe(panelError.code, 'en-US')).toBe('Unknown reaction role panel.');
		expect(getErrorMessageUnsafe(warningError.code, 'en-US')).toBe('Unknown warning.');
	});

	it('MICUPBOT_ROLE_NOT_ASSIGNABLE carries the role id', async () => {
		expect(APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE).toBe('MICUPBOT_ROLE_NOT_ASSIGNABLE');
		const {MicupBotRoleNotAssignableError} = await import(
			'@fluxer/errors/src/domains/guild/MicupBotRoleNotAssignableError'
		);
		const error = new MicupBotRoleNotAssignableError('123456789012345678');
		expect(error.status).toBe(400);
		expect(error.code).toBe(APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE);
		expect(error.data).toEqual({role_id: '123456789012345678'});
		expect(error.toJSON()).toMatchObject({code: 'MICUPBOT_ROLE_NOT_ASSIGNABLE', role_id: '123456789012345678'});
		expect(error.messageVariables).toBeUndefined();
		expect(getErrorMessageUnsafe(error.code, 'en-US')).toBe(
			"The bot cannot give this role: it is @everyone, above your highest role or the bot's, or it carries moderation permissions.",
		);
	});

	it('MICUPBOT_NOT_IN_GUILD is a 400', async () => {
		expect(APIErrorCodes.MICUPBOT_NOT_IN_GUILD).toBe('MICUPBOT_NOT_IN_GUILD');
		const {MicupBotNotInGuildError} = await import('@fluxer/errors/src/domains/guild/MicupBotNotInGuildError');
		const error = new MicupBotNotInGuildError();
		expect(error.status).toBe(400);
		expect(error.code).toBe(APIErrorCodes.MICUPBOT_NOT_IN_GUILD);
		expect(error.data).toBeUndefined();
		expect(error.messageVariables).toBeUndefined();
		expect(getErrorMessageUnsafe(error.code, 'en-US')).toBe('Add the bot to this community first.');
	});

	it('every new code has a Turkish message', () => {
		expect(getErrorMessageUnsafe('MAX_MICUPBOT_REACTION_ROLE_PANELS', 'tr', {count: 25})).toBe(
			'Bu toplulukta en çok 25 tepki rolü paneli olabilir.',
		);
		expect(getErrorMessageUnsafe('UNKNOWN_MICUPBOT_REACTION_ROLE_PANEL', 'tr')).toBe('Bilinmeyen tepki rolü paneli.');
		expect(getErrorMessageUnsafe('UNKNOWN_MICUPBOT_WARNING', 'tr')).toBe('Bilinmeyen uyarı.');
		expect(getErrorMessageUnsafe('MICUPBOT_ROLE_NOT_ASSIGNABLE', 'tr')).toBe(
			'Bot bu rolü veremez: rol @everyone, sizin ya da botun en yüksek rolünün üstünde veya moderasyon izni taşıyor.',
		);
		expect(getErrorMessageUnsafe('MICUPBOT_NOT_IN_GUILD', 'tr')).toBe('Önce botu bu topluluğa ekleyin.');
	});
});
