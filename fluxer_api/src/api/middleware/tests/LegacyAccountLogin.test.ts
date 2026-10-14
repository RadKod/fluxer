// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {Hono} from 'hono';
import {describe, expect, it} from 'vitest';

function loginApp(row: UserRow): Hono<HonoEnv> {
	const app = new Hono<HonoEnv>();
	app.use('*', async (ctx, next) => {
		ctx.set('user', new User(row));
		await next();
	});
	app.onError((error, ctx) =>
		error instanceof FluxerError ? error.getResponse() : ctx.json({code: 'UNEXPECTED'}, 500),
	);
	app.get('/private', LoginRequired, (ctx) => ctx.json({allowed: true}));
	return app;
}

describe('legacy account login gate', () => {
	it.each([false, true])(
		'checks the runtime phone requirement on a read route with verified phone %s',
		async (verified) => {
			const row = {
				...EMPTY_USER_ROW,
				user_id: createUserID(123n),
				suspicious_activity_flags: 4,
				has_verified_phone: verified,
				email: 'legacy@example.com',
			};
			const response = await loginApp(row).request('/private');
			expect(response.status).toBe(verified ? 200 : 403);
			expect(await response.json()).toMatchObject(verified ? {allowed: true} : {code: 'ACCOUNT_LIMITED'});
		},
	);

	it('keeps the upstream account-limited bit out of the general login gate', async () => {
		const response = await loginApp({
			...EMPTY_USER_ROW,
			user_id: createUserID(123n),
			flags: UserFlags.ACCOUNT_LIMITED,
		}).request('/private');
		expect(response.status).toBe(200);
	});
});
