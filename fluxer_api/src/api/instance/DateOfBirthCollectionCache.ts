// SPDX-License-Identifier: AGPL-3.0-or-later

import {getDateOfBirthPolicy} from '@app/api/instance/AccountsConfigCache';
import {collectsDateOfBirth} from '@fluxer/constants/src/AccountConfigConstants';

// sanalyer (from Micup): birth dates are collected by default on this self-hosted instance too.
export function getLegacyDateOfBirthCollectionDefault(): boolean {
	return true;
}

export function instanceCollectsDateOfBirth(): boolean {
	return collectsDateOfBirth(getDateOfBirthPolicy());
}
