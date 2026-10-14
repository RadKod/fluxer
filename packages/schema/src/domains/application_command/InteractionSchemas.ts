// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ApplicationCommandOptionTypes,
	InteractionCallbackTypes,
	InteractionResponseFlags,
	MAX_APPLICATION_COMMAND_OPTIONS,
	MAX_INTERACTION_RESPONSE_BYTES,
} from '@fluxer/constants/src/ApplicationCommandConstants';
import {MAX_EMBEDS_PER_MESSAGE} from '@fluxer/constants/src/LimitConstants';
import {
	ApplicationCommandInteger,
	ApplicationCommandName,
	ApplicationCommandNumber,
	ApplicationCommandSnowflake,
	ApplicationCommandStringValue,
} from '@fluxer/schema/src/domains/application_command/ApplicationCommandSchemas';
import {MessageContentRequest, RichEmbedRequest} from '@fluxer/schema/src/domains/message/MessageRequestSchemas';
import {AllowedMentionsRequest} from '@fluxer/schema/src/domains/message/SharedMessageSchemas';
import {IsoTimestampStringType} from '@fluxer/schema/src/primitives/DateValidators';
import {z} from 'zod';

const OptionName = {name: ApplicationCommandName};
export const InteractionOption = z.discriminatedUnion('type', [
	z.strictObject({
		...OptionName,
		type: z.literal(ApplicationCommandOptionTypes.STRING),
		value: ApplicationCommandStringValue,
	}),
	z.strictObject({
		...OptionName,
		type: z.literal(ApplicationCommandOptionTypes.INTEGER),
		value: ApplicationCommandInteger,
	}),
	z.strictObject({...OptionName, type: z.literal(ApplicationCommandOptionTypes.BOOLEAN), value: z.boolean()}),
	z.strictObject({
		...OptionName,
		type: z.literal(ApplicationCommandOptionTypes.USER),
		value: ApplicationCommandSnowflake,
	}),
	z.strictObject({
		...OptionName,
		type: z.literal(ApplicationCommandOptionTypes.CHANNEL),
		value: ApplicationCommandSnowflake,
	}),
	z.strictObject({
		...OptionName,
		type: z.literal(ApplicationCommandOptionTypes.ROLE),
		value: ApplicationCommandSnowflake,
	}),
	z.strictObject({
		...OptionName,
		type: z.literal(ApplicationCommandOptionTypes.NUMBER),
		value: ApplicationCommandNumber,
	}),
]);
export type InteractionOption = z.infer<typeof InteractionOption>;

// The service also matches names/types, required options and choice values against the stored command version.
export const InteractionInvokeRequest = z.strictObject({
	application_id: ApplicationCommandSnowflake,
	command_id: ApplicationCommandSnowflake,
	command_version: ApplicationCommandSnowflake,
	channel_id: ApplicationCommandSnowflake,
	options: z
		.array(InteractionOption)
		.max(MAX_APPLICATION_COMMAND_OPTIONS)
		.refine((options) => new Set(options.map(({name}) => name)).size === options.length, 'Duplicate option name'),
	nonce: z
		.string()
		.min(1)
		.max(32)
		.refine((value) => value.trim().length > 0, 'Nonce cannot be blank'),
	session_id: z
		.string()
		.min(1)
		.max(64)
		.refine((value) => value.trim().length > 0, 'Session ID cannot be blank'),
});
export type InteractionInvokeRequest = z.infer<typeof InteractionInvokeRequest>;

const VisibilityFlags = z.union([z.literal(0), z.literal(InteractionResponseFlags.EPHEMERAL)]).default(0);
const AllowedMentions = AllowedMentionsRequest.extend({
	parse: AllowedMentionsRequest.shape.parse.default([]),
	users: z.array(ApplicationCommandSnowflake).max(100).optional(),
	roles: z.array(ApplicationCommandSnowflake).max(100).optional(),
}).strict();

// Text-only embeds reuse message validation without introducing remote media or URL fetching.
const EmbedFields = RichEmbedRequest.shape.fields.unwrap().unwrap();
const InteractionEmbed = RichEmbedRequest.pick({title: true, description: true, color: true, timestamp: true})
	.extend({
		fields: z.array(EmbedFields.element.strict()).max(25).optional(),
	})
	.strict()
	.refine((embed) => Boolean(embed.title || embed.description || embed.fields?.length), 'An embed requires text');

const ResponseData = z
	.strictObject({
		content: MessageContentRequest.optional(),
		embeds: z.array(InteractionEmbed).max(MAX_EMBEDS_PER_MESSAGE).optional(),
		allowed_mentions: AllowedMentions.default({parse: []}),
		flags: VisibilityFlags,
	})
	.refine((data) => Boolean(data.content) || Boolean(data.embeds?.length), 'A response requires content or an embed');

function responseWithinByteLimit(response: unknown): boolean {
	return new TextEncoder().encode(JSON.stringify(response)).byteLength <= MAX_INTERACTION_RESPONSE_BYTES;
}

export const InteractionCallbackRequest = z
	.discriminatedUnion('type', [
		z.strictObject({type: z.literal(InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE), data: ResponseData}),
		z.strictObject({
			type: z.literal(InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE),
			data: z.strictObject({flags: VisibilityFlags}).default({flags: 0}),
		}),
	])
	.refine(responseWithinByteLimit, 'Response exceeds UTF-8 byte limit');
export type InteractionCallbackRequest = z.infer<typeof InteractionCallbackRequest>;

// The service must enforce ACK state, fixed visibility, 20 followups, idempotency and the original 900s expiry.
export const InteractionFollowupRequest = ResponseData.refine(
	responseWithinByteLimit,
	'Response exceeds UTF-8 byte limit',
);
export type InteractionFollowupRequest = z.infer<typeof InteractionFollowupRequest>;

export const InteractionInvokeResponse = z.strictObject({
	id: ApplicationCommandSnowflake,
	status: z.enum(['RESERVED', 'PREPARED', 'DISPATCHING', 'ENQUEUED', 'NOT_DELIVERED', 'DELIVERY_UNKNOWN']),
	deadline_at: IsoTimestampStringType,
});
export type InteractionInvokeResponse = z.infer<typeof InteractionInvokeResponse>;
