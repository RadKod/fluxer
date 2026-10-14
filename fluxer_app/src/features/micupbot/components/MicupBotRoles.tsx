// SPDX-License-Identifier: AGPL-3.0-or-later

import Channels from '@app/features/channel/state/Channels';
import {EmojiPickerPopout} from '@app/features/emoji/components/popouts/EmojiPickerPopout';
import Guilds from '@app/features/guild/state/Guilds';
import {toReactionEmoji} from '@app/features/messaging/utils/ReactionUtils';
import {ChannelSelect, M, RoleSelect} from '@app/features/micupbot/components/MicupBotControls';
import styles from '@app/features/micupbot/components/MicupBotTab.module.css';
import Settings from '@app/features/micupbot/state/MicupBotSettings';
import Permission from '@app/features/permissions/state/Permission';
import {Button} from '@app/features/ui/button/Button';
import {Combobox} from '@app/features/ui/components/form/FormCombobox';
import {Input, Textarea} from '@app/features/ui/components/form/FormInput';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	MICUPBOT_LIMITS,
	MICUPBOT_PANEL_MODES,
	type MicupBotReactionRolePanelCreateRequest,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const MODES = {
	normal: msg({
		message: 'Normal — add and remove roles with reactions',
		comment: 'Reaction role panel mode: each reaction independently grants or removes a role.',
	}),
	unique: msg({
		message: 'Unique — keep only one role from this panel',
		comment: 'Reaction role panel mode: choosing a new role removes the other panel roles.',
	}),
	add_only: msg({
		message: 'Add only — removing a reaction keeps the role',
		comment: 'Reaction role panel mode: removing a reaction does not revoke its role.',
	}),
};

export const MicupBotRoles = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [picking, setPicking] = useState<number | null>(null);
	const [draft, setDraft] = useState<(typeof MicupBotReactionRolePanelCreateRequest)['_input']>({
		channel_id: '',
		title: '',
		description: '',
		mode: 'normal',
		entries: [{emoji: {name: ''}, role_id: ''}],
	});
	const panels = Settings.panels!;
	const canCreate = Permission.can(Permissions.MANAGE_ROLES, {guildId}) && Settings.data!.bot!.in_guild;
	const max = Math.min(panels.max_panels, MICUPBOT_LIMITS.panelsMax);
	return (
		<div className={styles.fields} data-flx="micupbot.micup-bot-roles.fields">
			{panels.panels.map((panel) => {
				const channel = Channels.getGuildChannels(guildId).find((item) => item.id === panel.channel_id);
				return (
					<section key={panel.message_id} className={styles.card} data-flx="micupbot.micup-bot-roles.card">
						<h3 className={styles.heading} data-flx="micupbot.micup-bot-roles.h3">
							{panel.title}
						</h3>
						<p data-flx="micupbot.micup-bot-roles.p">
							{`${channel ? `#${channel.name ?? channel.id}` : i18n._(M.deletedChannel, {id: panel.channel_id})} · ${i18n._(MODES[panel.mode])}`}
						</p>
						{panel.description && <p data-flx="micupbot.micup-bot-roles.p--2">{panel.description}</p>}
						<ul className={styles.list} data-flx="micupbot.micup-bot-roles.list">
							{panel.entries.map((entry) => (
								<li key={entry.role_id} data-flx="micupbot.micup-bot-roles.li">
									{`${entry.emoji.name} → ${Guilds.getGuildRoles(guildId).find((role) => role.id === entry.role_id)?.name ?? i18n._(M.deletedRole, {id: entry.role_id})}`}
								</li>
							))}
						</ul>
						{deleting === panel.message_id ? (
							<div className={styles.row} data-flx="micupbot.micup-bot-roles.row">
								<p role="alert" data-flx="micupbot.micup-bot-roles.alert">
									{i18n._(
										msg({
											message: 'Delete this reaction role panel?',
											comment: 'Confirmation before deleting a community bot reaction role panel.',
										}),
									)}
								</p>
								<Button
									variant="danger"
									disabled={Settings.saving}
									onClick={async () => {
										if (await Settings.deletePanel(panel.message_id)) setDeleting(null);
									}}
									data-flx="micupbot.micup-bot-roles.button"
								>
									{i18n._(M.remove)}
								</Button>
								<Button
									variant="secondary"
									onClick={() => setDeleting(null)}
									data-flx="micupbot.micup-bot-roles.button.set-deleting"
								>
									{i18n._(M.cancel)}
								</Button>
							</div>
						) : (
							<Button
								variant="secondary"
								disabled={Settings.saving}
								onClick={() => setDeleting(panel.message_id)}
								data-flx="micupbot.micup-bot-roles.button.set-deleting--2"
							>
								{i18n._(M.remove)}
							</Button>
						)}
					</section>
				);
			})}
			<div className={styles.row} data-flx="micupbot.micup-bot-roles.row--2">
				<Button
					disabled={!canCreate || Settings.saving || panels.panels.length >= max || creating}
					onClick={() => setCreating(true)}
					data-flx="micupbot.micup-bot-roles.button.set-creating"
				>
					{i18n._(msg({message: 'Create panel', comment: 'Create and post a community bot reaction role panel.'}))}
				</Button>
				<span data-flx="micupbot.micup-bot-roles.span">
					{panels.panels.length}/{max}
				</span>
			</div>
			{creating && (
				<form
					onSubmit={async (event) => {
						event.preventDefault();
						if (await Settings.createPanel(draft)) {
							setCreating(false);
							setPicking(null);
							setDraft({
								channel_id: '',
								title: '',
								description: '',
								mode: 'normal',
								entries: [{emoji: {name: ''}, role_id: ''}],
							});
						}
					}}
					data-flx="micupbot.micup-bot-roles.form.prevent-default"
				>
					<fieldset
						className={styles.card}
						disabled={Settings.saving || !canCreate || panels.panels.length >= max}
						data-flx="micupbot.micup-bot-roles.card--2"
					>
						<ChannelSelect
							guildId={guildId}
							required
							value={draft.channel_id ? String(draft.channel_id) : null}
							onChange={(value) => setDraft({...draft, channel_id: value ?? ''})}
							data-flx="micupbot.micup-bot-roles.channel-select.set-draft"
						/>
						<Combobox
							label={i18n._(msg({message: 'Mode', comment: 'How the reaction role panel grants or removes roles.'}))}
							value={draft.mode ?? 'normal'}
							onChange={(mode) => setDraft({...draft, mode})}
							options={MICUPBOT_PANEL_MODES.map((value) => ({value, label: i18n._(MODES[value])}))}
							data-flx="micupbot.micup-bot-roles.combobox.set-draft"
						/>
						<Input
							label={i18n._(msg({message: 'Title', comment: 'Title of a community bot reaction role panel.'}))}
							required
							maxLength={MICUPBOT_LIMITS.panelTitleMax}
							value={draft.title}
							onChange={(event) => setDraft({...draft, title: event.target.value})}
							data-flx="micupbot.micup-bot-roles.input.set-draft"
						/>
						<Textarea
							label={i18n._(
								msg({
									message: 'Description',
									comment: 'Optional explanation shown in a community bot reaction role panel.',
								}),
							)}
							maxLength={MICUPBOT_LIMITS.panelDescriptionMax}
							value={draft.description ?? ''}
							onChange={(event) => setDraft({...draft, description: event.target.value})}
							data-flx="micupbot.micup-bot-roles.textarea.set-draft"
						/>
						{draft.entries.map((entry, index) => (
							<div key={index} className={styles.card} data-flx="micupbot.micup-bot-roles.card--3">
								<Button
									variant="secondary"
									onClick={() => setPicking(index)}
									data-flx="micupbot.micup-bot-roles.button.set-picking"
								>
									{entry.emoji.name ||
										i18n._(
											msg({message: 'Choose emoji', comment: 'Open the expression picker for a reaction role entry.'}),
										)}
								</Button>
								{picking === index && (
									<EmojiPickerPopout
										channelId={draft.channel_id ? String(draft.channel_id) : null}
										onClose={() => setPicking(null)}
										handleSelect={(emoji) => {
											setDraft({
												...draft,
												entries: draft.entries.map((item, i) =>
													i === index ? {...item, emoji: toReactionEmoji(emoji)} : item,
												),
											});
											setPicking(null);
										}}
										data-flx="micupbot.micup-bot-roles.emoji-picker-popout"
									/>
								)}
								<RoleSelect
									guildId={guildId}
									value={String(entry.role_id)}
									onChange={(role_id) =>
										setDraft({
											...draft,
											entries: draft.entries.map((item, i) => (i === index ? {...item, role_id} : item)),
										})
									}
									data-flx="micupbot.micup-bot-roles.role-select.set-draft"
								/>
								<Button
									variant="secondary"
									disabled={draft.entries.length <= 1}
									onClick={() => {
										setPicking(null);
										setDraft({...draft, entries: draft.entries.filter((_, i) => i !== index)});
									}}
									data-flx="micupbot.micup-bot-roles.button.set-picking--2"
								>
									{i18n._(
										msg({message: 'Remove entry', comment: 'Remove one emoji and role pair from the panel form.'}),
									)}
								</Button>
							</div>
						))}
						<Button
							variant="secondary"
							disabled={draft.entries.length >= MICUPBOT_LIMITS.panelEntriesMax}
							onClick={() => setDraft({...draft, entries: [...draft.entries, {emoji: {name: ''}, role_id: ''}]})}
							data-flx="micupbot.micup-bot-roles.button.set-draft"
						>
							{i18n._(
								msg({message: 'Add entry', comment: 'Add another emoji and role pair to a panel, at most twenty.'}),
							)}
						</Button>
						<div className={styles.row} data-flx="micupbot.micup-bot-roles.row--3">
							<Button type="submit" submitting={Settings.saving} data-flx="micupbot.micup-bot-roles.button.submit">
								{i18n._(M.save)}
							</Button>
							<Button
								variant="secondary"
								onClick={() => {
									setCreating(false);
									setPicking(null);
								}}
								data-flx="micupbot.micup-bot-roles.button.set-creating--2"
							>
								{i18n._(M.cancel)}
							</Button>
						</div>
					</fieldset>
				</form>
			)}
		</div>
	);
});
