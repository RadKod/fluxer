// SPDX-License-Identifier: AGPL-3.0-or-later

import {getCachedNumberFormat} from '@app/features/i18n/utils/IntlCache';
import {IdsSelect, M, Toggle} from '@app/features/micupbot/components/MicupBotControls';
import styles from '@app/features/micupbot/components/MicupBotTab.module.css';
import Settings from '@app/features/micupbot/state/MicupBotSettings';
import {getTimeoutDurationOptions} from '@app/features/moderation/components/modals/TimeoutMemberOptions';
import Permission from '@app/features/permissions/state/Permission';
import {Button} from '@app/features/ui/button/Button';
import {Combobox} from '@app/features/ui/components/form/FormCombobox';
import {Input, Textarea} from '@app/features/ui/components/form/FormInput';
import {WarningAlert} from '@app/features/ui/warning_alert/WarningAlert';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	MICUPBOT_AUTOMOD_ACTIONS,
	MICUPBOT_LIMITS,
	MICUPBOT_THRESHOLDS,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const RULES = {
	spam: msg({message: 'Spam', comment: 'Community bot rule detecting messages sent too quickly.'}),
	invites: msg({message: 'Invites', comment: 'Community bot rule blocking invitation links.'}),
	links: msg({message: 'Links', comment: 'Community bot rule blocking links outside allowed domains.'}),
	words: msg({message: 'Words', comment: 'Community bot rule detecting configured blocked words.'}),
	mentions: msg({message: 'Mass mentions', comment: 'Community bot rule detecting excessive mentions.'}),
	caps: msg({message: 'Capital letters', comment: 'Community bot rule detecting excessive capital letters.'}),
};
const ACTIONS = {
	delete: msg({
		message: 'Delete message',
		context: 'micupbot-automod-action',
		comment: 'Automod action deleting only the offending message.',
	}),
	delete_warn: msg({message: 'Delete and warn', comment: 'Automod action deleting the message and posting a warning.'}),
	delete_mute: msg({
		message: 'Delete and time out',
		comment: 'Automod action deleting the message and timing out its author.',
	}),
};
const THRESHOLDS = {
	spam: msg({
		message: 'Messages per 5 seconds',
		comment: 'Automod spam threshold: messages one member may send within five seconds.',
	}),
	mentions: msg({message: 'Mentions per message', comment: 'Automod threshold: mentions allowed in one message.'}),
	caps: msg({
		message: 'Capital letters (%)',
		comment: 'Automod threshold: percentage of capital letters in a message.',
	}),
};
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A saved duration outside Fluxer's timeout choices uses its largest whole unit (ScheduledMaintenanceNagbar pattern).
function durationLabel(seconds: number): string {
	const [value, unit] =
		seconds % DAY === 0
			? ([seconds / DAY, 'day'] as const)
			: seconds % HOUR === 0
				? ([seconds / HOUR, 'hour'] as const)
				: ([seconds / MINUTE, 'minute'] as const);
	return getCachedNumberFormat(getCurrentLocale(), {
		style: 'unit',
		unit,
		unitDisplay: 'long',
		maximumFractionDigits: 1,
	}).format(value);
}

export const MicupBotAutomod = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const [rules, setRules] = useState(() => Settings.automod!.rules.map((rule) => ({...rule})));
	const [submitted, setSubmitted] = useState(false);
	const canModerate = Permission.can(Permissions.MODERATE_MEMBERS, {guildId});
	const canManageMessages = Permission.can(Permissions.MANAGE_MESSAGES, {guildId});
	const durations = getTimeoutDurationOptions(i18n);
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				setSubmitted(true);
				void Settings.updateAutomod({rules});
			}}
			data-flx="micupbot.micup-bot-automod.form.prevent-default"
		>
			<fieldset
				className={styles.fields}
				disabled={Settings.saving || !canManageMessages}
				data-flx="micupbot.micup-bot-automod.fields"
			>
				{rules.map((rule, index) => {
					const threshold =
						rule.rule === 'spam' || rule.rule === 'mentions' || rule.rule === 'caps'
							? MICUPBOT_THRESHOLDS[rule.rule]
							: null;
					const change = (patch: Partial<typeof rule>) =>
						setRules(rules.map((item, i) => (i === index ? {...item, ...patch} : item)));
					return (
						<section key={rule.rule} className={styles.card} data-flx="micupbot.micup-bot-automod.card">
							<h3 className={styles.heading} data-flx="micupbot.micup-bot-automod.h3">
								{i18n._(RULES[rule.rule])}
							</h3>
							<Toggle
								label={M.enabled}
								value={rule.enabled}
								disabled={Settings.saving || !canManageMessages}
								onChange={(enabled) => change({enabled})}
								data-flx="micupbot.micup-bot-automod.toggle.change"
							/>
							<Combobox
								label={i18n._(msg({message: 'Action', comment: 'Action taken by this community bot automod rule.'}))}
								value={rule.action}
								onChange={(action) => change({action})}
								options={MICUPBOT_AUTOMOD_ACTIONS.map((value) => ({
									value,
									label: i18n._(ACTIONS[value]),
									isDisabled: value === 'delete_mute' && !canModerate,
								}))}
								data-flx="micupbot.micup-bot-automod.combobox.change"
							/>
							{threshold && (
								<Input
									type="number"
									required
									min={threshold.min}
									max={threshold.max}
									step={1}
									label={i18n._(THRESHOLDS[rule.rule as keyof typeof THRESHOLDS])}
									value={rule.threshold}
									onChange={(event) => change({threshold: Number(event.target.value)})}
									data-flx="micupbot.micup-bot-automod.input.change.number"
								/>
							)}
							{rule.action === 'delete_mute' && (
								<Combobox<number>
									disabled={!canModerate || !canManageMessages}
									label={i18n._(
										msg({
											message: 'Timeout duration',
											comment: 'Automod timeout duration; the same choices as the member timeout dialog.',
										}),
									)}
									value={rule.mute_seconds}
									onChange={(mute_seconds) => change({mute_seconds})}
									options={[
										...durations,
										...(durations.some((option) => option.value === rule.mute_seconds)
											? []
											: [{value: rule.mute_seconds, label: durationLabel(rule.mute_seconds)}]),
									]}
									data-flx="micupbot.micup-bot-automod.combobox.change--2"
								/>
							)}
							{rule.rule === 'words' && (
								<Textarea
									label={i18n._(
										msg({
											message: 'Blocked words — one per line (3–64 characters, up to 200)',
											comment: 'Community bot blocked-word list and its shared schema limits.',
										}),
									)}
									footer={
										<p className={styles.muted} data-flx="micupbot.micup-bot-automod.words-hint">
											{i18n._(
												msg({
													message:
														'A word only matches on its own. Add * to widen it: word* also catches words that start with it, *word* catches it anywhere.',
													comment:
														'Community bot blocked-word list hint explaining whole-word matching and * wildcards. Translate the example word but keep each * where it is.',
												}),
											)}
										</p>
									}
									defaultValue={rule.words.join('\n')}
									maxLength={(MICUPBOT_LIMITS.wordMax + 1) * MICUPBOT_LIMITS.wordsMax}
									onChange={(event) =>
										change({
											words: event.target.value
												.split('\n')
												.map((word) => word.trim())
												.filter(Boolean),
										})
									}
									data-flx="micupbot.micup-bot-automod.textarea.change"
								/>
							)}
							{rule.rule === 'links' && (
								<Textarea
									label={i18n._(
										msg({
											message: 'Allowed domains — one per line (up to 50)',
											comment: 'Community bot allowed domain list for the link rule.',
										}),
									)}
									defaultValue={rule.allowed_domains.join('\n')}
									maxLength={254 * MICUPBOT_LIMITS.domainsMax}
									onChange={(event) =>
										change({
											allowed_domains: event.target.value
												.split('\n')
												.map((domain) => domain.trim())
												.filter(Boolean),
										})
									}
									data-flx="micupbot.micup-bot-automod.textarea.change--2"
								/>
							)}
							<IdsSelect
								guildId={guildId}
								kind="roles"
								label={msg({message: 'Exempt roles', comment: 'Roles exempt from this community bot automod rule.'})}
								value={rule.exempt_role_ids}
								max={MICUPBOT_LIMITS.exemptMax}
								onChange={(exempt_role_ids) => change({exempt_role_ids})}
								data-flx="micupbot.micup-bot-automod.ids-select.change"
							/>
							<IdsSelect
								guildId={guildId}
								kind="channels"
								label={msg({
									message: 'Exempt channels',
									comment: 'Channels exempt from this community bot automod rule.',
								})}
								value={rule.exempt_channel_ids}
								max={MICUPBOT_LIMITS.exemptMax}
								onChange={(exempt_channel_ids) => change({exempt_channel_ids})}
								data-flx="micupbot.micup-bot-automod.ids-select.change--2"
							/>
						</section>
					);
				})}
				{!canModerate && rules.some((rule) => rule.enabled && rule.action === 'delete_mute') && (
					<WarningAlert data-flx="micupbot.micup-bot-automod.timeout-warning">
						{i18n._(
							msg({
								message:
									'Saving an active timeout rule needs the “Time out members” permission; turn the rule off or choose another action.',
								comment:
									'Shown above Save when an enabled automod rule times members out but the user lacks the Time out members permission (use that permission name).',
							}),
						)}
					</WarningAlert>
				)}
				<div className={styles.row} data-flx="micupbot.micup-bot-automod.save-row">
					<Button type="submit" submitting={Settings.saving} data-flx="micupbot.micup-bot-automod.button.submit">
						{i18n._(M.save)}
					</Button>
					{submitted && Settings.error && (
						<p className={styles.error} data-flx="micupbot.micup-bot-automod.error">
							{Settings.error}
						</p>
					)}
				</div>
			</fieldset>
		</form>
	);
});
