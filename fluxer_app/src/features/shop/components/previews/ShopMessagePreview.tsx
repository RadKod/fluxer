// SPDX-License-Identifier: AGPL-3.0-or-later

import {Message} from '@app/features/channel/components/ChannelMessage';
import {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import {Message as MessageModel} from '@app/features/messaging/models/MessagingMessage';
import styles from '@app/features/shop/components/previews/ShopMessagePreview.module.css';
import {
	PREVIEW_FIRST_MESSAGE_DESCRIPTOR,
	PREVIEW_SECOND_MESSAGE_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import type {User} from '@app/features/user/models/User';
import {MessagePreviewContext, MessageStates, MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useMemo} from 'react';

const PREVIEW_CHANNEL_ID = '1000000000000000051';
const PREVIEW_MESSAGE_IDS = ['1000000000000000052', '1000000000000000053'] as const;

interface ShopMessagePreviewProps {
	user: User;
}

// Two sample messages in the comfy layout (the compact one has no avatar), drawn by the real message component the
// way the appearance settings preview draws them. The stored user is the one without the item, so the preview user
// is handed over as the author.
export const ShopMessagePreview = observer<ShopMessagePreviewProps>(({user}) => {
	const {i18n} = useLingui();
	const channel = useMemo(
		() =>
			new Channel({
				id: PREVIEW_CHANNEL_ID,
				type: 0,
				name: 'shop-preview',
				position: 0,
				parent_id: null,
				topic: null,
				url: null,
				nsfw: false,
				last_message_id: null,
				last_pin_timestamp: null,
				bitrate: null,
				user_limit: null,
				permission_overwrites: [],
			}),
		[],
	);
	useEffect(() => {
		Channels.handleChannelCreate({channel: channel.toJSON()});
		return () => Channels.handleChannelDelete({channel: channel.toJSON()});
	}, [channel]);
	const previewOverrides = useMemo(() => ({author: user}), [user]);
	const messages = useMemo(() => {
		const author = user.toJSON();
		const sentAt = Date.now();
		return [PREVIEW_FIRST_MESSAGE_DESCRIPTOR, PREVIEW_SECOND_MESSAGE_DESCRIPTOR].map(
			(descriptor, index) =>
				new MessageModel(
					{
						id: PREVIEW_MESSAGE_IDS[index],
						channel_id: PREVIEW_CHANNEL_ID,
						author,
						type: MessageTypes.DEFAULT,
						flags: 0,
						pinned: false,
						mention_everyone: false,
						content: i18n._(descriptor),
						timestamp: new Date(sentAt + index * 60_000).toISOString(),
						state: MessageStates.SENT,
					},
					{skipUserCache: true},
				),
		);
	}, [user, i18n]);
	return (
		<div className={styles.panel} data-flx="shop.shop-message-preview.panel">
			{messages.map((message, index) => (
				<Message
					key={message.id}
					channel={channel}
					message={message}
					prevMessage={index > 0 ? messages[index - 1] : undefined}
					previewContext={MessagePreviewContext.SETTINGS}
					shouldGroup={index > 0}
					compact={false}
					previewOverrides={previewOverrides}
					data-flx="shop.shop-message-preview.message"
				/>
			))}
		</div>
	);
});
