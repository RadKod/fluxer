// SPDX-License-Identifier: AGPL-3.0-or-later

import {startBandMicHoldRecovery} from '@app/features/activities/band/flow/BandMicPort';
import {ActivityViewRoot} from '@app/features/activities/components/ActivityViewRoot';
import {startVoiceActivityBinding} from '@app/features/activities/state/VoiceActivityRoomBinding';
import {useEffect} from 'react';

export function VoiceActivitiesRoot() {
	useEffect(() => startVoiceActivityBinding(), []);
	useEffect(() => startBandMicHoldRecovery(), []);
	return <ActivityViewRoot data-flx="activities.voice-activities-root.activity-view-root" />;
}
