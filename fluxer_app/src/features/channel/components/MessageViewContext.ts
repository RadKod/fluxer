// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import type {User} from '@app/features/user/models/User';
import type {MessagePreviewContext} from '@fluxer/constants/src/ChannelConstants';
import React, {useContext} from 'react';

export interface MessagePreviewOverrides {
	usernameColor?: string;
	displayName?: string;
	// Micup: a preview draws this user as the author, not the stored one (the shop shows an item as if worn).
	author?: User;
}

export interface MessageViewContextValue {
	channel: Channel;
	message: Message;
	shouldGroup: boolean;
	isHovering: boolean;
	messageDisplayCompact: boolean;
	previewContext?: keyof typeof MessagePreviewContext;
	previewOverrides?: MessagePreviewOverrides;
	handleDelete: (bypassConfirm?: boolean) => void;
	onPopoutToggle?: (isOpen: boolean) => void;
	suppressMessageActions?: boolean;
	onHeadingActivate?: () => void;
}

const MessageViewContext = React.createContext<MessageViewContextValue | null>(null);
export const MessageViewContextProvider = MessageViewContext.Provider;
export const useMessageViewContext = (): MessageViewContextValue => {
	const context = useContext(MessageViewContext);
	if (!context) {
		throw new Error('useMessageViewContext must be used within a MessageViewContextProvider');
	}
	return context;
};
export const useMaybeMessageViewContext = (): MessageViewContextValue | null => useContext(MessageViewContext);
