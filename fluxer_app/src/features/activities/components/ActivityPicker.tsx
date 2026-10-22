// SPDX-License-Identifier: AGPL-3.0-or-later

import {startVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import {ACTIVITIES_DESCRIPTOR} from '@app/features/activities/components/ActivityMessages';
import styles from '@app/features/activities/components/ActivityPicker.module.css';
import type {ActivityDefinition} from '@app/features/activities/registry/ActivityDefinition';
import {ACTIVITY_LIST, UPCOMING_ACTIVITIES} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import * as Modal from '@app/features/app/components/dialogs/Modal';
import Channels from '@app/features/channel/state/Channels';
import {CLOSE_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowLeftIcon, MagnifyingGlassIcon, XIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useRef, useState} from 'react';

const PICKER_MODAL_KEY = 'voice-activity-picker';

const CHANNEL_PEOPLE_DESCRIPTOR = msg({
	message: '{channel} · {count, plural, one {# person} other {# people}}',
	comment:
		'Voice activities: next to the title of the activity picker. {channel} is the voice channel name, {count} how many people are in it.',
});
const SEARCH_ACTIVITIES_DESCRIPTOR = msg({
	message: 'Search activities',
	comment: 'Voice activities: placeholder and label of the search field in the activity picker.',
});
const NO_MATCH_DESCRIPTOR = msg({
	message: 'No activity matches “{query}”',
	comment: 'Voice activities: shown in the activity picker when the search finds nothing. {query} is what was typed.',
});
const COMING_SOON_DESCRIPTOR = msg({
	message: 'Coming soon',
	context: 'voice-activities',
	comment: 'Voice activities: heading over the activities in the picker that are announced but cannot be started yet.',
});
const OPEN_ACTIVITY_DESCRIPTOR = msg({
	message: 'Open',
	context: 'voice-activity-card',
	comment: 'Voice activities: cue on an activity card in the picker; clicking the card opens its detail page.',
});
const PLAYER_RANGE_DESCRIPTOR = msg({
	message: '{min}–{max} people',
	comment:
		'Voice activities: how many people can play an activity, on its card and detail page. For example "1–6 people".',
});
const PLAYER_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# person} other {# people}}',
	context: 'voice-activity-players',
	comment:
		'Voice activities: how many people play an activity that needs an exact number, on its card and detail page.',
});
const BACK_TO_ACTIVITIES_DESCRIPTOR = msg({
	message: 'Back to activities',
	comment: 'Voice activities: back button on an activity detail page, returns to the list of activities.',
});
const HOW_IT_GOES_DESCRIPTOR = msg({
	message: 'How it goes',
	context: 'voice-activity',
	comment: 'Voice activities: accessible name of the numbered steps on an activity detail page.',
});
const START_ACTIVITY_DESCRIPTOR = msg({
	message: 'Start',
	context: 'voice-activity',
	comment: 'Voice activities: button on an activity detail page that starts the activity in the voice channel.',
});
const ONE_AT_A_TIME_DESCRIPTOR = msg({
	message: 'An activity is already running. End it before starting another.',
	comment: 'Voice activities: tooltip on a disabled entry of the activity list. A channel runs one activity at a time.',
});
const NEEDS_PEOPLE_DESCRIPTOR = msg({
	message: 'Needs at least {count} people in the channel',
	comment: 'Voice activities: tooltip on a disabled entry of the activity list. {count} is a number above 1.',
});

function playersLabel(i18n: I18n, definition: ActivityDefinition): string {
	const {minPlayers: min, maxPlayers: max} = definition;
	return min === max ? i18n._(PLAYER_COUNT_DESCRIPTOR, {count: min}) : i18n._(PLAYER_RANGE_DESCRIPTOR, {min, max});
}

function matches(i18n: I18n, query: string, texts: ReadonlyArray<MessageDescriptor>): boolean {
	const needle = query.trim().toLocaleLowerCase(i18n.locale);
	return needle.length === 0 || texts.some((text) => i18n._(text).toLocaleLowerCase(i18n.locale).includes(needle));
}

function peopleInChannel(channelId: string): number {
	return Object.keys(MediaEngine.getAllVoiceStatesInChannel(MediaEngine.guildId ?? '', channelId)).length;
}

const ActivityCard = observer(function ActivityCard({
	definition,
	onOpen,
}: {
	readonly definition: ActivityDefinition;
	readonly onOpen: () => void;
}) {
	const {i18n} = useLingui();
	const {Cover} = definition;
	const contentCount = definition.contentCount?.(i18n) ?? null;
	return (
		<FocusRing offset={-2} data-flx="activities.activity-picker.activity-card.focus-ring">
			<button
				type="button"
				className={styles.card}
				onClick={onOpen}
				data-flx="activities.activity-picker.activity-card.card"
			>
				<div className={styles.cardCover} data-flx="activities.activity-picker.activity-card.cover">
					<Cover size="card" data-flx="activities.activity-picker.activity-card.activity-cover" />
					{contentCount && (
						<span className={styles.coverChip} data-flx="activities.activity-picker.activity-card.cover-chip">
							{contentCount}
						</span>
					)}
				</div>
				<div className={styles.cardBody} data-flx="activities.activity-picker.activity-card.body">
					<div className={styles.cardText} data-flx="activities.activity-picker.activity-card.text">
						<span className={styles.cardName} data-flx="activities.activity-picker.activity-card.name">
							{i18n._(definition.name)}
						</span>
						<span className={styles.cardTagline} data-flx="activities.activity-picker.activity-card.tagline">
							{i18n._(definition.tagline)}
						</span>
					</div>
					<div className={styles.cardMeta} data-flx="activities.activity-picker.activity-card.meta">
						<span className={styles.cardPlayers} data-flx="activities.activity-picker.activity-card.players">
							{playersLabel(i18n, definition)}
						</span>
						<span className={styles.cardOpen} data-flx="activities.activity-picker.activity-card.open">
							{i18n._(OPEN_ACTIVITY_DESCRIPTOR)}
						</span>
					</div>
				</div>
			</button>
		</FocusRing>
	);
});

const ActivityDetail = observer(function ActivityDetail({
	channelId,
	peopleCount,
	definition,
	onBack,
	onStarted,
}: {
	readonly channelId: string;
	readonly peopleCount: number;
	readonly definition: ActivityDefinition;
	readonly onBack: () => void;
	readonly onStarted: () => void;
}) {
	const {i18n} = useLingui();
	const {Cover} = definition;
	const contentCount = definition.contentCount?.(i18n) ?? null;
	const chips = [playersLabel(i18n, definition), contentCount, ...definition.facts.map((fact) => i18n._(fact))].filter(
		(chip): chip is string => chip !== null,
	);
	const running = VoiceActivities.getSession(channelId) !== null;
	const tooFew = peopleCount < definition.minPlayers;
	const blockReason = running
		? i18n._(ONE_AT_A_TIME_DESCRIPTOR)
		: tooFew
			? i18n._(NEEDS_PEOPLE_DESCRIPTOR, {count: definition.minPlayers})
			: null;
	const handleStart = async () => {
		const outcome = await startVoiceActivity(channelId, definition.id);
		if (outcome.ok) onStarted();
	};
	const backLabel = i18n._(BACK_TO_ACTIVITIES_DESCRIPTOR);
	return (
		<div className={styles.detail} data-flx="activities.activity-picker.activity-detail.detail">
			<div className={styles.hero} data-flx="activities.activity-picker.activity-detail.hero">
				<Cover size="hero" data-flx="activities.activity-picker.activity-detail.activity-cover" />
				<FocusRing offset={-2} data-flx="activities.activity-picker.activity-detail.back-focus-ring">
					<button
						type="button"
						className={styles.backButton}
						onClick={onBack}
						aria-label={backLabel}
						data-flx="activities.activity-picker.activity-detail.back"
					>
						<ArrowLeftIcon
							weight="bold"
							className={styles.backIcon}
							data-flx="activities.activity-picker.activity-detail.back-icon"
						/>
					</button>
				</FocusRing>
			</div>
			<div className={styles.detailBody} data-flx="activities.activity-picker.activity-detail.body">
				<h2 className={styles.srOnly} data-flx="activities.activity-picker.activity-detail.name">
					{i18n._(definition.name)}
				</h2>
				<ul className={styles.chips} data-flx="activities.activity-picker.activity-detail.chips">
					{chips.map((chip) => (
						<li key={chip} className={styles.chip} data-flx="activities.activity-picker.activity-detail.chip">
							{chip}
						</li>
					))}
				</ul>
				<p className={styles.description} data-flx="activities.activity-picker.activity-detail.description">
					{i18n._(definition.description)}
				</p>
				<ol
					className={styles.steps}
					aria-label={i18n._(HOW_IT_GOES_DESCRIPTOR)}
					data-flx="activities.activity-picker.activity-detail.steps"
				>
					{definition.steps.map((step, index) => (
						<li key={step.title.id} className={styles.step} data-flx="activities.activity-picker.activity-detail.step">
							<span
								className={styles.stepNumber}
								aria-hidden="true"
								data-flx="activities.activity-picker.activity-detail.step-number"
							>
								{i18n.number(index + 1)}
							</span>
							<span className={styles.stepTitle} data-flx="activities.activity-picker.activity-detail.step-title">
								{i18n._(step.title)}
							</span>
							<span className={styles.stepBody} data-flx="activities.activity-picker.activity-detail.step-body">
								{i18n._(step.body)}
							</span>
						</li>
					))}
				</ol>
				<div className={styles.startArea} data-flx="activities.activity-picker.activity-detail.start-area">
					<Button
						fitContainer
						disabled={blockReason !== null}
						submitting={VoiceActivities.request === 'start'}
						onClick={() => void handleStart()}
						data-flx="activities.activity-picker.activity-detail.start"
					>
						{i18n._(START_ACTIVITY_DESCRIPTOR)}
					</Button>
					<p className={styles.startNote} data-flx="activities.activity-picker.activity-detail.start-note">
						{blockReason ?? i18n._(definition.startNote)}
					</p>
				</div>
			</div>
		</div>
	);
});

interface ActivityPickerPanelProps {
	readonly channelId: string;
	readonly channelName: string;
	readonly peopleCount: number;
	readonly onClose: () => void;
	readonly searchRef?: React.Ref<HTMLInputElement>;
}

// The picker's content: the list with its search, or one activity's detail page with Start. The modal around it is
// the app's; the band harness shows it on its own.
export const ActivityPickerPanel = observer(function ActivityPickerPanel({
	channelId,
	channelName,
	peopleCount,
	onClose,
	searchRef,
}: ActivityPickerPanelProps) {
	const {i18n} = useLingui();
	const [query, setQuery] = useState('');
	const [openId, setOpenId] = useState<ActivityDefinition['id'] | null>(null);
	const open = ACTIVITY_LIST.find((definition) => definition.id === openId) ?? null;
	const title = i18n._(ACTIVITIES_DESCRIPTOR);
	const activities = ACTIVITY_LIST.filter((definition) => matches(i18n, query, [definition.name, definition.tagline]));
	const upcoming = UPCOMING_ACTIVITIES.filter((definition) =>
		matches(i18n, query, [definition.name, definition.tagline]),
	);
	const closeLabel = i18n._(CLOSE_DESCRIPTOR);
	return (
		<>
			{open ? (
				<Modal.Content padding="none" data-flx="activities.activity-picker.detail-content">
					<ActivityDetail
						channelId={channelId}
						peopleCount={peopleCount}
						definition={open}
						onBack={() => setOpenId(null)}
						onStarted={onClose}
						data-flx="activities.activity-picker.activity-detail"
					/>
				</Modal.Content>
			) : (
				<>
					<div className={styles.header} data-flx="activities.activity-picker.header">
						<h1 className={styles.title} data-flx="activities.activity-picker.title">
							{title}
						</h1>
						<span className={styles.channel} data-flx="activities.activity-picker.channel">
							{i18n._(CHANNEL_PEOPLE_DESCRIPTOR, {channel: channelName, count: peopleCount})}
						</span>
						<FocusRing offset={-2} data-flx="activities.activity-picker.close-focus-ring">
							<button
								type="button"
								className={styles.closeButton}
								onClick={onClose}
								aria-label={closeLabel}
								data-flx="activities.activity-picker.close"
							>
								<XIcon weight="bold" className={styles.closeIcon} data-flx="activities.activity-picker.close-icon" />
							</button>
						</FocusRing>
					</div>
					<div className={styles.search} data-flx="activities.activity-picker.search">
						<Input
							ref={searchRef}
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={i18n._(SEARCH_ACTIVITIES_DESCRIPTOR)}
							aria-label={i18n._(SEARCH_ACTIVITIES_DESCRIPTOR)}
							leftIcon={
								<MagnifyingGlassIcon
									aria-hidden
									size={16}
									weight="bold"
									data-flx="activities.activity-picker.search-icon"
								/>
							}
							data-flx="activities.activity-picker.search-input"
						/>
					</div>
					<Modal.Content padding="none" contentClassName={styles.list} data-flx="activities.activity-picker.list">
						{activities.map((definition) => (
							<ActivityCard
								key={definition.id}
								definition={definition}
								onOpen={() => setOpenId(definition.id)}
								data-flx="activities.activity-picker.activity-card"
							/>
						))}
						{activities.length === 0 && upcoming.length === 0 && (
							<p className={styles.empty} data-flx="activities.activity-picker.empty">
								{i18n._(NO_MATCH_DESCRIPTOR, {query: query.trim()})}
							</p>
						)}
						{upcoming.length > 0 && (
							<section className={styles.upcoming} data-flx="activities.activity-picker.upcoming">
								<h2 className={styles.upcomingTitle} data-flx="activities.activity-picker.upcoming-title">
									{i18n._(COMING_SOON_DESCRIPTOR)}
								</h2>
								<ul className={styles.upcomingGrid} data-flx="activities.activity-picker.upcoming-grid">
									{upcoming.map(({key, name, tagline, Cover}) => (
										<li
											key={key}
											className={styles.upcomingCard}
											aria-disabled="true"
											data-flx="activities.activity-picker.upcoming-card"
										>
											<div className={styles.upcomingCover} data-flx="activities.activity-picker.upcoming-cover">
												<Cover size="thumb" data-flx="activities.activity-picker.upcoming-activity-cover" />
											</div>
											<div className={styles.upcomingText} data-flx="activities.activity-picker.upcoming-text">
												<span className={styles.upcomingName} data-flx="activities.activity-picker.upcoming-name">
													{i18n._(name)}
												</span>
												<span className={styles.upcomingTagline} data-flx="activities.activity-picker.upcoming-tagline">
													{i18n._(tagline)}
												</span>
											</div>
										</li>
									))}
									{query.trim() === '' && upcoming.length % 2 === 1 && (
										<li
											className={styles.upcomingFiller}
											aria-hidden="true"
											data-flx="activities.activity-picker.upcoming-filler"
										/>
									)}
								</ul>
							</section>
						)}
					</Modal.Content>
				</>
			)}
		</>
	);
});

const ActivityPickerModal = observer(function ActivityPickerModal({channelId}: {readonly channelId: string}) {
	const {i18n} = useLingui();
	const searchRef = useRef<HTMLInputElement | null>(null);
	return (
		<Modal.Root
			size="medium"
			className={styles.modal}
			initialFocusRef={searchRef}
			data-flx="activities.activity-picker.modal"
		>
			<Modal.ScreenReaderLabel text={i18n._(ACTIVITIES_DESCRIPTOR)} data-flx="activities.activity-picker.sr-label" />
			<ActivityPickerPanel
				channelId={channelId}
				channelName={Channels.getChannel(channelId)?.name ?? ''}
				peopleCount={peopleInChannel(channelId)}
				onClose={() => ModalCommands.pop()}
				searchRef={searchRef}
				data-flx="activities.activity-picker.panel"
			/>
		</Modal.Root>
	);
});

export function openActivityPicker(channelId: string): void {
	ModalCommands.pushWithKey(
		ModalCommands.modal(() => (
			<ActivityPickerModal channelId={channelId} data-flx="activities.activity-picker.open.modal" />
		)),
		PICKER_MODAL_KEY,
	);
}
