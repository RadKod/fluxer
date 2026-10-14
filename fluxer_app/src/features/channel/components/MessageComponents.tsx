// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/channel/components/MessageComponents.module.css';
import {clickMessageComponent} from '@app/features/messaging/commands/MessageComponentCommands';
import {ReactionImage} from '@app/features/messaging/components/ReactionImage';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {useEmojiURL} from '@app/features/messaging/utils/ReactionUtils';
import {Button, type ButtonVariant} from '@app/features/ui/button/Button';
import {ButtonStyles} from '@fluxer/constants/src/MessageComponentConstants';
import type {MessageActionRow} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

type MessageButton = MessageActionRow['components'][number];

const VARIANTS: Record<number, ButtonVariant> = {
	[ButtonStyles.PRIMARY]: 'primary',
	[ButtonStyles.SECONDARY]: 'secondary',
	[ButtonStyles.SUCCESS]: 'primary',
	[ButtonStyles.DANGER]: 'danger',
};

function ButtonEmoji({emoji}: {emoji: NonNullable<MessageButton['emoji']>}) {
	const url = useEmojiURL({emoji});
	if (!url) return null;
	return (
		<ReactionImage
			src={url}
			alt={emoji.name}
			aria-hidden={true}
			draggable={false}
			className={styles.emoji}
			data-flx="channel.message-components.button-emoji.emoji"
		/>
	);
}

function MessageComponentButton({
	message,
	button,
	isPreview,
}: {
	message: Message;
	button: MessageButton;
	isPreview: boolean;
}) {
	const {i18n} = useLingui();
	const [pending, setPending] = useState(false);
	const handleClick = async () => {
		setPending(true);
		try {
			await clickMessageComponent(i18n, message, button.custom_id);
		} finally {
			setPending(false);
		}
	};
	return (
		<Button
			variant={VARIANTS[button.style] ?? 'secondary'}
			small
			fitContent
			className={clsx(styles.button, button.style === ButtonStyles.SUCCESS && styles.success)}
			contentClassName={styles.content}
			disabled={isPreview || button.disabled}
			submitting={pending}
			aria-busy={pending || undefined}
			leftIcon={
				button.emoji ? (
					<ButtonEmoji
						emoji={button.emoji}
						data-flx="channel.message-components.message-component-button.button-emoji"
					/>
				) : undefined
			}
			aria-label={button.label || button.emoji?.name}
			onClick={() => void handleClick()}
			data-flx="channel.message-components.message-component-button.button"
		>
			{button.label ? (
				<span className={styles.label} data-flx="channel.message-components.message-component-button.label">
					{button.label}
				</span>
			) : null}
		</Button>
	);
}

export const MessageComponents = observer(({message, isPreview}: {message: Message; isPreview: boolean}) => {
	if (message.components.length === 0) return null;
	return (
		<div className={styles.components} data-flx="channel.message-components.components">
			{message.components.map((row, rowIndex) => (
				<div key={rowIndex} role="group" className={styles.row} data-flx="channel.message-components.row">
					{row.components.map((button, buttonIndex) => (
						<MessageComponentButton
							key={buttonIndex}
							message={message}
							button={button}
							isPreview={isPreview}
							data-flx="channel.message-components.message-component-button"
						/>
					))}
				</div>
			))}
		</div>
	);
});
