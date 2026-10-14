// SPDX-License-Identifier: AGPL-3.0-or-later

import {createBunnyStreamHandlers} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {createPayriffHandlers} from '@app/api/test/msw/handlers/PayriffHandlers';
import {createPwnedPasswordsRangeHandler} from '@app/api/test/msw/handlers/PwnedPasswordsHandlers';
import {setupServer} from 'msw/node';

export const server = setupServer(
	...createPayriffHandlers(),
	...createBunnyStreamHandlers(),
	createPwnedPasswordsRangeHandler(),
);
