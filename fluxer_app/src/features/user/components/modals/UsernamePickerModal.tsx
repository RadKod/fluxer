// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Modal from '@app/features/app/components/dialogs/Modal';
import {useFormSubmit} from '@app/features/app/hooks/useFormSubmit';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Form} from '@app/features/ui/components/form/Form';
import * as UserCommands from '@app/features/user/commands/UserCommands';
import {getUsernameStatus, type UsernamePrivateStatus} from '@app/features/user/commands/UsernameCommands';
import styles from '@app/features/user/components/modals/FluxerTagChangeModal.module.css';
import {UsernamePicker} from '@app/features/user/components/UsernamePicker';
import {
	normalizeUsername,
	type UsernameSelectionAvailability,
	useUsernameSelectionAvailability,
} from '@app/features/user/hooks/useUsernameSelectionAvailability';
import type {User} from '@app/features/user/models/User';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {useForm} from 'react-hook-form';

export interface UsernamePickerModalProps {
	user: User;
	required?: boolean;
	inline?: boolean;
	onClose?: () => void;
	onSelected?: () => void;
}

export const UsernamePickerModal = observer(
	({user, required = false, inline = false, onClose, onSelected}: UsernamePickerModalProps) => {
		const {i18n} = useLingui();
		const inputRef = useRef<HTMLInputElement>(null);
		const [status, setStatus] = useState<UsernamePrivateStatus | null>(null);
		const [availability, setAvailability] = useState<UsernameSelectionAvailability>({state: 'idle'});
		const form = useForm<{username: string}>({
			defaultValues: {username: user.usernameState === 'selected' ? user.username : ''},
		});
		const username = form.watch('username');
		const oldName = normalizeUsername(user.username);
		const suggestion = useUsernameSelectionAvailability(oldName, {
			enabled: user.usernameState !== 'selected' && oldName.length >= 4,
		});
		const edited = useRef(false);
		useEffect(() => {
			const controller = new AbortController();
			getUsernameStatus(controller.signal)
				.then((value) => {
					if (!controller.signal.aborted) setStatus(value);
				})
				.catch(() => {
					if (!controller.signal.aborted)
						form.setError('username', {
							type: 'server',
							message: i18n._(msg`Username status could not be loaded. Please reopen this screen.`),
						});
				});
			return () => controller.abort();
		}, [user.id, form, i18n.locale]);
		useEffect(() => {
			if (!edited.current && !form.getValues('username') && suggestion.state === 'available')
				form.setValue('username', oldName);
		}, [suggestion.state, oldName, form]);
		const close = onClose ?? ModalCommands.pop;
		const cooldownBlocked =
			status?.state === 'selected' &&
			!status.freeChangeAvailable &&
			status.changeAvailableAt !== null &&
			new Date(status.changeAvailableAt).getTime() > Date.now();
		const canSave =
			status !== null &&
			(status.state !== 'selected' || normalizeUsername(username) !== oldName) &&
			!cooldownBlocked &&
			availability.state === 'available' &&
			availability.username === normalizeUsername(username);
		const {handleSubmit, isSubmitting} = useFormSubmit({
			form,
			onSubmit: async (data) => {
				if (!canSave) return;
				const canonical = normalizeUsername(data.username);
				const updatedUser = await UserCommands.update({username: canonical});
				Users.handleUserUpdate(updatedUser);
				onSelected?.();
				if (!inline) close();
				const firstSelection = status?.state === 'legacy';
				ToastCommands.createToast({
					type: 'success',
					children: firstSelection
						? i18n._(
								msg`Your username is now @${canonical}! Your first change is available immediately; after that, you can change it every 14 days.`,
							)
						: status?.state === 'reselect_required'
							? i18n._(msg`Username updated`)
							: i18n._(msg`Your username is now @${canonical}! You can change it again in 14 days.`),
				});
			},
			defaultErrorField: 'username',
		});
		const announcement =
			!required && RuntimeConfig.usernameMigration.state === 'selecting' && user.usernameState !== 'selected';
		const forcedAt = RuntimeConfig.usernameMigration.forced_at;
		const title = i18n._(
			required
				? msg`Choose your username to continue`
				: announcement
					? msg`Tags are gone 🎉`
					: msg`Choose your username`,
		);
		const fields = (
			<div className={styles.confirmDescription}>
				{announcement ? (
					<>
						<p>
							<Trans>sanalyer no longer uses #1234 tags. Everyone has a unique username: @yourname.</Trans>
						</p>
						<p>
							<Trans>Choose a unique username. Your friends can find and add you with this name.</Trans>
						</p>
						<p>
							<Trans>Names belong to whoever chooses them first. Get the name you like while it is available.</Trans>
						</p>
						{forcedAt && (
							<p>
								<Trans>
									If you have not chosen by{' '}
									<time dateTime={forcedAt}>{new Date(forcedAt).toLocaleDateString(i18n.locale)}</time>, you will be
									asked to choose when you open the app.
								</Trans>
							</p>
						)}
					</>
				) : (
					<p>
						<Trans>Tagged names are no longer used. Choose a unique username to continue using sanalyer.</Trans>
					</p>
				)}
				<UsernamePicker
					value={username}
					onChange={(value) => {
						edited.current = true;
						form.setValue('username', value);
					}}
					inputRef={inputRef}
					onAvailabilityChange={setAvailability}
					error={form.formState.errors.username?.message}
					disabled={isSubmitting}
				/>
				{status?.freeChangeAvailable ? (
					<p>
						<Trans>Your first change is immediate; then once every 14 days</Trans>
					</p>
				) : (
					<p>
						<Trans>You can change your username once every 14 days.</Trans>
					</p>
				)}
				{cooldownBlocked && status?.changeAvailableAt && (
					<p role="status">
						<Trans>You can change your username after:</Trans>{' '}
						<time dateTime={status.changeAvailableAt}>
							{new Date(status.changeAvailableAt).toLocaleString(i18n.locale)}
						</time>
					</p>
				)}
			</div>
		);
		const buttons = (
			<>
				{!required && (
					<Button onClick={close} variant="secondary">
						{announcement ? <Trans context="username-selection">Later</Trans> : <Trans>Cancel</Trans>}
					</Button>
				)}
				<Button type="submit" submitting={isSubmitting} disabled={!canSave}>
					<Trans>Choose my name</Trans>
				</Button>
			</>
		);
		if (inline)
			return (
				<Form form={form} onSubmit={handleSubmit} aria-label={title}>
					<div className={styles.confirmDescription}>
						{fields}
						{buttons}
					</div>
				</Form>
			);
		return (
			<Modal.Root
				size={required ? 'fullscreen' : 'small'}
				centered
				initialFocusRef={inputRef}
				onClose={required ? () => {} : close}
			>
				<Form form={form} onSubmit={handleSubmit} aria-label={title}>
					<Modal.Header title={title} hideCloseButton={required} />
					<Modal.Content>{fields}</Modal.Content>
					<Modal.Footer>{buttons}</Modal.Footer>
				</Form>
			</Modal.Root>
		);
	},
);
