// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	clearVoiceRemoteSpeakingCommands,
	createVoiceRemoteSpeakingSnapshot,
	transitionVoiceRemoteSpeakingSnapshot,
	type VoiceRemoteSpeakingCommand,
	type VoiceRemoteSpeakingEvent,
	type VoiceRemoteSpeakingSnapshot,
} from '@app/features/voice/engine/VoiceParticipantStateMachine';
import {describe, expect, it} from 'vitest';

const IDENTITY = 'user_1_conn';
const TICK_MS = 20;
const THRESHOLD = 0.001;

function run(
	snapshot: VoiceRemoteSpeakingSnapshot,
	events: ReadonlyArray<VoiceRemoteSpeakingEvent>,
): {snapshot: VoiceRemoteSpeakingSnapshot; commands: Array<VoiceRemoteSpeakingCommand>} {
	const commands: Array<VoiceRemoteSpeakingCommand> = [];
	let next = snapshot;
	for (const event of events) {
		next = transitionVoiceRemoteSpeakingSnapshot(next, event);
		commands.push(...next.context.commands);
		next = clearVoiceRemoteSpeakingCommands(next);
	}
	return {snapshot: next, commands};
}

function ticks(fromMs: number, count: number, rms: number): Array<VoiceRemoteSpeakingEvent> {
	return Array.from({length: count}, (_, i) => ({
		type: 'remote.tick' as const,
		identity: IDENTITY,
		rms,
		threshold: THRESHOLD,
		nowMs: fromMs + i * TICK_MS,
	}));
}

function boosts(commands: ReadonlyArray<VoiceRemoteSpeakingCommand>): Array<number> {
	return commands.flatMap((command) => (command.type === 'setPlaybackBoost' ? [command.boost] : []));
}

function attachedSnapshot(): VoiceRemoteSpeakingSnapshot {
	return run(createVoiceRemoteSpeakingSnapshot(), [{type: 'remote.attach', identity: IDENTITY, track: {}}]).snapshot;
}

describe('voiceRemoteSpeakingStateMachine playback boost', () => {
	it('clears an existing boost in v2 while preserving speaking analysis', () => {
		const legacy = run(attachedSnapshot(), ticks(0, 100, 0.003));
		expect(legacy.snapshot.context.analysers.get(IDENTITY)!.appliedBoost).toBeGreaterThan(1);
		const v2 = run(
			legacy.snapshot,
			ticks(2000, 100, 0.003).map((event) => ({...event, pipelineV2Enabled: true})),
		);
		expect(boosts(v2.commands)).toEqual([]);
		expect(v2.commands).toContainEqual({type: 'clearPlaybackBoost', identity: IDENTITY});
		expect(v2.snapshot.context.analysers.get(IDENTITY)).toMatchObject({
			speaking: true,
			appliedBoost: 1,
			playbackBoost: 1,
		});
	});
	it('clears boost on the first silent tick after v2 activation without waiting for silence release', () => {
		const legacy = run(attachedSnapshot(), ticks(0, 100, 0.003));
		const v2 = run(
			legacy.snapshot,
			ticks(2000, 1, 0).map((event) => ({...event, pipelineV2Enabled: true})),
		);
		expect(v2.commands).toEqual([{type: 'clearPlaybackBoost', identity: IDENTITY}]);
		expect(v2.snapshot.context.analysers.size).toBe(1);
	});
	it('does not install playback boost when a v2 analyser attaches', () => {
		const result = run(createVoiceRemoteSpeakingSnapshot(), [
			{type: 'remote.attach', identity: IDENTITY, track: {}, pipelineV2Enabled: true},
		]);
		expect(result.commands).toEqual([{type: 'clearPlaybackBoost', identity: IDENTITY}]);
	});

	it('remote playback boost never exceeds 1.5', () => {
		const {commands} = run(attachedSnapshot(), ticks(0, 2000, 0.003));
		const applied = boosts(commands);
		expect(applied.length).toBeGreaterThan(1);
		expect(Math.max(...applied)).toBeLessThanOrEqual(1.5);
	});

	it('boost resets to 1 when silent tail ends', () => {
		const speaking = run(attachedSnapshot(), ticks(0, 2000, 0.003));
		expect(speaking.snapshot.context.analysers.get(IDENTITY)!.playbackBoost).toBeGreaterThan(1);
		const silent = run(speaking.snapshot, ticks(2000 * TICK_MS, 2000, 0));
		const entry = silent.snapshot.context.analysers.get(IDENTITY)!;
		expect(entry.playbackBoost).toBe(1);
		expect(entry.appliedBoost).toBe(1);
		expect(silent.commands.at(-1)).toEqual({type: 'clearPlaybackBoost', identity: IDENTITY});
	});
});
