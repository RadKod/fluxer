// SPDX-License-Identifier: AGPL-3.0-or-later

import {getCachedNumberFormat} from '@app/features/i18n/utils/IntlCache';
import {ChannelSelect, IdsSelect, M, RoleSelect, Toggle} from '@app/features/micupbot/components/MicupBotControls';
import styles from '@app/features/micupbot/components/MicupBotTab.module.css';
import Settings from '@app/features/micupbot/state/MicupBotSettings';
import Permission from '@app/features/permissions/state/Permission';
import {Button} from '@app/features/ui/button/Button';
import {Input, Textarea} from '@app/features/ui/components/form/FormInput';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MICUPBOT_LIMITS} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

export const MicupBotLevels = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const [draft, setDraft] = useState(() => ({...Settings.data!.settings}));
	const [rewards, setRewards] = useState(() => Settings.rewards!.rewards.map((reward) => ({...reward})));
	return (
		<div className={styles.fields} data-flx="micupbot.micup-bot-levels.fields">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void Settings.updateSettings(draft);
				}}
				data-flx="micupbot.micup-bot-levels.form.prevent-default"
			>
				<fieldset className={styles.fields} disabled={Settings.saving} data-flx="micupbot.micup-bot-levels.fields--2">
					<Toggle
						label={M.levels}
						value={draft.levels_enabled}
						onChange={(levels_enabled) => setDraft({...draft, levels_enabled})}
						data-flx="micupbot.micup-bot-levels.toggle.set-draft"
					/>
					<Toggle
						label={msg({
							message: 'Level-up messages',
							comment: 'Send a message when a community member gains a level.',
						})}
						value={draft.level_up_message_enabled}
						onChange={(level_up_message_enabled) => setDraft({...draft, level_up_message_enabled})}
						data-flx="micupbot.micup-bot-levels.toggle.set-draft--2"
					/>
					<ChannelSelect
						guildId={guildId}
						same
						value={draft.level_up_channel_id}
						onChange={(level_up_channel_id) => setDraft({...draft, level_up_channel_id})}
						data-flx="micupbot.micup-bot-levels.channel-select.set-draft"
					/>
					<Textarea
						label={i18n._(M.message)}
						maxLength={MICUPBOT_LIMITS.templateMax}
						value={draft.level_up_message ?? ''}
						placeholder={Settings.data!.default_messages.level_up}
						onChange={(event) => setDraft({...draft, level_up_message: event.target.value || null})}
						data-flx="micupbot.micup-bot-levels.textarea.set-draft"
					/>
					<p className={styles.muted} data-flx="micupbot.micup-bot-levels.muted">
						{i18n._(
							msg({
								message: 'Variables: {variables}',
								comment: 'Supported community bot template tokens; variables must not be translated.',
							}),
							{variables: '{user} {user.name} {user.id} {server} {server.members} {level}'},
						)}
					</p>
					<IdsSelect
						guildId={guildId}
						kind="channels"
						label={msg({
							message: 'Channels without XP',
							comment: 'Community bot does not award experience in these channels.',
						})}
						value={draft.no_xp_channel_ids}
						max={MICUPBOT_LIMITS.noXpChannelsMax}
						onChange={(no_xp_channel_ids) => setDraft({...draft, no_xp_channel_ids})}
						data-flx="micupbot.micup-bot-levels.ids-select.set-draft"
					/>
					<IdsSelect
						guildId={guildId}
						kind="roles"
						label={msg({
							message: 'Roles without XP',
							comment: 'Members with any of these roles do not gain experience.',
						})}
						value={draft.no_xp_role_ids}
						max={MICUPBOT_LIMITS.noXpRolesMax}
						onChange={(no_xp_role_ids) => setDraft({...draft, no_xp_role_ids})}
						data-flx="micupbot.micup-bot-levels.ids-select.set-draft--2"
					/>
					<Toggle
						label={msg({message: 'Voice XP', comment: 'Award experience for eligible voice participation.'})}
						value={draft.voice_xp_enabled}
						onChange={(voice_xp_enabled) => setDraft({...draft, voice_xp_enabled})}
						data-flx="micupbot.micup-bot-levels.toggle.set-draft--3"
					/>
					<Button type="submit" submitting={Settings.saving} data-flx="micupbot.micup-bot-levels.button.submit">
						{i18n._(M.save)}
					</Button>
				</fieldset>
			</form>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void Settings.updateRewards({rewards});
				}}
				data-flx="micupbot.micup-bot-levels.form.prevent-default--2"
			>
				<fieldset
					className={styles.card}
					disabled={Settings.saving || !Permission.can(Permissions.MANAGE_ROLES, {guildId})}
					data-flx="micupbot.micup-bot-levels.card"
				>
					<legend className={styles.heading} data-flx="micupbot.micup-bot-levels.legend">
						{i18n._(
							msg({message: 'Level rewards', comment: 'Roles cumulatively awarded at configured experience levels.'}),
						)}
					</legend>
					{rewards.map((reward, index) => (
						<div key={index} className={styles.card} data-flx="micupbot.micup-bot-levels.card--2">
							<Input
								type="number"
								required
								min={1}
								max={MICUPBOT_LIMITS.levelMax}
								step={1}
								label={i18n._(
									msg({message: 'Level', comment: 'Required level for a community bot role reward, from 1 to 500.'}),
								)}
								value={reward.level}
								onChange={(event) =>
									setRewards(
										rewards.map((item, i) => (i === index ? {...item, level: Number(event.target.value)} : item)),
									)
								}
								data-flx="micupbot.micup-bot-levels.input.set-rewards.number"
							/>
							<RoleSelect
								guildId={guildId}
								value={reward.role_id}
								onChange={(role_id) => setRewards(rewards.map((item, i) => (i === index ? {...item, role_id} : item)))}
								data-flx="micupbot.micup-bot-levels.role-select.set-rewards"
							/>
							<Button
								variant="secondary"
								onClick={() => setRewards(rewards.filter((_, i) => i !== index))}
								data-flx="micupbot.micup-bot-levels.button.set-rewards"
							>
								{i18n._(M.remove)}
							</Button>
						</div>
					))}
					<Button
						variant="secondary"
						disabled={rewards.length >= Math.min(Settings.rewards!.max_rewards, MICUPBOT_LIMITS.rewardsMax)}
						onClick={() => setRewards([...rewards, {level: 1, role_id: ''}])}
						data-flx="micupbot.micup-bot-levels.button.set-rewards--2"
					>
						{i18n._(
							msg({message: 'Add reward', comment: 'Add a community bot level-to-role reward, at most twenty-five.'}),
						)}
					</Button>
					<Button type="submit" submitting={Settings.saving} data-flx="micupbot.micup-bot-levels.button.submit--2">
						{i18n._(M.save)}
					</Button>
				</fieldset>
			</form>
			{Settings.data!.settings.levels_enabled && Settings.leaderboard?.levels_enabled && (
				<section className={styles.card} data-flx="micupbot.micup-bot-levels.card--3">
					<h3 className={styles.heading} data-flx="micupbot.micup-bot-levels.h3">
						{i18n._(
							msg({
								message: 'Leaderboard — top ten',
								comment: 'Preview of the ten highest-ranked community bot members.',
							}),
						)}
					</h3>
					<ol className={styles.list} data-flx="micupbot.micup-bot-levels.list">
						{Settings.leaderboard.entries.slice(0, 10).map((entry) => (
							<li key={entry.user_id} data-flx="micupbot.micup-bot-levels.li">
								{i18n._(
									msg({
										message: '{rank}. {name} — Level {level} · {xp} XP',
										comment: 'Community bot leaderboard row; rank is the position, xp is already number-formatted.',
									}),
									{
										rank: entry.rank,
										name: entry.user?.global_name ?? entry.user?.username ?? entry.user_id,
										level: entry.level,
										xp: getCachedNumberFormat(getCurrentLocale()).format(entry.xp),
									},
								)}
							</li>
						))}
					</ol>
				</section>
			)}
		</div>
	);
});
