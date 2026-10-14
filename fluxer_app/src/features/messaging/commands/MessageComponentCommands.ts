// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {createSystemMessage} from '@app/features/devtools/utils/CommandUtils';
import {TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as MessageCommands from '@app/features/messaging/commands/MessageCommands';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {replyDescriptor} from '@app/features/messaging/utils/MessageComponentReplies';
import {http} from '@app/features/platform/transport/RestTransport';
import {failureMessage} from '@app/features/platform/utils/ResponseInspection';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import type {MessageComponentClickResponse} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';
import type {I18n} from '@lingui/core';

export async function clickMessageComponent(i18n: I18n, message: Message, customId: string): Promise<void> {
	let reply: MessageComponentClickResponse['reply'];
	try {
		const response = await http.post<MessageComponentClickResponse>(
			Endpoints.CHANNEL_MESSAGE_COMPONENTS(message.channelId, message.id),
			{body: {custom_id: customId}},
		);
		reply = response.body.reply;
	} catch (error) {
		ToastCommands.error(failureMessage(error) ?? i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR));
		return;
	}
	const descriptor = reply ? replyDescriptor(reply.code) : undefined;
	if (!descriptor) return;
	// Shown only on this client, authored by the bot that owns the button; the server keeps no copy.
	const local = createSystemMessage(message.channelId, i18n._(descriptor), message.author.toJSON());
	MessageCommands.createOptimistic(message.channelId, local.toJSON());
}
