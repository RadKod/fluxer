// SPDX-License-Identifier: AGPL-3.0-or-later

import Channels from '@app/features/channel/state/Channels';
import Guilds from '@app/features/guild/state/Guilds';
import {Combobox} from '@app/features/ui/components/form/FormCombobox';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useId} from 'react';

export const M = {
	save: msg({message: 'Save', comment: 'Save the current community bot form.'}),
	cancel: msg({message: 'Cancel', comment: 'Cancel the community bot edit or deletion.'}),
	remove: msg({message: 'Delete', comment: 'Delete the selected community bot configuration or warning.'}),
	channel: msg({message: 'Channel', comment: 'Text channel receiving community bot messages.'}),
	role: msg({message: 'Role', comment: 'Role granted by the community bot.'}),
	none: msg({message: 'None', comment: 'No channel or role selected in community bot settings.'}),
	selectChannel: msg({message: 'Select a channel', comment: 'Empty choice of a required community bot channel.'}),
	selectRole: msg({message: 'Select a role', comment: 'Empty choice of a required community bot role.'}),
	missingChannel: msg({
		message: 'This channel no longer exists.',
		comment: 'Shown under a community bot channel field whose saved channel was deleted.',
	}),
	missingRole: msg({
		message: 'This role no longer exists.',
		comment: 'Shown under a community bot role field whose saved role was deleted.',
	}),
	missingItems: msg({
		message: 'Deleted items are still selected: {items}',
		comment: 'Shown under a community bot multi-select; items lists the deleted roles or channels still selected.',
	}),
	same: msg({message: 'Same channel', comment: 'Send the level message where XP was earned; no fixed channel.'}),
	enabled: msg({message: 'Enabled', comment: 'Enable this community bot module or rule.'}),
	message: msg({message: 'Message', comment: 'Community bot message template, empty uses the default.'}),
	embed: msg({message: 'Send as an embed', comment: 'Display the community bot message in an embed.'}),
	general: msg({message: 'General', comment: 'Community bot setup and command settings subtab.'}),
	welcome: msg({message: 'Welcome', comment: 'Community bot join and leave messages subtab.'}),
	roles: msg({message: 'Roles', comment: 'Community bot reaction role panels subtab.'}),
	levels: msg({message: 'Levels', comment: 'Community bot experience and rewards subtab.'}),
	automod: msg({message: 'Automod', comment: 'Community bot automatic moderation subtab and module.'}),
	warnings: msg({message: 'Warnings', comment: 'Community bot member warning records subtab.'}),
	commands: msg({message: 'Commands', comment: 'Enable community bot text commands.'}),
	loading: msg({message: 'Loading…', comment: 'Community bot settings or member warnings are loading.'}),
	retry: msg({message: 'Try again', comment: 'Retry loading community bot settings.'}),
	deletedRole: msg({
		message: 'Deleted role ({id})',
		comment: 'Missing role referenced by community bot settings; id is the role ID.',
	}),
	deletedChannel: msg({
		message: 'Deleted channel ({id})',
		comment: 'Missing channel referenced by community bot settings; id is the channel ID.',
	}),
};

export function Toggle({
	label,
	value,
	onChange,
	disabled = false,
}: {
	label: MessageDescriptor;
	value: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
}) {
	const {i18n} = useLingui();
	return (
		<Switch
			label={i18n._(label)}
			value={value}
			onChange={onChange}
			disabled={disabled}
			data-flx="micupbot.micup-bot-controls.toggle.switch.change"
		/>
	);
}

export const ChannelSelect = observer(
	({
		guildId,
		label = M.channel,
		value,
		onChange,
		same = false,
		required = false,
	}: {
		guildId: string;
		label?: MessageDescriptor;
		value: string | null;
		onChange: (value: string | null) => void;
		same?: boolean;
		required?: boolean;
	}) => {
		const {i18n} = useLingui();
		const id = useId();
		const channels = Channels.getGuildChannels(guildId).filter((channel) => channel.type === ChannelTypes.GUILD_TEXT);
		const missing = value !== null && value !== '' && !channels.some((channel) => channel.id === value);
		return (
			<Combobox
				id={id}
				label={i18n._(label)}
				value={value ?? ''}
				onChange={(next) => onChange(next || null)}
				error={missing ? i18n._(M.missingChannel) : undefined}
				options={[
					{value: '', label: i18n._(required ? M.selectChannel : same ? M.same : M.none)},
					...channels.map((channel) => ({value: channel.id, label: channel.name ?? channel.id})),
					...(missing ? [{value: value!, label: i18n._(M.deletedChannel, {id: value})}] : []),
				]}
				data-flx="micupbot.micup-bot-controls.channel-select.combobox.change"
			/>
		);
	},
);

export const RoleSelect = observer(
	({guildId, value, onChange}: {guildId: string; value: string; onChange: (value: string) => void}) => {
		const {i18n} = useLingui();
		const id = useId();
		const roles = Guilds.getGuildRoles(guildId).filter((role) => role.id !== guildId);
		const missing = value !== '' && !roles.some((role) => role.id === value);
		return (
			<Combobox
				id={id}
				label={i18n._(M.role)}
				value={value}
				onChange={onChange}
				error={missing ? i18n._(M.missingRole) : undefined}
				options={[
					{value: '', label: i18n._(M.selectRole)},
					...roles.map((role) => ({value: role.id, label: role.name})),
					...(missing ? [{value, label: i18n._(M.deletedRole, {id: value})}] : []),
				]}
				data-flx="micupbot.micup-bot-controls.role-select.combobox.change"
			/>
		);
	},
);

export const IdsSelect = observer(
	({
		guildId,
		kind,
		label,
		value,
		max,
		onChange,
	}: {
		guildId: string;
		kind: 'roles' | 'channels';
		label: MessageDescriptor;
		value: Array<string>;
		max: number;
		onChange: (value: Array<string>) => void;
	}) => {
		const {i18n} = useLingui();
		const id = useId();
		const options =
			kind === 'roles'
				? Guilds.getGuildRoles(guildId)
						.filter((role) => role.id !== guildId)
						.map((role) => ({value: role.id, label: role.name}))
				: Channels.getGuildChannels(guildId).map((channel) => ({value: channel.id, label: channel.name ?? channel.id}));
		const missing: Array<string> = [];
		for (const selected of value)
			if (!options.some((option) => option.value === selected)) {
				const deleted = i18n._(kind === 'roles' ? M.deletedRole : M.deletedChannel, {id: selected});
				missing.push(deleted);
				options.push({value: selected, label: deleted});
			}
		return (
			<Combobox<string, true>
				id={id}
				label={i18n._(label)}
				isMulti
				value={value}
				error={missing.length ? i18n._(M.missingItems, {items: missing.join(', ')}) : undefined}
				onChange={(next) => {
					if (next.length <= max) onChange(next);
				}}
				options={options.map((option) => ({
					...option,
					isDisabled: value.length >= max && !value.includes(option.value),
				}))}
				data-flx="micupbot.micup-bot-controls.ids-select.combobox"
			/>
		);
	},
);
