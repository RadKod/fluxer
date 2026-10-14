// SPDX-License-Identifier: AGPL-3.0-or-later

import {ThreadChannelResponse} from '@fluxer/schema/src/domains/channel/ThreadRequestSchemas';
import {createQueryIntegerType} from '@fluxer/schema/src/primitives/QueryValidators';
import {z} from 'zod';

export const ListGuildThreadsQuery = z.object({
	limit: createQueryIntegerType({defaultValue: 100, minValue: 1, maxValue: 100}),
	cursor: z
		.string()
		.max(256)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
});

export type ListGuildThreadsQuery = z.infer<typeof ListGuildThreadsQuery>;

export const ListGuildThreadsResponse = z.object({
	threads: z
		.array(ThreadChannelResponse)
		.describe('One page of active and archived threads, ordered by parent ID then thread ID'),
	next_cursor: z.string().nullable().describe('Cursor for the next page; an empty page may still have a cursor'),
});

export type ListGuildThreadsResponse = z.infer<typeof ListGuildThreadsResponse>;
