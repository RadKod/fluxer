// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getFeedNotificationService} from '@app/api/middleware/ServiceSingletons';
import {FeedNotificationType} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const Snowflake = z.string().regex(/^\d+$/);
const PayloadSchema = z.union([
	z.object({recipientId: Snowflake, deliver: z.literal(true)}),
	z.object({recipientId: Snowflake, type: FeedNotificationType, postId: Snowflake, hour: z.number().int()}),
]);

// feed lane. With a key: folds the key's likes, comments or follows into its feed_notifications row and
// pushes it (at most once a minute per recipient). With deliver: pushes the notification that limit held back.
// Both are safe to rerun.
const aggregateFeedNotification: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	const recipientId = createUserID(BigInt(parsed.recipientId));
	const service = getFeedNotificationService();
	if ('deliver' in parsed) {
		await service.deliverHeld(recipientId);
		return;
	}
	await service.aggregate({recipientId, type: parsed.type, postId: BigInt(parsed.postId), hour: parsed.hour});
};

export default aggregateFeedNotification;
