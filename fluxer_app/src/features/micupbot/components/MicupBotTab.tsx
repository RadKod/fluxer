// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildBotInviteUrl} from '@app/features/auth/utils/BotInviteUrl';
import Guilds from '@app/features/guild/state/Guilds';
import {MicupBotAutomod} from '@app/features/micupbot/components/MicupBotAutomod';
import {M, Toggle} from '@app/features/micupbot/components/MicupBotControls';
import {MicupBotLevels} from '@app/features/micupbot/components/MicupBotLevels';
import {MicupBotRoles} from '@app/features/micupbot/components/MicupBotRoles';
import styles from '@app/features/micupbot/components/MicupBotTab.module.css';
import {MicupBotWarnings} from '@app/features/micupbot/components/MicupBotWarnings';
import {MicupBotWelcome} from '@app/features/micupbot/components/MicupBotWelcome';
import Settings from '@app/features/micupbot/state/MicupBotSettings';
import Permission from '@app/features/permissions/state/Permission';
import {Button} from '@app/features/ui/button/Button';
import Modal from '@app/features/ui/state/Modal';
import {WarningAlert} from '@app/features/ui/warning_alert/WarningAlert';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {when} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const LABEL = msg({
	message: 'Community bot',
	context: 'community-settings-tab',
	comment: 'Community settings tab for the official welcome, roles, levels and moderation bot.',
});
const COMMANDS = [
	msg({
		message: '#ban @member|id [duration] [reason] — Ban a member',
		comment: 'Community bot help. Keep command names and # unchanged; translate arguments and description.',
	}),
	msg({message: '#unban id — Unban a user', comment: 'Community bot help. Keep #unban unchanged.'}),
	msg({message: '#kick @member [reason] — Remove a member', comment: 'Community bot help. Keep #kick unchanged.'}),
	msg({
		message: '#mute / #timeout @member <duration> [reason] — Time out a member',
		comment: 'Community bot help. Keep #mute and #timeout unchanged.',
	}),
	msg({message: '#unmute @member — Remove a timeout', comment: 'Community bot help. Keep #unmute unchanged.'}),
	msg({message: '#warn @member <reason> — Warn a member', comment: 'Community bot help. Keep #warn unchanged.'}),
	msg({message: '#warnings @member — Show warnings', comment: 'Community bot help. Keep #warnings unchanged.'}),
	msg({message: '#clear <1-100> [@member] — Delete messages', comment: 'Community bot help. Keep #clear unchanged.'}),
	msg({message: '#lock [#channel] — Lock a channel', comment: 'Community bot help. Keep #lock unchanged.'}),
	msg({message: '#unlock [#channel] — Unlock a channel', comment: 'Community bot help. Keep #unlock unchanged.'}),
	msg({
		message: '#slowmode <seconds|off|0> [#channel] — Set slowmode',
		comment: 'Community bot help. Keep #slowmode and off unchanged.',
	}),
	msg({message: '#role @member <@role|id|name> — Toggle a role', comment: 'Community bot help. Keep #role unchanged.'}),
	msg({
		message: '#nick @member [new name] — Set or reset a nickname',
		comment: 'Community bot help. Keep #nick unchanged.',
	}),
	msg({message: '#move @member <#voice|id> — Move a member', comment: 'Community bot help. Keep #move unchanged.'}),
	msg({message: '#user [@member] — Show member information', comment: 'Community bot help. Keep #user unchanged.'}),
	msg({message: '#server — Show community information', comment: 'Community bot help. Keep #server unchanged.'}),
	msg({message: '#avatar [@member] — Show an avatar', comment: 'Community bot help. Keep #avatar unchanged.'}),
	msg({message: '#rank [@member] — Show level and rank', comment: 'Community bot help. Keep #rank unchanged.'}),
	msg({message: '#top — Show the top ten members', comment: 'Community bot help. Keep #top unchanged.'}),
	msg({message: '#help — Show commands', comment: 'Community bot help. Keep #help unchanged.'}),
];

const MicupBotTab = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const [tab, setTab] = useState('general');
	const [inviteKey, setInviteKey] = useState<string | null>(null);
	const canManage = Permission.can(Permissions.MANAGE_GUILD, {guildId});
	const canModerate = Permission.can(Permissions.MODERATE_MEMBERS, {guildId});
	useEffect(() => {
		setTab('general');
		setInviteKey(null);
		if (canManage) void Settings.open(guildId);
		else Settings.close();
		return Settings.close;
	}, [guildId, canManage]);
	useEffect(() => {
		if (!canModerate) {
			Settings.clearWarningSelection();
			setTab((value) => (value === 'warnings' ? 'general' : value));
		}
	}, [canModerate]);
	useEffect(() => {
		if (!inviteKey) return;
		return when(
			() => !Modal.hasModal(inviteKey),
			() => {
				setInviteKey(null);
				void Settings.open(guildId);
			},
		);
	}, [guildId, inviteKey]);
	if (!canManage) return null;
	if (Settings.loading || Settings.guildId !== guildId)
		return (
			<p role="status" data-flx="micupbot.micup-bot-tab.status">
				{i18n._(M.loading)}
			</p>
		);
	const {data, error, saving} = Settings;
	const tabs = ['general', 'welcome', 'roles', 'levels', 'automod', ...(canModerate ? ['warnings'] : [])] as const;
	return (
		<div className={styles.container} data-flx="micupbot.micup-bot-tab.container">
			{Settings.applicationName && (
				<h2 className={styles.title} data-flx="micupbot.micup-bot-tab.h2">
					{Settings.applicationName}
				</h2>
			)}
			{error && (
				<p role="alert" className={styles.error} data-flx="micupbot.micup-bot-tab.error">
					{error}
				</p>
			)}
			{!data ? (
				<Button onClick={() => void Settings.open(guildId)} data-flx="micupbot.micup-bot-tab.button">
					{i18n._(M.retry)}
				</Button>
			) : !data.feature_enabled ? (
				<p data-flx="micupbot.micup-bot-tab.p">
					{i18n._(
						msg({
							message: 'The community bot is turned off.',
							comment: 'The instance-wide community bot feature is disabled.',
						}),
					)}
				</p>
			) : !data.bot ? (
				<p data-flx="micupbot.micup-bot-tab.p--2">
					{i18n._(
						msg({
							message: 'The bot is not set up yet.',
							comment: 'No official community bot application is configured.',
						}),
					)}
				</p>
			) : (
				<>
					<nav className={styles.tabs} aria-label={i18n._(LABEL)} data-flx="micupbot.micup-bot-tab.tabs">
						{tabs.map((key) => (
							<Button
								key={key}
								small
								variant={tab === key ? 'primary' : 'secondary'}
								aria-pressed={tab === key}
								onClick={() => setTab(key)}
								data-flx="micupbot.micup-bot-tab.button.set-tab"
							>
								{i18n._(M[key as keyof typeof M])}
							</Button>
						))}
					</nav>
					{tab === 'general' && (
						<section className={styles.fields} data-flx="micupbot.micup-bot-tab.fields">
							{!data.bot.in_guild && (
								<div className={styles.card} data-flx="micupbot.micup-bot-tab.card">
									<p data-flx="micupbot.micup-bot-tab.not-in-guild">
										{i18n._(
											msg({
												message: '{name} is not in this community.',
												comment:
													'The official community bot has not been added yet; name is its public application name.',
											}),
											{name: Settings.applicationName || i18n._(LABEL)},
										)}
									</p>
									<Button
										onClick={async () => {
											const {openOAuthAuthorizeModalFromUrl} = await import(
												'@app/features/auth/commands/OAuthAuthorizeModalCommands'
											);
											const url = buildBotInviteUrl({
												applicationId: data.bot!.application_id,
												permissions: data.invite_permissions,
												guildId,
											});
											if (openOAuthAuthorizeModalFromUrl(url)) setInviteKey(`oauth-authorize:${new URL(url).search}`);
										}}
										data-flx="micupbot.micup-bot-tab.button--2"
									>
										{i18n._(msg({message: 'Add bot', comment: 'Open the official community bot OAuth invitation.'}))}
									</Button>
									<p className={styles.muted} data-flx="micupbot.micup-bot-tab.p--3">
										{i18n._(
											msg({
												message: "Move the bot's role above the roles it should give.",
												comment: 'Setup hint for role hierarchy after adding the community bot.',
											}),
										)}
									</p>
								</div>
							)}
							{data.bot.mfa_blocked && (
								<WarningAlert data-flx="micupbot.micup-bot-tab.mfa-warning">
									{i18n._(
										msg({
											message:
												'This community requires two-factor authentication for moderators; the bot cannot give roles, delete messages or time members out.',
											comment: 'MFA enforcement blocks elevated actions by the community bot.',
										}),
									)}
								</WarningAlert>
							)}
							{data.role_warnings.length > 0 && (
								<WarningAlert data-flx="micupbot.micup-bot-tab.role-warning">
									{i18n._(
										msg({
											message: 'The bot cannot give these roles: {roles}',
											comment: 'Role hierarchy warning; roles is a list of configured role names.',
										}),
										{
											roles: data.role_warnings
												.map(
													(id) =>
														Guilds.getGuildRoles(guildId).find((role) => role.id === id)?.name ??
														i18n._(M.deletedRole, {id}),
												)
												.join(', '),
										},
									)}
								</WarningAlert>
							)}
							{(['commands', 'levels', 'automod'] as const).map((module) => (
								<Toggle
									key={module}
									label={M[module]}
									value={data.settings[`${module}_enabled`]}
									disabled={saving}
									onChange={(value) => void Settings.updateSettings({[`${module}_enabled`]: value})}
									data-flx="micupbot.micup-bot-tab.toggle"
								/>
							))}
							<ul className={styles.list} data-flx="micupbot.micup-bot-tab.list">
								{COMMANDS.map((command, index) => (
									<li key={index} data-flx="micupbot.micup-bot-tab.li">
										{i18n._(command)}
									</li>
								))}
							</ul>
						</section>
					)}
					{tab === 'welcome' && (
						<MicupBotWelcome key={guildId} guildId={guildId} data-flx="micupbot.micup-bot-tab.micup-bot-welcome" />
					)}
					{tab === 'roles' && (
						<MicupBotRoles key={guildId} guildId={guildId} data-flx="micupbot.micup-bot-tab.micup-bot-roles" />
					)}
					{tab === 'levels' && (
						<MicupBotLevels key={guildId} guildId={guildId} data-flx="micupbot.micup-bot-tab.micup-bot-levels" />
					)}
					{tab === 'automod' && (
						<MicupBotAutomod key={guildId} guildId={guildId} data-flx="micupbot.micup-bot-tab.micup-bot-automod" />
					)}
					{tab === 'warnings' && canModerate && (
						<MicupBotWarnings key={guildId} guildId={guildId} data-flx="micupbot.micup-bot-tab.micup-bot-warnings" />
					)}
				</>
			)}
		</div>
	);
});

export default MicupBotTab;
