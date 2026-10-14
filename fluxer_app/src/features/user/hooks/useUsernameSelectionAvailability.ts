// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstanceHTTPTarget} from '@app/features/platform/transport/InstanceHTTP';
import {checkUsernameAvailability, type UsernameAvailabilityResult} from '@app/features/user/commands/UsernameCommands';
import {useEffect, useState} from 'react';

export type UsernameSelectionAvailability = Partial<UsernameAvailabilityResult> & {
	username?: string;
	state: 'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'unavailable' | 'error';
};

export function stripUsernamePrefix(value: string): string {
	return value.trim().replace(/^@/, '');
}

export function normalizeUsername(value: string): string {
	return stripUsernamePrefix(value).toLowerCase();
}

export function useUsernameSelectionAvailability(
	value: string,
	{enabled = true, target}: {enabled?: boolean; target?: InstanceHTTPTarget} = {},
): UsernameSelectionAvailability {
	const username = normalizeUsername(value);
	const valid = /^[a-z0-9_]{1,32}$/.test(username);
	const [result, setResult] = useState<{
		username: string;
		target?: InstanceHTTPTarget;
		availability: UsernameSelectionAvailability;
	}>({
		username: '',
		availability: {state: 'idle'},
	});
	useEffect(() => {
		if (!enabled || !valid) return;
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setResult({username, target, availability: {state: 'checking'}});
			checkUsernameAvailability(username, {target, signal: controller.signal})
				.then((availability) => {
					if (controller.signal.aborted) return;
					const reason = availability.reason?.replace(/^USERNAME_/, '');
					setResult({
						username,
						target,
						availability: {
							...availability,
							state: !availability.taken ? 'available' : !reason || reason === 'TAKEN' ? 'taken' : 'unavailable',
						},
					});
				})
				.catch(() => {
					if (!controller.signal.aborted) setResult({username, target, availability: {state: 'error'}});
				});
		}, 350);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [enabled, valid, username, target]);
	if (!enabled || !username) return {state: 'idle'};
	if (!valid) return {state: 'invalid'};
	return result.username === username && result.target === target
		? {...result.availability, username}
		: {state: 'idle', username};
}
