// SPDX-License-Identifier: AGPL-3.0-or-later

import TaskbarPin from '@app/features/platform/state/TaskbarPin';
import {runInAction} from 'mobx';
import {useEffect, useState} from 'react';

export function useTaskbarPinNagbar(authenticated: boolean): boolean {
	const [elapsed, setElapsed] = useState(false);
	const [shown, setShown] = useState(false);
	const [focused, setFocused] = useState(() => document.hasFocus());
	const {isHydrated, dismissed, nagbarRefreshed, canOffer} = TaskbarPin;
	const pinned = TaskbarPin.state?.pinned;
	useEffect(() => {
		if (!authenticated) {
			setElapsed(false);
			return;
		}
		const timer = setTimeout(() => setElapsed(true), 120_000);
		return () => clearTimeout(timer);
	}, [authenticated]);
	useEffect(() => {
		const update = () => setFocused(document.hasFocus());
		window.addEventListener('focus', update);
		window.addEventListener('blur', update);
		return () => {
			window.removeEventListener('focus', update);
			window.removeEventListener('blur', update);
		};
	}, []);
	useEffect(() => {
		if (authenticated && elapsed && focused && isHydrated && !dismissed && !pinned && !nagbarRefreshed) {
			runInAction(() => {
				TaskbarPin.nagbarRefreshed = true;
			});
			void TaskbarPin.refresh();
		}
	}, [authenticated, elapsed, focused, isHydrated, dismissed, pinned, nagbarRefreshed]);
	useEffect(() => {
		if (authenticated && elapsed && focused && canOffer) setShown(true);
	}, [authenticated, elapsed, focused, canOffer]);
	return authenticated && elapsed && shown && canOffer;
}
