// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {type InstanceHTTPTarget, instanceRequest} from '@app/features/platform/transport/InstanceHTTP';
import {http} from '@app/features/platform/transport/RestTransport';

export interface UsernameAvailabilityResult {
	taken: boolean;
	reason?: string | null;
	available_at?: string | null;
}

export interface UsernamePrivateStatus {
	state: 'legacy' | 'selected' | 'reselect_required';
	changeAvailableAt: string | null;
	freeChangeAvailable: boolean;
}

export async function checkUsernameAvailability(
	username: string,
	options: {target?: InstanceHTTPTarget; signal?: AbortSignal} = {},
): Promise<UsernameAvailabilityResult> {
	if (options.target) {
		const response = await instanceRequest<Omit<UsernameAvailabilityResult, 'taken'> & {available: boolean}>({
			method: 'GET',
			path: `${Endpoints.AUTH_USERNAME_AVAILABILITY}?${new URLSearchParams({username})}`,
			target: options.target,
			auth: 'none',
			signal: options.signal,
		});
		return {...response.body, taken: !response.body.available};
	}
	const response = await http.get<UsernameAvailabilityResult>(Endpoints.USER_CHECK_TAG, {
		query: {username, discriminator: '0000'},
		signal: options.signal,
	});
	return response.body;
}

export async function getUsernameStatus(signal?: AbortSignal): Promise<UsernamePrivateStatus> {
	const response = await http.get<UsernamePrivateStatus>(`${Endpoints.USER_ME}/username`, {signal});
	return response.body;
}
