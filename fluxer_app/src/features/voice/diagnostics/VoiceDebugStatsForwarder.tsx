// SPDX-License-Identifier: AGPL-3.0-or-later

import {getElectronAPI} from '@app/features/ui/utils/NativeUtils';
import {useStatsForNerds} from '@app/features/voice/components/useStatsForNerds';
import {setBrowserVoiceDebugEventSinkStatsHtml} from '@app/features/voice/diagnostics/VoiceDebugBrowserEventSinkPopout';
import {
	renderVoiceDebugStatsHtml,
	renderVoiceDebugStatsUnavailableHtml,
} from '@app/features/voice/diagnostics/VoiceDebugStatsHtml';
import {useStoreVersion} from '@app/features/voice/engine/Store';
import voiceEngineV2AppDebugEventSinkHostAdapter from '@app/features/voice/engine/v2/VoiceEngineV2AppDebugEventSinkHostAdapter';
import type {StatsForNerdsData} from '@app/features/voice/utils/VoiceStatsForNerdsPresenter';
import {type ReactElement, useEffect, useRef} from 'react';

const VOICE_DEBUG_STATS_FORWARD_INTERVAL_MS = 2000;

let activeForwarderCount = 0;

function getGeneratedAtIso(): string {
	return new Date().toISOString();
}

function publishStatsHtml(data: StatsForNerdsData): void {
	const electron = getElectronAPI();
	const html = renderVoiceDebugStatsHtml(data, getGeneratedAtIso());
	electron?.setVoiceDebugEventSinkStatsHtml?.(html);
	setBrowserVoiceDebugEventSinkStatsHtml(html);
}

function publishUnavailableStatsHtml(): void {
	const electron = getElectronAPI();
	const html = renderVoiceDebugStatsUnavailableHtml(
		'No active voice call stats snapshot is available.',
		getGeneratedAtIso(),
	);
	electron?.setVoiceDebugEventSinkStatsHtml?.(html);
	setBrowserVoiceDebugEventSinkStatsHtml(html);
}

function OpenPopoutVoiceDebugStatsForwarder(): null {
	const data = useStatsForNerds();
	const dataRef = useRef(data);
	dataRef.current = data;
	useEffect(() => {
		activeForwarderCount += 1;
		publishStatsHtml(dataRef.current);
		const intervalId = window.setInterval(() => {
			if (!voiceEngineV2AppDebugEventSinkHostAdapter.isEventSinkPopoutOpen()) {
				voiceEngineV2AppDebugEventSinkHostAdapter.handleEventSinkPopoutClosed();
				return;
			}
			publishStatsHtml(dataRef.current);
		}, VOICE_DEBUG_STATS_FORWARD_INTERVAL_MS);
		return () => {
			window.clearInterval(intervalId);
			activeForwarderCount -= 1;
			if (activeForwarderCount === 0 && voiceEngineV2AppDebugEventSinkHostAdapter.isEventSinkPopoutOpen()) {
				publishUnavailableStatsHtml();
			}
		};
	}, []);
	return null;
}

export function VoiceDebugStatsForwarder(): ReactElement | null {
	useStoreVersion(voiceEngineV2AppDebugEventSinkHostAdapter);
	if (!voiceEngineV2AppDebugEventSinkHostAdapter.isEventSinkPopoutOpen()) return null;
	return (
		<OpenPopoutVoiceDebugStatsForwarder data-flx="voice.voice-debug-stats-forwarder.open-popout-voice-debug-stats-forwarder" />
	);
}
