// SPDX-License-Identifier: AGPL-3.0-or-later

import HoverPreloadScheduler, {type HoverPreloadKind} from '@app/features/app/state/HoverPreloadScheduler';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {useCallback, useEffect, useRef} from 'react';

export function useHoverPreload(kind: HoverPreloadKind, preload: () => void, delayMs: number, enabled = true) {
	const owner = useRef({}).current;
	const cancel = useCallback(() => HoverPreloadScheduler.cancel(kind, owner), [kind, owner]);
	const preloadNow = useCallback(() => {
		cancel();
		if (enabled && !AccountScopedWork.isSuspended) preload();
	}, [cancel, enabled, preload]);
	const schedule = useCallback(() => {
		if (enabled) HoverPreloadScheduler.schedule(kind, owner, preloadNow, delayMs);
	}, [delayMs, enabled, kind, owner, preloadNow]);
	useEffect(() => cancel, [cancel, schedule]);
	return {schedule, cancel, preloadNow};
}
