// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRedactedInfoRequestLogger} from '@app/api/app/RequestLogRedaction';
import {redactRequestLogPath} from '@fluxer/errors/src/error_handling/RequestLogRedaction';
import {describe, expect, it, vi} from 'vitest';

const CODE = 'AbCdEfGhIjKlMnOpQrStUvWx';
const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyzABCDE';

describe('request log redaction', () => {
	it('masks gift codes, shop code lookups and callback tokens in request paths', () => {
		expect(redactRequestLogPath(`/v1/gifts/${CODE}/redeem`)).toBe('/v1/gifts/:code/redeem');
		expect(redactRequestLogPath(`/v1/gifts/${CODE}`)).toBe('/v1/gifts/:code');
		expect(redactRequestLogPath(`/gifts/${CODE}`)).toBe('/gifts/:code');
		expect(redactRequestLogPath(`/gifts/${CODE}/`)).toBe('/gifts/:code/');
		expect(redactRequestLogPath(`/test/gifts/${CODE}`)).toBe('/test/gifts/:code');
		expect(redactRequestLogPath(`/V1/Gifts/${CODE}`)).toBe('/V1/Gifts/:code');
		expect(redactRequestLogPath(`/v1/shop/codes/${CODE}`)).toBe('/v1/shop/codes/:code');
		expect(redactRequestLogPath(`/shop/codes/${CODE}`)).toBe('/shop/codes/:code');
		expect(redactRequestLogPath(`/v1/payriff/callback/1490000000000000001/${TOKEN}`)).toBe(
			'/v1/payriff/callback/1490000000000000001/:token',
		);
		expect(redactRequestLogPath(`/payriff/callback/149/${TOKEN}`)).toBe('/payriff/callback/149/:token');
		expect(redactRequestLogPath('/v1/users/@me')).toBe('/v1/users/@me');
		expect(redactRequestLogPath('/v1/users/@me/gifts')).toBe('/v1/users/@me/gifts');
		expect(redactRequestLogPath('/v1/shop/catalog')).toBe('/v1/shop/catalog');
	});

	it('the wrapped logger writes the masked path', () => {
		const logger = {info: vi.fn()};

		createRedactedInfoRequestLogger(logger)({
			method: 'GET',
			path: `/v1/payriff/callback/149/${TOKEN}`,
			status: 302,
			durationMs: 3,
		});

		expect(logger.info).toHaveBeenCalledWith(
			{method: 'GET', path: '/v1/payriff/callback/149/:token', status: 302, durationMs: 3},
			'Request completed',
		);
		expect(JSON.stringify(logger.info.mock.calls)).not.toContain(TOKEN);
	});
});
