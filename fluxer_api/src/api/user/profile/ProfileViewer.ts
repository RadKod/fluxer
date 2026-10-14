// SPDX-License-Identifier: AGPL-3.0-or-later

import type {HonoEnv} from '@app/api/types/HonoEnv';
import type {ProfileViewer} from '@app/api/user/profile/ProfileAccessRules';
import type {Context} from 'hono';

/** the caller as the profile access rule sees it. */
export function profileViewer(
	ctx: Context<HonoEnv>,
	{countStranger = false}: {countStranger?: boolean} = {},
): ProfileViewer {
	const user = ctx.get('user');
	return {user, human: ctx.get('authTokenType') === 'session' && !user.isBot, countStranger};
}
