// SPDX-License-Identifier: AGPL-3.0-or-later

import {MESSAGE_COMPONENT_LIMITS, MESSAGE_COMPONENT_REPLY_CODES} from '@fluxer/constants/src/MessageComponentConstants';
import {createStringType, SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const MessageButtonResponse = z.object({
	type: z.literal(2).describe('Component type: 2 is a button'),
	style: z.number().int().min(1).max(4).describe('Button style: 1 primary, 2 secondary, 3 success, 4 danger'),
	label: z.string().nullish().describe('The button text'),
	emoji: z
		.object({
			name: z.string().describe('The emoji name or unicode character'),
			id: SnowflakeStringType.nullable().describe('The custom emoji ID, or null for a unicode emoji'),
			animated: z.boolean().describe('Whether the custom emoji is animated'),
		})
		.nullish()
		.describe('The emoji shown on the button'),
	custom_id: z
		.string()
		.max(MESSAGE_COMPONENT_LIMITS.customIdMax)
		.describe('The ID sent back when the button is clicked'),
	disabled: z.boolean().describe('Whether the button can be clicked'),
});

export const MessageActionRowResponse = z.object({
	type: z.literal(1).describe('Component type: 1 is an action row'),
	components: z.array(MessageButtonResponse).max(MESSAGE_COMPONENT_LIMITS.buttonsPerRow).describe('The buttons'),
});
export type MessageActionRow = z.infer<typeof MessageActionRowResponse>;

export const MessageComponentClickRequest = z.object({
	custom_id: createStringType(1, MESSAGE_COMPONENT_LIMITS.customIdMax).describe('The custom_id of the clicked button'),
});

export const MessageComponentClickResponse = z.object({
	reply: z
		.object({
			code: z.enum(MESSAGE_COMPONENT_REPLY_CODES).describe('What happened; the client shows a translated message'),
			channel_id: SnowflakeStringType.nullish().describe('A channel the reply points to'),
		})
		.nullable()
		.describe('The bot reply shown only to the clicker, or null'),
});
export type MessageComponentClickResponse = z.infer<typeof MessageComponentClickResponse>;
