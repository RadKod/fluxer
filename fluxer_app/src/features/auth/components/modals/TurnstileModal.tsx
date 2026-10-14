// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import styles from '@app/features/auth/components/modals/TurnstileModal.module.css';
import {VERIFY_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {useLingui} from '@lingui/react/macro';
import {useEffect, useRef} from 'react';

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
	render(
		container: HTMLElement,
		options: {sitekey: string; theme: 'dark'; callback: (token: string) => void; 'error-callback': () => void},
	): string;
	remove(widgetId: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

const logger = new Logger('TurnstileModal');
let turnstileLoad: Promise<TurnstileApi> | null = null;
let nextModalId = 0;

function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	turnstileLoad ??= new Promise((resolve, reject) => {
		const script = document.createElement('script');
		const fail = () => {
			turnstileLoad = null;
			script.remove();
			reject(new Error('Turnstile script did not load'));
		};
		script.src = TURNSTILE_SCRIPT_URL;
		script.async = true;
		script.onload = () => (window.turnstile ? resolve(window.turnstile) : fail());
		script.onerror = fail;
		document.head.appendChild(script);
	});
	return turnstileLoad;
}

function TurnstileModal({siteKey, onToken}: {siteKey: string; onToken: (token: string | null) => void}) {
	const {i18n} = useLingui();
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let widgetId: string | null = null;
		let active = true;
		loadTurnstile().then(
			(turnstile) => {
				if (!active || !container.current) return;
				widgetId = turnstile.render(container.current, {
					sitekey: siteKey,
					theme: 'dark',
					callback: onToken,
					'error-callback': () => logger.warn('Turnstile widget reported an error'),
				});
			},
			(error) => {
				logger.error('Turnstile failed to load:', error);
				onToken(null);
			},
		);
		return () => {
			active = false;
			if (widgetId !== null) window.turnstile?.remove(widgetId);
		};
	}, [siteKey, onToken]);
	const close = () => onToken(null);
	return (
		<Modal.Root size="small" centered onClose={close} data-flx="auth.turnstile-modal.modal-root">
			<Modal.Header title={i18n._(VERIFY_DESCRIPTOR)} onClose={close} data-flx="auth.turnstile-modal.modal-header" />
			<Modal.Content data-flx="auth.turnstile-modal.modal-content">
				<div ref={container} className={styles.widget} data-flx="auth.turnstile-modal.widget" />
			</Modal.Content>
		</Modal.Root>
	);
}

export function requestTurnstileToken(siteKey: string): Promise<string | null> {
	const key = `turnstile-${nextModalId++}`;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (token: string | null) => {
			if (settled) return;
			settled = true;
			ModalCommands.popWithKey(key);
			resolve(token);
		};
		ModalCommands.pushWithKey(
			modal(() => <TurnstileModal siteKey={siteKey} onToken={finish} data-flx="auth.turnstile-modal" />),
			key,
		);
	});
}
