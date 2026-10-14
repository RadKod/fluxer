// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';
import Availability from './NoiseSuppressionAvailability';

describe('pipeline CPU budget', () => {
	beforeEach(() => {
		Availability.failures.clear();
		Availability.releaseExpiredFailures(Date.now(), true);
		Availability.setDeepFilterAssetState('ready');
		Availability.setVoiceInputGraphUnavailable(false);
		Availability.setInputContextRate(48000);
	});
	it('adds filter and gate work in three fresh complete windows', () => {
		const graph = {};
		Availability.configureProcessingHealth(graph, 'deep_filter', ['filter', 'gate']);
		for (let window = 0; window <= 3; window++) {
			const audio = 500 + window * 500;
			Availability.reportProcessingHealth('deep_filter', window * 300, audio, true, 'filter', graph);
			Availability.reportProcessingHealth('deep_filter', window * 250, audio, true, 'gate', graph);
			if (window < 3) expect(Availability.failures.has('deep_filter')).toBe(false);
		}
		expect(Availability.getFallback('deep_filter')).toBe('cpu_budget');
	});
	it('counts gain and waits for fresh slow-source audio despite repeated fast-source reports', () => {
		const graph = {};
		Availability.configureProcessingHealth(graph, 'rnnoise', ['filter', 'gate', 'gain']);
		for (const source of ['filter', 'gate', 'gain'] as const)
			Availability.reportProcessingHealth('rnnoise', 0, 500, true, source, graph);
		for (let window = 1; window <= 3; window++) {
			for (let part = 1; part <= 5; part++) {
				const elapsed = (window - 1) * 500 + part * 100;
				Availability.reportProcessingHealth('rnnoise', elapsed * 0.3, 500 + elapsed, true, 'gate', graph);
				Availability.reportProcessingHealth('rnnoise', elapsed * 0.2, 500 + elapsed, true, 'gain', graph);
			}
			expect(Availability.failures.has('rnnoise')).toBe(false);
			Availability.reportProcessingHealth('rnnoise', window * 200, 500 + window * 500, true, 'filter', graph);
		}
		expect(Availability.getFallback('rnnoise')).toBe('cpu_budget');
	});
	it('does not reuse load after graph, backend or same-backend slot replacement', () => {
		const graph = {};
		Availability.configureProcessingHealth(graph, 'deep_filter', ['filter', 'gate']);
		for (let window = 0; window <= 2; window++) {
			for (const source of ['filter', 'gate'] as const)
				Availability.reportProcessingHealth('deep_filter', window * 300, 500 + window * 500, true, source, graph);
		}
		const preview = {};
		Availability.configureProcessingHealth(preview, 'deep_filter', ['filter', 'gate']);
		for (const source of ['filter', 'gate'] as const)
			Availability.reportProcessingHealth('deep_filter', 3000, 5000, true, source, preview);
		expect(Availability.failures.has('deep_filter')).toBe(false);
		Availability.configureProcessingHealth(graph, 'deep_filter', ['filter', 'gate'], true);
		for (const source of ['filter', 'gate'] as const)
			Availability.reportProcessingHealth('deep_filter', 900, 2000, true, source, graph);
		expect(Availability.failures.has('deep_filter')).toBe(false);
		Availability.configureProcessingHealth(graph, 'rnnoise', ['filter', 'gate']);
		for (const source of ['filter', 'gate'] as const)
			Availability.reportProcessingHealth('rnnoise', 1000, 2500, true, source, graph);
		expect(Availability.failures.has('rnnoise')).toBe(false);
	});
	it('latches pipeline failure across capture restarts and notifies once until a new call', () => {
		const notify = vi.fn();
		const dispose = Availability.subscribe(notify);
		try {
			Availability.markPipelineV2Failed();
			Availability.markPipelineV2Failed();
			expect(Availability.pipelineV2Failed).toBe(true);
			expect(notify).toHaveBeenCalledOnce();
			Availability.releaseExpiredFailures(Date.now());
			expect(Availability.pipelineV2Failed).toBe(true);
			Availability.releaseExpiredFailures(Date.now(), true);
			expect(Availability.pipelineV2Failed).toBe(false);
			expect(notify).toHaveBeenCalledTimes(2);
		} finally {
			dispose();
		}
	});

	it('drops DeepFilter to RNNoise, then standard, only for v2', () => {
		Availability.markBackendFailed('deep_filter', 'cpu_budget', 0);
		expect(Availability.resolveEffectiveBackend('deep_filter', true)).toBe('rnnoise');
		expect(Availability.resolveEffectiveBackend('deep_filter')).toBe('standard');
		expect(Availability.getFallback('deep_filter')).toBe('cpu_budget');
		Availability.markBackendFailed('rnnoise', 'cpu_budget', 0);
		expect(Availability.resolveEffectiveBackend('deep_filter', true)).toBe('standard');
	});

	it('needs three consecutive excessive windows and ignores legacy reports', () => {
		for (let i = 1; i <= 3; i++) Availability.reportProcessingHealth('deep_filter', i * 450, i * 500, false);
		expect(Availability.failures.has('deep_filter')).toBe(false);
		Availability.reportProcessingHealth('deep_filter', 450, 500, true);
		Availability.reportProcessingHealth('deep_filter', 500, 1000, true);
		Availability.reportProcessingHealth('deep_filter', 950, 1500, true);
		Availability.reportProcessingHealth('deep_filter', 1400, 2000, true);
		expect(Availability.failures.has('deep_filter')).toBe(false);
		const notify = vi.fn();
		const unsubscribe = Availability.subscribe(notify);
		Availability.reportProcessingHealth('deep_filter', 1850, 2500, true);
		expect(Availability.getFallback('deep_filter')).toBe('cpu_budget');
		expect(notify).toHaveBeenCalledOnce();
		unsubscribe();
	});

	it('does not clear CPU failures on successful node builds; new sessions can retry', () => {
		Availability.markBackendFailed('deep_filter', 'cpu_budget', 0);
		Availability.clearBackendFailure('deep_filter');
		expect(Availability.resolveEffectiveBackend('deep_filter', true)).toBe('rnnoise');
		Availability.releaseExpiredFailures(60_000);
		expect(Availability.resolveEffectiveBackend('deep_filter', true)).toBe('rnnoise');
		Availability.releaseExpiredFailures(100, true);
		expect(Availability.resolveEffectiveBackend('deep_filter', true)).toBe('deep_filter');
	});
	it('keeps gate totals separate and reports standard overload without failing browser capture', () => {
		Availability.reportProcessingHealth('deep_filter', 450, 500, true);
		Availability.reportProcessingHealth('deep_filter', 450, 500, true, 'gate');
		Availability.reportProcessingHealth('deep_filter', 900, 1000, true);
		expect(Availability.failures.has('deep_filter')).toBe(false);
		Availability.reportProcessingHealth('standard', 450, 500, true, 'gate');
		Availability.reportProcessingHealth('standard', 900, 1000, true, 'gate');
		expect(Availability.reportProcessingHealth('standard', 1350, 1500, true, 'gate')).toBe(true);
		expect(Availability.failures.has('standard')).toBe(false);
	});
	it('does not combine preview and call CPU report streaks', () => {
		const call = {};
		const preview = {};
		Availability.reportProcessingHealth('deep_filter', 450, 500, true, 'gate', call);
		Availability.reportProcessingHealth('deep_filter', 900, 1000, true, 'gate', preview);
		Availability.reportProcessingHealth('deep_filter', 1350, 1500, true, 'gate', call);
		expect(Availability.failures.has('deep_filter')).toBe(false);
		Availability.reportProcessingHealth('deep_filter', 1800, 2000, true, 'gate', call);
		expect(Availability.getFallback('deep_filter')).toBe('cpu_budget');
	});
});
