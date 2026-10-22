// SPDX-License-Identifier: AGPL-3.0-or-later

import {startBandMicHoldRecovery} from '@app/features/activities/band/flow/BandMicPort';
import {startVoiceActivityBinding} from '@app/features/activities/state/VoiceActivityRoomBinding';
import {useEffect} from 'react';

export function VoiceActivitiesRoot(): null {
	useEffect(() => startVoiceActivityBinding(), []);
	useEffect(() => startBandMicHoldRecovery(), []);
	return null;
}
