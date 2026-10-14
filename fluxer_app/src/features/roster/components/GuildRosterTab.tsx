// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {buildBotInviteUrl} from '@app/features/auth/utils/BotInviteUrl';
import Channels from '@app/features/channel/state/Channels';
import Guilds from '@app/features/guild/state/Guilds';
import styles from '@app/features/roster/components/GuildRosterTab.module.css';
import GuildRosterEvents from '@app/features/roster/state/GuildRosterEvents';
import {Button} from '@app/features/ui/button/Button';
import {Combobox} from '@app/features/ui/components/form/FormCombobox';
import {Input} from '@app/features/ui/components/form/FormInput';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import Modal from '@app/features/ui/state/Modal';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {
	GUILD_ROSTER_LIMITS,
	GuildRosterEventCreateRequest,
} from '@fluxer/schema/src/domains/roster/GuildRosterRequestSchemas';
import type {GuildRosterEventResponse} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {when} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type FormEvent, useEffect, useId, useRef, useState} from 'react';

const MESSAGES = {
	off: msg({
		message: 'The event bot is currently disabled.',
		comment: 'Notice when the community event bot feature is switched off.',
	}),
	unconfigured: msg({
		message: 'The bot has not been configured yet.',
		comment: 'Administrator notice when no official event bot application is configured.',
	}),
	addBot: msg({message: 'Add bot', comment: 'Button opening the official event bot OAuth invitation.'}),
	hierarchy: msg({
		message: 'Move the bot’s role above the roles of the members it will move.',
		comment: 'Setup hint under the event bot invitation.',
	}),
	schedule: msg({
		message:
			'Announcements are sent at :25 every hour. At :35, main roster members are moved to the event room; those who are not in any voice channel are removed from the roster. Substitutes stay unchanged.',
		comment: 'Explains the hourly event bot schedule and voice check.',
	}),
	add: msg({message: 'Add event', comment: 'Button creating an event bot roster configuration.'}),
	edit: msg({message: 'Edit', comment: 'Button editing an event bot roster configuration.'}),
	remove: msg({message: 'Delete', comment: 'Button deleting an event bot roster configuration after confirmation.'}),
	confirm: msg({
		message: 'Delete event “{name}”?',
		comment: 'Confirmation before deleting an event bot configuration. name is the event name.',
	}),
	cancel: msg({message: 'Cancel', comment: 'Button cancelling the event bot form or deletion confirmation.'}),
	save: msg({message: 'Save event', comment: 'Button saving the event bot settings form.'}),
	name: msg({message: 'Event name', comment: 'Label for the event bot roster name input.'}),
	voice: msg({message: 'Voice room', comment: 'Label for the voice channel the event bot moves members into.'}),
	announce: msg({message: 'Announcement channel', comment: 'Label for the text channel where the event bot posts.'}),
	role: msg({message: 'Mention role', comment: 'Optional role mentioned in event bot announcements.'}),
	none: msg({message: 'None', comment: 'No role selected for an event bot announcement.'}),
	noRole: msg({message: 'No role', comment: 'Shown in the event bot list when an event mentions no role.'}),
	deletedChannel: msg({message: 'Deleted channel', comment: 'An event bot channel that no longer exists.'}),
	deletedRole: msg({message: 'Deleted role', comment: 'An event bot mention role that no longer exists.'}),
	select: msg({
		message: 'Select a channel',
		comment: 'Empty choice in the event bot channel selectors, also the error under one left empty on save.',
	}),
	main: msg({message: 'Main roster', comment: 'Number input label for the main event roster size.'}),
	subs: msg({message: 'Substitutes', comment: 'Number input label for the event substitute roster size.'}),
	sizes: msg({message: 'Main {main} · Subs {subs}', comment: 'Event roster capacities shown in the event bot list.'}),
	enabled: msg({message: 'Enabled', comment: 'Form control label turning an event bot configuration on or off.'}),
	statusOn: msg({
		message: 'Enabled',
		context: 'event-bot-status',
		comment: 'Status in the event bot list for a configuration that is on. Pairs with the off status.',
	}),
	statusOff: msg({
		message: 'Disabled',
		context: 'event-bot-status',
		comment: 'Status in the event bot list for a configuration that is off. Pairs with the on status.',
	}),
	mentionWarning: msg({
		message: 'The bot cannot mention this role; make the role mentionable.',
		comment: 'Warning for an event announcement role that is not mentionable.',
	}),
	loading: msg({message: 'Loading event bot settings…', comment: 'Accessible loading status for the event bot tab.'}),
	retry: msg({message: 'Try again', comment: 'Reload event bot settings after a failed request.'}),
	invalid: msg({
		message: 'Check the event name, channels and roster sizes.',
		comment: 'Validation error for an incomplete or invalid event bot form.',
	}),
};

const GuildRosterTab = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const id = useId();
	const [editing, setEditing] = useState<GuildRosterEventResponse | 'new' | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [voiceChannelId, setVoiceChannelId] = useState('');
	const [announceChannelId, setAnnounceChannelId] = useState('');
	const [inviteModalKey, setInviteModalKey] = useState<string | null>(null);
	const [mentionRoleId, setMentionRoleId] = useState('');
	const [enabled, setEnabled] = useState(true);
	const [invalid, setInvalid] = useState(false);
	const [formOpens, setFormOpens] = useState(0);
	const formRef = useRef<HTMLFormElement>(null);
	useEffect(() => {
		setEditing(null);
		setDeleting(null);
		setInviteModalKey(null);
		void GuildRosterEvents.open(guildId);
		return GuildRosterEvents.close;
	}, [guildId]);
	useEffect(() => {
		if (!inviteModalKey) return;
		return when(
			() => !Modal.hasModal(inviteModalKey),
			() => {
				setInviteModalKey(null);
				void GuildRosterEvents.open(guildId);
			},
		);
	}, [guildId, inviteModalKey]);
	useEffect(() => {
		if (formOpens)
			formRef.current?.scrollIntoView({
				block: 'nearest',
				behavior: Accessibility.useSmoothScrolling ? 'smooth' : 'auto',
			});
	}, [formOpens]);
	const {data, loading, saving, error} = GuildRosterEvents;
	const editable = Boolean(data?.feature_enabled && data.bot);
	const channels = Channels.getGuildChannels(guildId);
	const voiceChannels = channels.filter((channel) => channel.type === ChannelTypes.GUILD_VOICE);
	const textChannels = channels.filter((channel) => channel.type === ChannelTypes.GUILD_TEXT);
	const roles = Guilds.getGuildRoles(guildId).filter((role) => role.id !== guildId);
	const selectedRole = roles.find((role) => role.id === mentionRoleId);
	const current = editing && editing !== 'new' ? editing : null;

	function channelName(channelId: string, prefix = ''): string {
		const name = channels.find((channel) => channel.id === channelId)?.name;
		return name == null ? i18n._(MESSAGES.deletedChannel) : prefix + name;
	}

	function edit(event: GuildRosterEventResponse | 'new'): void {
		setEditing(event);
		setFormOpens((count) => count + 1);
		setDeleting(null);
		setInvalid(false);
		setVoiceChannelId(
			event !== 'new' && voiceChannels.some((channel) => channel.id === event.voice_channel_id)
				? event.voice_channel_id
				: '',
		);
		setAnnounceChannelId(
			event !== 'new' && textChannels.some((channel) => channel.id === event.announce_channel_id)
				? event.announce_channel_id
				: '',
		);
		setMentionRoleId(
			event !== 'new' && roles.some((role) => role.id === event.mention_role_id) ? event.mention_role_id! : '',
		);
		setEnabled(event === 'new' || event.enabled);
	}

	async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (saving || !editing || !editable) return;
		if (!event.currentTarget.checkValidity()) {
			setInvalid(true);
			return;
		}
		const form = new FormData(event.currentTarget);
		const draft = {
			name: String(form.get('name') ?? '').trim(),
			voice_channel_id: voiceChannelId,
			announce_channel_id: announceChannelId,
			mention_role_id: mentionRoleId || null,
			main_size: Number(form.get('main_size')),
			sub_size: Number(form.get('sub_size')),
			enabled,
		};
		if (
			!GuildRosterEventCreateRequest.safeParse(draft).success ||
			!voiceChannels.some((channel) => channel.id === draft.voice_channel_id) ||
			!textChannels.some((channel) => channel.id === draft.announce_channel_id) ||
			(mentionRoleId && !selectedRole)
		) {
			setInvalid(true);
			return;
		}
		setInvalid(false);
		const saved = current ? await GuildRosterEvents.update(current.id, draft) : await GuildRosterEvents.create(draft);
		if (saved) setEditing(null);
	}

	if (loading || GuildRosterEvents.guildId !== guildId)
		return (
			<p role="status" data-flx="roster.guild-roster-tab.loading">
				{i18n._(MESSAGES.loading)}
			</p>
		);
	return (
		<div className={styles.container} data-flx="roster.guild-roster-tab.container">
			{error && (
				<p role="alert" className={styles.error} data-flx="roster.guild-roster-tab.error">
					{error}
				</p>
			)}
			{!data ? (
				<Button onClick={() => void GuildRosterEvents.open(guildId)} data-flx="roster.guild-roster-tab.retry">
					{i18n._(MESSAGES.retry)}
				</Button>
			) : (
				<>
					{!data.bot ? (
						<p data-flx="roster.guild-roster-tab.unconfigured">{i18n._(MESSAGES.unconfigured)}</p>
					) : !data.feature_enabled ? (
						<p data-flx="roster.guild-roster-tab.off">{i18n._(MESSAGES.off)}</p>
					) : null}
					{editable && data.bot && !data.bot.in_guild && (
						<section className={styles.card} data-flx="roster.guild-roster-tab.invite">
							<Button
								onClick={async () => {
									const {openOAuthAuthorizeModalFromUrl} = await import(
										'@app/features/auth/commands/OAuthAuthorizeModalCommands'
									);
									const url = buildBotInviteUrl({
										applicationId: data.bot!.application_id,
										guildId,
										permissions: data.invite_permissions,
									});
									if (openOAuthAuthorizeModalFromUrl(url)) setInviteModalKey(`oauth-authorize:${new URL(url).search}`);
								}}
								data-flx="roster.guild-roster-tab.add-bot"
							>
								{i18n._(MESSAGES.addBot)}
							</Button>
							<p className={styles.muted} data-flx="roster.guild-roster-tab.hierarchy">
								{i18n._(MESSAGES.hierarchy)}
							</p>
						</section>
					)}
					{editable && (
						<p className={styles.muted} data-flx="roster.guild-roster-tab.schedule">
							{i18n._(MESSAGES.schedule)}
						</p>
					)}
					<ul className={styles.list} data-flx="roster.guild-roster-tab.events">
						{data.events.map((entry) => (
							<li key={entry.id} className={styles.card} data-flx="roster.guild-roster-tab.event">
								<h3 className={styles.name} data-flx="roster.guild-roster-tab.event-name">
									{entry.name}
								</h3>
								<p className={styles.muted} data-flx="roster.guild-roster-tab.details">
									{[
										channelName(entry.voice_channel_id),
										channelName(entry.announce_channel_id, '#'),
										entry.mention_role_id
											? (roles.find((role) => role.id === entry.mention_role_id)?.name ?? i18n._(MESSAGES.deletedRole))
											: i18n._(MESSAGES.noRole),
									].join(' · ')}
								</p>
								<p className={styles.muted} data-flx="roster.guild-roster-tab.sizes">
									{i18n._(MESSAGES.sizes, {main: entry.main_size, subs: entry.sub_size})} ·{' '}
									{i18n._(entry.enabled ? MESSAGES.statusOn : MESSAGES.statusOff)}
								</p>
								{editable &&
									(deleting === entry.id ? (
										<div className={styles.actions} data-flx="roster.guild-roster-tab.confirm">
											<p role="alert" data-flx="roster.guild-roster-tab.confirm-text">
												{i18n._(MESSAGES.confirm, {name: entry.name})}
											</p>
											<Button
												variant="danger"
												disabled={saving}
												onClick={async () => {
													if (await GuildRosterEvents.remove(entry.id)) setDeleting(null);
												}}
												data-flx="roster.guild-roster-tab.confirm-delete"
											>
												{i18n._(MESSAGES.remove)}
											</Button>
											<Button
												variant="secondary"
												disabled={saving}
												onClick={() => setDeleting(null)}
												data-flx="roster.guild-roster-tab.cancel-delete"
											>
												{i18n._(MESSAGES.cancel)}
											</Button>
										</div>
									) : (
										<div className={styles.actions} data-flx="roster.guild-roster-tab.actions">
											<Button
												small
												variant="secondary"
												disabled={saving}
												onClick={() => edit(entry)}
												data-flx="roster.guild-roster-tab.edit"
											>
												{i18n._(MESSAGES.edit)}
											</Button>
											<Button
												small
												variant="secondary"
												disabled={saving}
												onClick={() => {
													setEditing(null);
													setDeleting(entry.id);
												}}
												data-flx="roster.guild-roster-tab.delete"
											>
												{i18n._(MESSAGES.remove)}
											</Button>
										</div>
									))}
							</li>
						))}
					</ul>
					{editable && (
						<div className={styles.actions} data-flx="roster.guild-roster-tab.add-row">
							<Button
								disabled={saving || data.events.length >= data.max_events}
								onClick={() => edit('new')}
								data-flx="roster.guild-roster-tab.add"
							>
								{i18n._(MESSAGES.add)}
							</Button>
							<span className={styles.muted} data-flx="roster.guild-roster-tab.count">
								{data.events.length}/{data.max_events}
							</span>
						</div>
					)}
					{editable && editing && (
						<form
							key={`${current?.id ?? 'new'}-${formOpens}`}
							ref={formRef}
							className={styles.card}
							onSubmit={save}
							data-flx="roster.guild-roster-tab.form"
						>
							<fieldset disabled={saving} className={styles.fields} data-flx="roster.guild-roster-tab.fields">
								<Input
									name="name"
									label={i18n._(MESSAGES.name)}
									defaultValue={current?.name ?? ''}
									minLength={1}
									maxLength={GUILD_ROSTER_LIMITS.nameMax}
									required
									autoFocus
									data-flx="roster.guild-roster-tab.name-input"
								/>
								<Combobox
									id={`${id}-voice`}
									label={i18n._(MESSAGES.voice)}
									value={voiceChannelId}
									onChange={setVoiceChannelId}
									disabled={saving}
									error={
										invalid && !voiceChannels.some((channel) => channel.id === voiceChannelId)
											? i18n._(MESSAGES.select)
											: undefined
									}
									options={[
										{value: '', label: i18n._(MESSAGES.select)},
										...voiceChannels.map((channel) => ({value: channel.id, label: channel.name ?? ''})),
									]}
									data-flx="roster.guild-roster-tab.voice-select"
								/>
								<Combobox
									id={`${id}-announce`}
									label={i18n._(MESSAGES.announce)}
									value={announceChannelId}
									onChange={setAnnounceChannelId}
									disabled={saving}
									error={
										invalid && !textChannels.some((channel) => channel.id === announceChannelId)
											? i18n._(MESSAGES.select)
											: undefined
									}
									options={[
										{value: '', label: i18n._(MESSAGES.select)},
										...textChannels.map((channel) => ({value: channel.id, label: channel.name ?? ''})),
									]}
									data-flx="roster.guild-roster-tab.announce-select"
								/>
								<Combobox
									id={`${id}-role`}
									label={i18n._(MESSAGES.role)}
									value={mentionRoleId}
									onChange={setMentionRoleId}
									disabled={saving}
									options={[
										{value: '', label: i18n._(MESSAGES.none)},
										...roles.map((role) => ({value: role.id, label: role.name})),
									]}
									data-flx="roster.guild-roster-tab.role-select"
								/>
								{selectedRole && !selectedRole.mentionable && (
									<p
										id={`${id}-warning`}
										role="status"
										className={styles.warning}
										data-flx="roster.guild-roster-tab.role-warning"
									>
										{i18n._(MESSAGES.mentionWarning)}
									</p>
								)}
								<div className={styles.sizes} data-flx="roster.guild-roster-tab.size-inputs">
									<Input
										type="number"
										name="main_size"
										label={i18n._(MESSAGES.main)}
										min={GUILD_ROSTER_LIMITS.mainMin}
										max={GUILD_ROSTER_LIMITS.mainMax}
										step={1}
										defaultValue={current?.main_size ?? GUILD_ROSTER_LIMITS.mainDefault}
										required
										data-flx="roster.guild-roster-tab.main-input"
									/>
									<Input
										type="number"
										name="sub_size"
										label={i18n._(MESSAGES.subs)}
										min={GUILD_ROSTER_LIMITS.subMin}
										max={GUILD_ROSTER_LIMITS.subMax}
										step={1}
										defaultValue={current?.sub_size ?? GUILD_ROSTER_LIMITS.subDefault}
										required
										data-flx="roster.guild-roster-tab.sub-input"
									/>
								</div>
								<Switch
									label={i18n._(MESSAGES.enabled)}
									value={enabled}
									onChange={setEnabled}
									disabled={saving}
									data-flx="roster.guild-roster-tab.enabled-switch"
								/>
								{invalid && (
									<p role="alert" className={styles.error} data-flx="roster.guild-roster-tab.invalid">
										{i18n._(MESSAGES.invalid)}
									</p>
								)}
								<div className={styles.actions} data-flx="roster.guild-roster-tab.form-actions">
									<Button type="submit" submitting={saving} data-flx="roster.guild-roster-tab.save">
										{i18n._(MESSAGES.save)}
									</Button>
									<Button
										variant="secondary"
										onClick={() => setEditing(null)}
										data-flx="roster.guild-roster-tab.cancel"
									>
										{i18n._(MESSAGES.cancel)}
									</Button>
								</div>
							</fieldset>
						</form>
					)}
				</>
			)}
		</div>
	);
});

export default GuildRosterTab;
