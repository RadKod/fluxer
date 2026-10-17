// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/band/components/BandPlaceholderView.module.css';
import type {ActivityViewProps} from '@app/features/activities/registry/ActivityDefinition';
import type {ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';
import {Button} from '@app/features/ui/button/Button';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const PARTICIPANTS_DESCRIPTOR = msg({
	message: 'In this session',
	comment: 'Band game test screen: heading over the list of people in the voice channel taking part.',
});
const LEADER_DESCRIPTOR = msg({
	message: 'Leader',
	comment: 'Band game test screen: tag next to the person whose game state everyone follows.',
});
const YOU_DESCRIPTOR = msg({
	message: 'You',
	context: 'activity-participant-self',
	comment: 'Band game test screen: tag next to my own entry in the participant list.',
});
const CLOCK_DESCRIPTOR = msg({
	message: 'Clock offset to the leader: {offset} ms (round trip {rtt} ms)',
	comment:
		'Band game test screen: how far my clock is from the leader clock, in milliseconds. {offset} and {rtt} are numbers.',
});
const CLOCK_PENDING_DESCRIPTOR = msg({
	message: 'Measuring the clock offset to the leader...',
	comment: 'Band game test screen: shown until the first clock measurement against the leader finishes.',
});
const PING_DESCRIPTOR = msg({
	message: 'Ping everyone',
	comment: 'Band game test screen: button that sends a test message to everyone in the session.',
});
const RECEIVED_DESCRIPTOR = msg({
	message: '{name} pinged ({delay} ms on the way)',
	comment:
		'Band game test screen: one received test message. {name} is the sender, {delay} the travel time in milliseconds measured on the shared clock.',
});

const MAX_LOG_ENTRIES = 8;

interface PingEntry {
	readonly key: string;
	readonly from: ActivityParticipant;
	readonly delayMs: number;
}

function readSentAt(payload: unknown): number | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const sentAt = (payload as {sentAt?: unknown}).sentAt;
	return typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : null;
}

function displayName(participant: ActivityParticipant): string {
	const user = Users.getUser(participant.userId);
	if (!user) return participant.userId;
	return NicknameUtils.getNickname(user, MediaEngine.guildId, MediaEngine.channelId ?? undefined);
}

// Stand-in until the game lands: shows what the framework gives an activity, so it can be tried with friends.
export const BandPlaceholderView = observer(function BandPlaceholderView({session}: ActivityViewProps) {
	const {i18n} = useLingui();
	const [pings, setPings] = useState<ReadonlyArray<PingEntry>>([]);
	useEffect(
		() =>
			session.onMessage(({from, seq, payload}) => {
				const sentAt = readSentAt(payload);
				if (sentAt === null) return;
				const entry = {key: `${from.identity}:${seq}`, from, delayMs: Math.round(session.clock.now() - sentAt)};
				setPings((previous) => [entry, ...previous].slice(0, MAX_LOG_ENTRIES));
			}),
		[session],
	);
	const {clock} = session;
	return (
		<div className={styles.root} data-flx="activities.band.band-placeholder-view.root">
			<h3 className={styles.heading} data-flx="activities.band.band-placeholder-view.heading">
				{i18n._(PARTICIPANTS_DESCRIPTOR)}
			</h3>
			<ul className={styles.participants} data-flx="activities.band.band-placeholder-view.participants">
				{session.participants.map((participant) => (
					<li
						key={participant.identity}
						className={styles.participant}
						data-flx="activities.band.band-placeholder-view.participant"
					>
						<span className={styles.name} data-flx="activities.band.band-placeholder-view.name">
							{displayName(participant)}
						</span>
						{participant.identity === session.leader?.identity && (
							<span className={styles.tag} data-flx="activities.band.band-placeholder-view.tag">
								{i18n._(LEADER_DESCRIPTOR)}
							</span>
						)}
						{participant.isLocal && (
							<span className={styles.tag} data-flx="activities.band.band-placeholder-view.tag--2">
								{i18n._(YOU_DESCRIPTOR)}
							</span>
						)}
					</li>
				))}
			</ul>
			<p className={styles.clock} data-flx="activities.band.band-placeholder-view.clock">
				{clock.synced && clock.rttMs !== null
					? i18n._(CLOCK_DESCRIPTOR, {offset: Math.round(clock.offsetMs), rtt: Math.round(clock.rttMs)})
					: i18n._(CLOCK_PENDING_DESCRIPTOR)}
			</p>
			<div data-flx="activities.band.band-placeholder-view.div">
				<Button
					small
					onClick={() => void session.send({sentAt: session.clock.now()})}
					data-flx="activities.band.band-placeholder-view.button"
				>
					{i18n._(PING_DESCRIPTOR)}
				</Button>
			</div>
			{pings.length > 0 && (
				<ul className={styles.log} data-flx="activities.band.band-placeholder-view.log">
					{pings.map((ping) => (
						<li key={ping.key} data-flx="activities.band.band-placeholder-view.li">
							{i18n._(RECEIVED_DESCRIPTOR, {name: displayName(ping.from), delay: ping.delayMs})}
						</li>
					))}
				</ul>
			)}
		</div>
	);
});
