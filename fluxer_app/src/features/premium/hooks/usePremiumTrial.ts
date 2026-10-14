// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import Users from '@app/features/user/state/Users';
import * as FormUtils from '@app/lib/forms';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {PremiumTrialEligibilityResponse} from '@fluxer/schema/src/domains/premium/PremiumTrialSchemas';
import type {User} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {useEffect, useState} from 'react';

const TRIAL_STARTED_DESCRIPTOR = msg({
	message: 'Your free {premiumProductName} trial has started.',
	comment: 'Success toast after the free Plus trial starts. Preserve {premiumProductName}.',
});
const TRIAL_ALREADY_USED_DESCRIPTOR = msg({
	message: 'You have already used the free trial. It is one per account and email address.',
	comment:
		'Error toast after "Try free" on the Plus page when the server says this account or email address already had the trial.',
});

interface PremiumTrialOffer {
	days: number;
	claiming: boolean;
	start: () => Promise<void>;
}

// Micup: the one-time card-free trial, for the premium page's "Try free" button; null when there is
// none to offer. It never writes premium state itself: the gateway's USER_UPDATE does, and the offer goes away.
export function usePremiumTrial(): PremiumTrialOffer | null {
	const {i18n} = useLingui();
	const offered = RuntimeConfig.premiumTrialDays > 0 && Users.currentUser?.isPremium() === false;
	const [eligibility, setEligibility] = useState<PremiumTrialEligibilityResponse | null>(null);
	const [claiming, setClaiming] = useState(false);
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (!offered) return;
		let active = true;
		// An unreadable answer offers nothing; the claim endpoint enforces eligibility either way.
		http.get<PremiumTrialEligibilityResponse>(Endpoints.PREMIUM_TRIAL).then(
			({body}) => active && setEligibility(body),
			() => {},
		);
		return () => {
			active = false;
		};
	}, [offered]);
	if (!offered || !eligibility?.eligible || done) return null;
	const start = async () => {
		setClaiming(true);
		try {
			await http.post(Endpoints.PREMIUM_TRIAL);
			setDone(true);
			ToastCommands.success(i18n._(TRIAL_STARTED_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME}));
		} catch (error) {
			setClaiming(false);
			// Anything but an API refusal is the captcha being closed.
			if (!(error instanceof HttpError)) return;
			if (failureCode(error) === APIErrorCodes.TRIAL_ALREADY_USED) {
				setDone(true);
				ToastCommands.error(i18n._(TRIAL_ALREADY_USED_DESCRIPTOR));
				// A parallel claim may have won; re-read the user so premium shows even if its USER_UPDATE was missed.
				http.get<User>(Endpoints.USER_ME).then(
					({body}) => Users.handleUserUpdate(body),
					() => {},
				);
				return;
			}
			FormUtils.pushApiErrorModal(i18n, error);
		}
	};
	return {days: eligibility.days, claiming, start};
}
