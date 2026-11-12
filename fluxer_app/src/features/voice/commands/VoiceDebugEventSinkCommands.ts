// SPDX-License-Identifier: AGPL-3.0-or-later

import {getElectronAPI} from '@app/features/ui/utils/NativeUtils';
import {
	canOpenBrowserVoiceDebugEventSinkPopout,
	setBrowserVoiceDebugEventSinkStatsHtml,
} from '@app/features/voice/diagnostics/VoiceDebugBrowserEventSinkPopout';
import {
	renderVoiceDebugStatsHtml,
	renderVoiceDebugStatsUnavailableHtml,
} from '@app/features/voice/diagnostics/VoiceDebugStatsHtml';
import voiceEngineV2AppDebugEventSinkHostAdapter from '@app/features/voice/engine/v2/VoiceEngineV2AppDebugEventSinkHostAdapter';
import {collectStatsForNerdsSnapshot} from '@app/features/voice/utils/StatsForNerdsCopy';

export function canOpenVoiceDebugEventSinkPopout(): boolean {
	return Boolean(getElectronAPI()?.openVoiceDebugEventSinkPopout) || canOpenBrowserVoiceDebugEventSinkPopout();
}

function getGeneratedAtIso(): string {
	return new Date().toISOString();
}

function describeStatsSnapshotError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function renderOpeningStatsHtml(): Promise<string> {
	const generatedAtIso = getGeneratedAtIso();
	try {
		return await renderVoiceDebugStatsHtml(collectStatsForNerdsSnapshot(), generatedAtIso);
	} catch (error) {
		return await renderVoiceDebugStatsUnavailableHtml(
			`Failed to collect stats snapshot before opening event sink: ${describeStatsSnapshotError(error)}`,
			generatedAtIso,
		);
	}
}

async function publishOpeningStatsSnapshot(): Promise<void> {
	const electron = getElectronAPI();
	const canOpenBrowser = canOpenBrowserVoiceDebugEventSinkPopout();
	if (!electron?.setVoiceDebugEventSinkStatsHtml && !canOpenBrowser) return;
	const html = await renderOpeningStatsHtml();
	electron?.setVoiceDebugEventSinkStatsHtml?.(html);
	if (canOpenBrowser) setBrowserVoiceDebugEventSinkStatsHtml(html);
}

export async function openVoiceDebugEventSinkPopout(): Promise<void> {
	await publishOpeningStatsSnapshot();
	await voiceEngineV2AppDebugEventSinkHostAdapter.openEventSinkPopout();
}
