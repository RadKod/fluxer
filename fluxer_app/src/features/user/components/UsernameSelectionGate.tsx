// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {UserSettingsModal} from '@app/features/app/components/dialogs/LoadableSettingsModals';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import * as AuthenticationCommands from '@app/features/auth/commands/AuthenticationCommands';
import {openClaimAccountModal} from '@app/features/auth/components/modals/ClaimAccountModal';
import {createNamedLoadableComponent} from '@app/features/platform/components/loadable/LoadableComponent';
import {useLocation} from '@app/features/platform/components/router/RouterReact';
import SessionManager from '@app/features/platform/state/AuthSession';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import Modal from '@app/features/ui/state/Modal';
import type {UsernamePickerModalProps} from '@app/features/user/components/modals/UsernamePickerModal';
import styles from '@app/features/user/components/UsernameSelectionGate.module.css';
import UsernameSelection from '@app/features/user/state/UsernameSelection';
import Users from '@app/features/user/state/Users';
import {
	isUsernameGateEscapePath,
	nextUsernamePromptDay,
	type UsernameGateMigration,
	usernameGateMode,
	usernamePromptDay,
} from '@app/features/user/utils/UsernameSelectionGateUtils';
import {DELETED_USER_ID} from '@fluxer/constants/src/UserConstants';
import type {UserUsernamePromptResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {Trans} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';

const logger = new Logger('UsernameSelectionGate');
const PROMPT_MODAL_KEY = 'username-selection-prompt';
const UsernamePickerModal = createNamedLoadableComponent<UsernamePickerModalProps>({
	displayName: 'UsernamePickerModal',
	load: async () => (await import('@app/features/user/components/modals/UsernamePickerModal')).UsernamePickerModal,
});

export const UsernameSelectionGate = observer(({children}: {children: ReactNode}) => {
	const location = useLocation();
	const accountKey = SessionManager.isAuthenticated ? SessionManager.currentAccountKey : null;
	const currentUser = Users.currentUser;
	const user = accountKey !== null && currentUser?.id === SessionManager.userId ? currentUser : undefined;
	const migration: UsernameGateMigration =
		accountKey === null ? {state: 'legacy', epoch: 0} : RuntimeConfig.usernameMigration;
	const [tick, wake] = useState(0);
	const userId = user?.id;
	const usernameState = user?.usernameState;
	const identityVersion = user?.identityVersion ?? '0';
	const requiredByError = accountKey !== null && UsernameSelection.requiredAccountKey === accountKey;
	const mode = usernameGateMode(
		user?.id === DELETED_USER_ID.toString() ? undefined : user,
		migration,
		Date.now(),
		requiredByError,
	);
	const escapeRoute = isUsernameGateEscapePath(location.pathname);
	const reading = accountKey !== null && UsernameSelection.readingAccountKey === accountKey;
	const fullscreen = mode === 'required' && !reading && !escapeRoute;
	const headingRef = useRef<HTMLHeadingElement>(null);
	const promptRetry = useRef<{key: string; at: number} | null>(null);

	useEffect(() => {
		UsernameSelection.bindAccount(accountKey);
		return () => Modal.pop(PROMPT_MODAL_KEY);
	}, [accountKey]);
	useEffect(() => {
		UsernameSelection.observeIdentity(accountKey, usernameState, identityVersion);
	}, [accountKey, usernameState, identityVersion]);
	useEffect(() => {
		if (!fullscreen) return;
		headingRef.current?.focus({preventScroll: true});
	}, [fullscreen]);
	useEffect(() => {
		if (accountKey === null || !userId || mode !== 'prompt') return;
		const controller = new AbortController();
		const now = Date.now();
		const attemptKey = `${accountKey}:${migration.epoch}:${usernamePromptDay(now)}`;
		const retryAt = promptRetry.current?.key === attemptKey ? promptRetry.current.at : now;
		const nextDay = nextUsernamePromptDay(now);
		const forcedAt = Date.parse(migration.forced_at ?? '') || Number.POSITIVE_INFINITY;
		let timer = window.setTimeout(
			() => wake((value) => value + 1),
			Math.max(1, Math.min(retryAt > now ? retryAt : nextDay, forcedAt) - now),
		);
		let settled = false;
		let requested = false;
		if (now >= retryAt && UsernameSelection.promptAttemptKey !== attemptKey && !escapeRoute) {
			requested = true;
			UsernameSelection.promptAttemptKey = attemptKey;
			void http
				.post<UserUsernamePromptResponse>('/users/@me/username-prompt', {signal: controller.signal})
				.then((response) => {
					if (controller.signal.aborted) return;
					settled = true;
					if ('retry_after_ms' in response.body) {
						promptRetry.current = {key: attemptKey, at: Date.now() + response.body.retry_after_ms};
						UsernameSelection.promptAttemptKey = null;
						window.clearTimeout(timer);
						timer = window.setTimeout(
							() => wake((value) => value + 1),
							Math.max(1, Math.min(promptRetry.current.at, nextDay, forcedAt) - Date.now()),
						);
					} else if (response.body.show === true) UsernameSelection.showPrompt(accountKey);
				})
				.catch((error: unknown) => {
					if (!controller.signal.aborted) {
						settled = true;
						logger.warn('Could not request the daily username prompt', error);
					}
				});
		}
		const onVisible = () => {
			if (document.visibilityState === 'visible') wake((value) => value + 1);
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			controller.abort();
			if (requested && !settled && UsernameSelection.promptAttemptKey === attemptKey)
				UsernameSelection.promptAttemptKey = null;
			window.clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, [
		accountKey,
		userId,
		mode,
		migration.state,
		migration.epoch,
		migration.started_at,
		migration.forced_at,
		escapeRoute,
		tick,
	]);

	const promptOpen = accountKey !== null && UsernameSelection.promptAccountKey === accountKey;
	useEffect(() => {
		if (!user || !accountKey || mode !== 'prompt' || !promptOpen || escapeRoute) {
			Modal.pop(PROMPT_MODAL_KEY);
			return;
		}
		if (!Modal.hasModal(PROMPT_MODAL_KEY)) {
			Modal.push(
				ModalCommands.modal(() => (
					<UsernamePickerModal
						user={user}
						onClose={() => {
							UsernameSelection.dismissPrompt(accountKey);
							Modal.pop(PROMPT_MODAL_KEY);
						}}
						onSelected={() => {
							UsernameSelection.finishSelection(accountKey);
							Modal.pop(PROMPT_MODAL_KEY);
						}}
					/>
				)),
				PROMPT_MODAL_KEY,
				{forceMainWindow: true},
			);
		}
	}, [accountKey, mode, promptOpen, escapeRoute]);

	const openSettings = () =>
		ModalCommands.push(ModalCommands.modal(() => <UserSettingsModal initialTab="account_security" />, 'user-settings'));
	const helpUrl = Routes.help();
	return (
		<>
			<div className={styles.app} inert={fullscreen || undefined}>
				{children}
			</div>
			{fullscreen && user && accountKey && (
				<section className={styles.screen} aria-labelledby="username-selection-heading">
					<div className={styles.content}>
						<h1 id="username-selection-heading" ref={headingRef} tabIndex={-1}>
							<Trans>Choose your username to continue</Trans>
						</h1>
						<UsernamePickerModal
							key={`${accountKey}:${user.id}`}
							user={user}
							required
							inline
							onSelected={() => UsernameSelection.finishSelection(accountKey)}
						/>
						<div className={styles.actions}>
							<Button onClick={openSettings}>
								<Trans>Settings and account security</Trans>
							</Button>
							{!user.email && (
								<Button onClick={() => openClaimAccountModal({force: true})}>
									<Trans>Claim your account</Trans>
								</Button>
							)}
							<Button onClick={() => UsernameSelection.readAllowed(accountKey)}>
								<Trans>Read messages, block or report</Trans>
							</Button>
							{helpUrl != null && (
								<a href={helpUrl} target="_blank" rel="noopener noreferrer">
									<Trans>Support</Trans>
								</a>
							)}
							<Button
								onClick={() => {
									void AuthenticationCommands.logout().catch((error: unknown) =>
										logger.error('Could not log out', error),
									);
								}}
							>
								<Trans>Log out</Trans>
							</Button>
						</div>
					</div>
				</section>
			)}
			{mode === 'required' && reading && !escapeRoute && accountKey && (
				<div className={styles.returnControl}>
					<Button onClick={() => UsernameSelection.requireSelection(accountKey, identityVersion)}>
						<Trans>Choose your username</Trans>
					</Button>
				</div>
			)}
		</>
	);
});
