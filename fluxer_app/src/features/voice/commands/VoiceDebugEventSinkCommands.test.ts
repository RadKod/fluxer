// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, describe, expect, it, vi} from 'vitest';

const calls = vi.hoisted(() => [] as Array<string>);
const desktop = vi.hoisted(() => ({
	setVoiceDebugEventSinkStatsHtml: vi.fn((html: string) => calls.push(`stats:${html}`)),
	openVoiceDebugEventSinkPopout: vi.fn(async () => {
		calls.push('open');
	}),
	appendVoiceDebugEventSinkEntries: vi.fn(),
}));

vi.mock('@app/features/ui/utils/NativeUtils', () => ({getElectronAPI: () => desktop}));
vi.mock('@app/features/voice/utils/StatsForNerdsCopy', () => ({collectStatsForNerdsSnapshot: () => ({})}));
vi.mock('@app/features/voice/diagnostics/VoiceDebugStatsHtml', () => ({
	renderVoiceDebugStatsHtml: () => 'snapshot',
	renderVoiceDebugStatsUnavailableHtml: () => 'unavailable',
}));

import {openVoiceDebugEventSinkPopout} from '@app/features/voice/commands/VoiceDebugEventSinkCommands';
import voiceEngineV2AppDebugEventSinkHostAdapter from '@app/features/voice/engine/v2/VoiceEngineV2AppDebugEventSinkHostAdapter';

describe('openVoiceDebugEventSinkPopout', () => {
	afterEach(() => {
		voiceEngineV2AppDebugEventSinkHostAdapter.resetEventSinkPopoutStateForTests();
	});

	it('hands the desktop window a stats snapshot before it opens', async () => {
		await openVoiceDebugEventSinkPopout();
		expect(calls).toEqual(['stats:snapshot', 'open']);
	});
});
