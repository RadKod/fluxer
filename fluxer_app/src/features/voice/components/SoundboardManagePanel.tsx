// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import {openFilePicker} from '@app/features/messaging/utils/FilePickerUtils';
import Permission from '@app/features/permissions/state/Permission';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
import {Slider} from '@app/features/ui/components/Slider';
import Users from '@app/features/user/state/Users';
import * as SoundboardCommands from '@app/features/voice/commands/SoundboardCommands';
import styles from '@app/features/voice/components/SoundboardPanel.module.css';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {SOUNDBOARD_MAX_SIZE_BYTES} from '@fluxer/constants/src/SoundboardConstants';
import type {GuildSoundboardSoundResponse} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';

const NAME = msg({message: 'Sound name', comment: 'Label for the community soundboard sound name field.'});
const CHOOSE = msg({message: 'Choose audio', comment: 'Soundboard action to choose an MP3 or Ogg file.'});
const REQUIREMENTS = msg({
	message: 'MP3 or Ogg, up to 512,000 bytes and 5.2 seconds.',
	comment: 'Community sound upload requirements; server validates duration and audio format.',
});
const INVALID_FILE = msg({
	message: 'Choose an MP3 or Ogg file up to 512,000 bytes.',
	comment: 'Soundboard upload error for unsupported format or file size.',
});
const SAVE = msg({message: 'Save sound', comment: 'Soundboard form save action.'});
const CANCEL = msg({message: 'Back to sounds', comment: 'Soundboard form action to return to the sound list.'});
const VOLUME = msg({
	message: 'Sound volume',
	comment: 'Accessible label of the normalized volume slider for one soundboard sound.',
});
const FAILURE = msg({
	message: 'Could not save this sound. Try again.',
	comment: 'Soundboard upload or metadata update failure.',
});
const DELETE = msg({
	message: 'Delete sound',
	comment: 'Soundboard action and confirmation title for deleting a sound.',
});
const DELETE_HINT = msg({
	message: 'Delete {name}? This sound will be removed from the community.',
	comment: 'Soundboard delete confirmation description.',
});
const DELETE_FAILURE = msg({
	message: 'Could not delete this sound. Try again.',
	comment: 'Soundboard sound deletion failure.',
});

export const SoundboardManagePanel = observer(
	({
		guildId,
		sound,
		onClose,
		uploadAllowed,
	}: {
		guildId: string;
		sound?: GuildSoundboardSoundResponse;
		onClose: () => void;
		uploadAllowed: boolean;
	}) => {
		const {i18n} = useLingui();
		const [name, setName] = useState(sound?.name ?? '');
		const [volume, setVolume] = useState(sound?.volume ?? 1);
		const [file, setFile] = useState<File | null>(null);
		const [error, setError] = useState<string | null>(null);
		const [busy, setBusy] = useState(false);
		const mounted = useRef(true);
		useEffect(() => {
			mounted.current = true;
			return () => {
				mounted.current = false;
			};
		}, []);
		const canEdit = () =>
			sound
				? Permission.can(Permissions.MANAGE_EXPRESSIONS, {guildId}) ||
					(sound.creator_id === Users.currentUserId && Permission.can(Permissions.CREATE_EXPRESSIONS, {guildId}))
				: uploadAllowed && Permission.can(Permissions.CREATE_EXPRESSIONS, {guildId});
		const choose = async () => {
			const [selected] = await openFilePicker({accept: '.mp3,.ogg,audio/mpeg,audio/ogg'});
			if (!selected || !mounted.current) return;
			if (
				!/\.(mp3|ogg)$/i.test(selected.name) ||
				(selected.type !== '' &&
					!['audio/mpeg', 'audio/mp3', 'audio/ogg', 'application/ogg'].includes(selected.type)) ||
				selected.size === 0 ||
				selected.size > SOUNDBOARD_MAX_SIZE_BYTES
			) {
				setFile(null);
				setError(i18n._(INVALID_FILE));
				return;
			}
			setFile(selected);
			setError(null);
			if (!name) setName(selected.name.replace(/\.(mp3|ogg)$/i, '').slice(0, 32));
		};
		const save = async () => {
			if (!canEdit() || busy || !name.trim() || (!sound && !file)) return;
			setBusy(true);
			setError(null);
			try {
				if (sound) await SoundboardCommands.updateSound(guildId, sound.id, {name: name.trim(), volume});
				else if (file) {
					const bytes = new Uint8Array(await file.arrayBuffer());
					if (!mounted.current || !canEdit()) return;
					let binary = '';
					for (let offset = 0; offset < bytes.length; offset += 8192)
						binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
					await SoundboardCommands.uploadSound(guildId, {name: name.trim(), audio: btoa(binary), volume});
				}
				if (mounted.current) onClose();
			} catch {
				if (mounted.current) setError(i18n._(FAILURE));
			} finally {
				if (mounted.current) setBusy(false);
			}
		};
		const remove = () => {
			if (!sound || !canEdit() || busy) return;
			ModalCommands.push(
				ModalCommands.modal(() => (
					<ConfirmModal
						title={i18n._(DELETE)}
						description={i18n._(DELETE_HINT, {name: sound.name})}
						primaryText={i18n._(DELETE)}
						primaryVariant="danger"
						onPrimary={async () => {
							if (!canEdit() || !mounted.current) return;
							try {
								await SoundboardCommands.deleteSound(guildId, sound.id);
								if (mounted.current) onClose();
							} catch {
								if (mounted.current) setError(i18n._(DELETE_FAILURE));
							}
						}}
					/>
				)),
			);
		};
		return (
			<form
				className={styles.form}
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<Input
					label={i18n._(NAME)}
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={32}
					disabled={busy || !canEdit()}
				/>
				{!sound && (
					<>
						<Button
							variant="secondary"
							disabled={busy || !canEdit()}
							onClick={() => {
								void choose();
							}}
						>
							{i18n._(CHOOSE)}
						</Button>
						<p className={styles.hint}>{i18n._(REQUIREMENTS)}</p>
						{file && <p className={styles.hint}>{file.name}</p>}
					</>
				)}
				<div className={styles.volume}>
					<span className={styles.hint}>{i18n._(VOLUME)}</span>
					<Slider
						value={volume}
						defaultValue={volume}
						factoryDefaultValue={1}
						minValue={0}
						maxValue={1}
						step={0.01}
						ariaLabel={i18n._(VOLUME)}
						onValueChange={setVolume}
						disabled={busy || !canEdit()}
						showResetButton={false}
					/>
				</div>
				{error && (
					<p role="alert" className={styles.error}>
						{error}
					</p>
				)}
				<div className={styles.actions}>
					<Button type="submit" submitting={busy} disabled={!canEdit() || !name.trim() || (!sound && !file)}>
						{i18n._(SAVE)}
					</Button>
					<Button variant="secondary" disabled={busy} onClick={onClose}>
						{i18n._(CANCEL)}
					</Button>
					{sound && canEdit() && (
						<Button variant="danger" disabled={busy} onClick={remove}>
							{i18n._(DELETE)}
						</Button>
					)}
				</div>
			</form>
		);
	},
);
