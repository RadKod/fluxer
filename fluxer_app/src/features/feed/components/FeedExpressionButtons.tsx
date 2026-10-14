// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import type {FlatEmoji} from '@app/features/emoji/types/EmojiTypes';
import type {Gif} from '@app/features/expressions/commands/GifCommands';
import {ExpressionPickerSheet} from '@app/features/expressions/components/modals/ExpressionPickerSheet';
import {GifPickerSelectModal} from '@app/features/expressions/components/modals/GifPickerSelectModal';
import {ExpressionPickerPopout} from '@app/features/expressions/components/popouts/ExpressionPickerPopout';
import {feedEmojiText, insertAtSelection} from '@app/features/feed/utils/FeedExpressionUtils';
import {feedGifUrl} from '@app/features/feed/utils/FeedGifUtils';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Popout} from '@app/features/ui/popover/PopoverPopout';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {GifIcon, SmileyIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useState} from 'react';

const OPEN_EMOJI_PICKER_DESCRIPTOR = msg({
	message: 'Open emoji picker',
	comment: 'Accessible label and tooltip of the smiley button next to the feed post, comment and reply boxes.',
});
const CHOOSE_A_GIF_DESCRIPTOR = msg({
	message: 'Choose a GIF',
	comment:
		'Accessible label and tooltip of the GIF button next to the feed post, comment and reply boxes, and title of the GIF picker it opens. Keep it concise.',
});

interface FeedExpressionButtonsProps {
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	value: string;
	onChange: (value: string) => void;
	maxLength: number;
	disabled?: boolean;
	// A post takes a picked GIF as an image (onGif); without it the GIF's link goes into the text (comments, replies).
	onGif?: (gif: Gif) => void;
	gifDisabled?: boolean;
	buttonClassName: string;
	iconClassName: string;
}

// The chat's emoji picker and GIF picker for the feed's plain text boxes; an emoji goes in at the caret. There is no
// channel, so a custom emoji follows the DM rule of the picker (checkEmojiAvailability): usable only with global
// expressions.
export const FeedExpressionButtons = observer(
	({
		textareaRef,
		value,
		onChange,
		maxLength,
		disabled = false,
		onGif,
		gifDisabled = false,
		buttonClassName,
		iconClassName,
	}: FeedExpressionButtonsProps) => {
		const {i18n} = useLingui();
		const [isSheetOpen, setIsSheetOpen] = useState(false);
		// The box's maxLength only stops typing; the server refuses longer text.
		const write = (next: {value: string; caret: number}) => {
			if (next.value.length > maxLength) return;
			onChange(next.value);
			const textarea = textareaRef.current;
			requestAnimationFrame(() => {
				textarea?.focus();
				textarea?.setSelectionRange(next.caret, next.caret);
			});
		};
		// The open picker keeps the render it was opened with (PopoverPopout), so the text is read from the box itself:
		// a shift-click run of emojis each lands after the one before.
		const currentValue = () => textareaRef.current?.value ?? value;
		const selectEmoji = (emoji: FlatEmoji) => {
			const current = currentValue();
			const textarea = textareaRef.current;
			const start = textarea?.selectionStart ?? current.length;
			write(insertAtSelection(current, start, textarea?.selectionEnd ?? start, feedEmojiText(emoji)));
		};
		// A comment's GIF is its proxied Klipy link on a line of its own, drawn by FeedPostContent.
		const selectGif = (gif: Gif) => {
			if (onGif) return onGif(gif);
			const before = currentValue().trimEnd();
			const next = `${before}${before ? '\n' : ''}${feedGifUrl(gif, RuntimeConfig.mediaEndpoint)}`;
			write({value: next, caret: next.length});
		};
		const gifLabel = i18n._(CHOOSE_A_GIF_DESCRIPTOR);
		const openGifPicker = () =>
			ModalCommands.push(
				modal(() => (
					<GifPickerSelectModal
						title={gifLabel}
						onSelect={selectGif}
						data-flx="feed.feed-expression-buttons.gif-picker-select-modal"
					/>
				)),
			);
		const gifButton = RuntimeConfig.gifEnabled && (
			<FocusRing offset={-2} data-flx="feed.feed-expression-buttons.gif-focus-ring">
				<Tooltip text={gifLabel} data-flx="feed.feed-expression-buttons.gif-tooltip">
					<button
						type="button"
						className={buttonClassName}
						onClick={openGifPicker}
						disabled={disabled || gifDisabled}
						aria-label={gifLabel}
						aria-haspopup="dialog"
						data-flx="feed.feed-expression-buttons.gif-button.open-gif-picker"
					>
						<GifIcon
							weight="bold"
							className={iconClassName}
							aria-hidden
							data-flx="feed.feed-expression-buttons.gif-icon"
						/>
					</button>
				</Tooltip>
			</FocusRing>
		);
		const label = i18n._(OPEN_EMOJI_PICKER_DESCRIPTOR);
		const emojiButton = (onClick?: () => void) => (
			<FocusRing offset={-2} data-flx="feed.feed-expression-buttons.emoji-focus-ring">
				<button
					type="button"
					className={buttonClassName}
					onClick={onClick}
					disabled={disabled}
					aria-label={label}
					aria-haspopup="dialog"
					data-flx="feed.feed-expression-buttons.emoji-button"
				>
					<SmileyIcon
						weight="bold"
						className={iconClassName}
						aria-hidden
						data-flx="feed.feed-expression-buttons.smiley-icon"
					/>
				</button>
			</FocusRing>
		);
		if (MobileLayout.enabled) {
			return (
				<>
					{gifButton}
					{emojiButton(() => setIsSheetOpen(true))}
					<ExpressionPickerSheet
						isOpen={isSheetOpen}
						onClose={() => setIsSheetOpen(false)}
						onEmojiSelect={selectEmoji}
						visibleTabs={['emojis']}
						data-flx="feed.feed-expression-buttons.expression-picker-sheet"
					/>
				</>
			);
		}
		return (
			<>
				{gifButton}
				<Popout
					position="top-end"
					animationType="none"
					tooltip={label}
					returnFocusRef={textareaRef}
					render={({onClose}) => (
						<ExpressionPickerPopout
							onEmojiSelect={selectEmoji}
							onClose={onClose}
							visibleTabs={['emojis']}
							data-flx="feed.feed-expression-buttons.expression-picker-popout"
						/>
					)}
					data-flx="feed.feed-expression-buttons.popout"
				>
					{emojiButton()}
				</Popout>
			</>
		);
	},
);
