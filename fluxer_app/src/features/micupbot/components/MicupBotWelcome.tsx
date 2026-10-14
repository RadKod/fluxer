// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelSelect, IdsSelect, M, Toggle} from '@app/features/micupbot/components/MicupBotControls';
import styles from '@app/features/micupbot/components/MicupBotTab.module.css';
import Settings from '@app/features/micupbot/state/MicupBotSettings';
import Permission from '@app/features/permissions/state/Permission';
import {Button} from '@app/features/ui/button/Button';
import {Textarea} from '@app/features/ui/components/form/FormInput';
import {WarningAlert} from '@app/features/ui/warning_alert/WarningAlert';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MICUPBOT_LIMITS} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

export const MicupBotWelcome = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const [draft, setDraft] = useState(() => ({...Settings.data!.settings}));
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void Settings.updateSettings(draft);
			}}
			data-flx="micupbot.micup-bot-welcome.form.prevent-default"
		>
			<fieldset className={styles.fields} disabled={Settings.saving} data-flx="micupbot.micup-bot-welcome.fields">
				{(['welcome', 'goodbye'] as const).map((kind) => (
					<section key={kind} className={styles.card} data-flx="micupbot.micup-bot-welcome.card">
						<h3 className={styles.heading} data-flx="micupbot.micup-bot-welcome.h3">
							{i18n._(
								kind === 'welcome'
									? M.welcome
									: msg({message: 'Goodbye', comment: 'Community bot leave message settings.'}),
							)}
						</h3>
						<Toggle
							label={M.enabled}
							value={draft[`${kind}_enabled`]}
							onChange={(value) => setDraft({...draft, [`${kind}_enabled`]: value})}
							data-flx="micupbot.micup-bot-welcome.toggle.set-draft"
						/>
						<ChannelSelect
							guildId={guildId}
							value={draft[`${kind}_channel_id`]}
							onChange={(value) => setDraft({...draft, [`${kind}_channel_id`]: value})}
							data-flx="micupbot.micup-bot-welcome.channel-select.set-draft"
						/>
						{kind === 'welcome' && Settings.data!.join_notification_conflict && (
							<WarningAlert data-flx="micupbot.micup-bot-welcome.conflict">
								{i18n._(
									msg({
										message: 'The built-in join message also goes to this channel; you can turn it off in Overview.',
										comment: 'Warns that community bot welcome messages duplicate the built-in join notification.',
									}),
								)}
							</WarningAlert>
						)}
						<Textarea
							label={i18n._(M.message)}
							maxLength={MICUPBOT_LIMITS.templateMax}
							value={draft[`${kind}_message`] ?? ''}
							placeholder={Settings.data!.default_messages[kind]}
							onChange={(event) => setDraft({...draft, [`${kind}_message`]: event.target.value || null})}
							data-flx="micupbot.micup-bot-welcome.textarea.set-draft"
						/>
						<Toggle
							label={M.embed}
							value={draft[`${kind}_embed`]}
							onChange={(value) => setDraft({...draft, [`${kind}_embed`]: value})}
							data-flx="micupbot.micup-bot-welcome.toggle.set-draft--2"
						/>
					</section>
				))}
				<p className={styles.muted} data-flx="micupbot.micup-bot-welcome.muted">
					{i18n._(
						msg({
							message: 'Variables: {variables}',
							comment: 'Supported community bot template tokens; variables must not be translated.',
						}),
						{variables: '{user} {user.name} {user.id} {server} {server.members}'},
					)}
				</p>
				<fieldset
					disabled={!Permission.can(Permissions.MANAGE_ROLES, {guildId})}
					className={styles.fields}
					data-flx="micupbot.micup-bot-welcome.fields--3"
				>
					<IdsSelect
						guildId={guildId}
						kind="roles"
						label={msg({
							message: 'Automatic roles',
							comment: 'Roles automatically assigned when a member joins; at most five.',
						})}
						value={draft.autorole_ids}
						max={MICUPBOT_LIMITS.autoroleMax}
						onChange={(value) => setDraft({...draft, autorole_ids: value})}
						data-flx="micupbot.micup-bot-welcome.ids-select.set-draft"
					/>
				</fieldset>
				<Button type="submit" submitting={Settings.saving} data-flx="micupbot.micup-bot-welcome.button.submit">
					{i18n._(M.save)}
				</Button>
			</fieldset>
		</form>
	);
});
