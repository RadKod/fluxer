// SPDX-License-Identifier: AGPL-3.0-or-later

import type {HonoEnv} from '@app/api/types/HonoEnv';
import {AppNotFoundHandler} from '@fluxer/errors/src/domains/core/ErrorHandlers';
import {createMiddleware} from 'hono/factory';

// TEMPORARY: announcement channels are closed; open only after bucketing ((source_channel_id, bucket), source_message_id) and capping followers, on a product decision.
export const AnnouncementChannelsRouteGuard = createMiddleware<HonoEnv>(async (ctx) => AppNotFoundHandler(ctx));
