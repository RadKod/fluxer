// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';
import type {MessageDescriptor} from '@lingui/core';
import type {Icon} from '@phosphor-icons/react';
import type React from 'react';

export interface ActivityViewProps {
	readonly session: ActivitySession;
}

// One activity, written in this app by the team. The View fills the call's stage while the panel is open and is
// unmounted when it closes; the session outlives it.
export interface ActivityDefinition {
	readonly id: VoiceActivityId;
	readonly name: MessageDescriptor;
	readonly icon: Icon;
	readonly minPlayers: number;
	readonly View: React.ComponentType<ActivityViewProps>;
}
