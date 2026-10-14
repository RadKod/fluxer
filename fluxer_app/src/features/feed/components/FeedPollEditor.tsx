// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/feed/components/FeedPollEditor.module.css';
import {
	FEED_POLL_DURATIONS_HOURS,
	FEED_POLL_MAX_OPTIONS,
	FEED_POLL_MIN_OPTIONS,
	FEED_POLL_OPTION_MAX_LENGTH,
} from '@app/features/feed/utils/FeedUtils';
import {
	ONE_DAY_DURATION_DESCRIPTOR,
	ONE_HOUR_DURATION_DESCRIPTOR,
	SEVEN_DAYS_DURATION_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {Combobox} from '@app/features/ui/components/form/FormCombobox';
import {Input} from '@app/features/ui/components/form/FormInput';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {XIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

export interface FeedPollDraft {
	options: ReadonlyArray<string>;
	durationHours: number;
}

export const EMPTY_FEED_POLL: FeedPollDraft = {options: ['', ''], durationHours: 24};

const OPTION_DESCRIPTOR = msg({
	message: 'Option {number}',
	comment: 'Placeholder and accessible label of one answer box in the poll of a new feed post. {number} is 1 to 4.',
});
const ADD_OPTION_DESCRIPTOR = msg({
	message: 'Add option',
	comment: 'Button under the answers of a new feed post poll that adds another answer box (up to four).',
});
const REMOVE_OPTION_DESCRIPTOR = msg({
	message: 'Remove option',
	comment: 'Accessible label of the button next to a poll answer box that removes that answer.',
});
const POLL_LENGTH_DESCRIPTOR = msg({
	message: 'Poll length',
	comment: 'Label of the menu that picks how long the poll of a new feed post takes votes.',
});
const THREE_DAYS_DESCRIPTOR = msg({
	message: '3 days',
	comment: 'Poll length option in the new feed post box: the poll takes votes for three days.',
});

const DURATION_LABELS: Record<(typeof FEED_POLL_DURATIONS_HOURS)[number], MessageDescriptor> = {
	1: ONE_HOUR_DURATION_DESCRIPTOR,
	24: ONE_DAY_DURATION_DESCRIPTOR,
	72: THREE_DAYS_DESCRIPTOR,
	168: SEVEN_DAYS_DURATION_DESCRIPTOR,
};

interface FeedPollEditorProps extends FeedPollDraft {
	onChange: (poll: FeedPollDraft) => void;
	disabled?: boolean;
}

export const FeedPollEditor = observer(({options, durationHours, onChange, disabled}: FeedPollEditorProps) => {
	const {i18n} = useLingui();
	const removeLabel = i18n._(REMOVE_OPTION_DESCRIPTOR);
	const setOptions = (next: ReadonlyArray<string>) => onChange({options: next, durationHours});
	return (
		<div className={styles.editor} data-flx="feed.feed-poll-editor.editor">
			<ul className={styles.options} data-flx="feed.feed-poll-editor.options">
				{options.map((option, index) => {
					const optionLabel = i18n._(OPTION_DESCRIPTOR, {number: index + 1});
					return (
						<li key={index} className={styles.option} data-flx="feed.feed-poll-editor.options.option">
							<div className={styles.input} data-flx="feed.feed-poll-editor.input">
								<Input
									aria-label={optionLabel}
									placeholder={optionLabel}
									value={option}
									maxLength={FEED_POLL_OPTION_MAX_LENGTH}
									onChange={(event) => setOptions(options.map((old, at) => (at === index ? event.target.value : old)))}
									disabled={disabled}
									data-flx="feed.feed-poll-editor.input.set-option.text"
								/>
							</div>
							{options.length > FEED_POLL_MIN_OPTIONS && (
								<FocusRing offset={-2} data-flx="feed.feed-poll-editor.focus-ring">
									<Tooltip text={removeLabel} data-flx="feed.feed-poll-editor.tooltip">
										<button
											type="button"
											className={styles.removeButton}
											onClick={() => setOptions(options.filter((_, at) => at !== index))}
											disabled={disabled}
											aria-label={removeLabel}
											data-flx="feed.feed-poll-editor.remove-button.remove-option"
										>
											<XIcon weight="bold" aria-hidden data-flx="feed.feed-poll-editor.x-icon" />
										</button>
									</Tooltip>
								</FocusRing>
							)}
						</li>
					);
				})}
			</ul>
			<div className={styles.footer} data-flx="feed.feed-poll-editor.footer">
				{options.length < FEED_POLL_MAX_OPTIONS && (
					<Button
						small
						fitContent
						variant="secondary"
						className={styles.addOption}
						onClick={() => setOptions([...options, ''])}
						disabled={disabled}
						data-flx="feed.feed-poll-editor.button.add-option"
					>
						{i18n._(ADD_OPTION_DESCRIPTOR)}
					</Button>
				)}
				<div className={styles.length} data-flx="feed.feed-poll-editor.length">
					<Combobox<number>
						label={i18n._(POLL_LENGTH_DESCRIPTOR)}
						value={durationHours}
						options={FEED_POLL_DURATIONS_HOURS.map((hours) => ({value: hours, label: i18n._(DURATION_LABELS[hours])}))}
						onChange={(hours) => onChange({options, durationHours: hours})}
						disabled={disabled}
						isSearchable={false}
						density="compact"
						data-flx="feed.feed-poll-editor.combobox.set-poll-length"
					/>
				</div>
			</div>
		</div>
	);
});
