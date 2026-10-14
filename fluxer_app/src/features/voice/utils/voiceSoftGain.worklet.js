// SPDX-License-Identifier: AGPL-3.0-or-later
class VoiceSoftGainProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this.tuning = options.processorOptions.tuning;
		this.gainDb = 0;
		this.energy = 0;
		this.disposed = false;
		this.healthEnabled = false;
		this.processingMs = 0;
		this.audioFrames = 0;
		this.reportFrames = sampleRate / 2;
		this.port.onmessage = ({data}) => {
			if (data.type === 'configure-health' && this.healthEnabled !== (data.enabled === true)) {
				this.healthEnabled = data.enabled === true;
				this.processingMs = 0;
				this.audioFrames = 0;
				this.reportFrames = sampleRate / 2;
			}
			if (data.type === 'config') this.tuning = data.tuning;
			if (data.type === 'dispose') this.disposed = true;
			if (data.type === 'reset') {
				this.gainDb = 0;
				this.energy = 0;
			}
		};
	}

	process(inputs, outputs) {
		if (this.disposed) return false;
		const started = this.healthEnabled ? Date.now() : 0;
		const input = inputs[0]?.[0];
		const speech = inputs[1]?.[0];
		const output = outputs[0][0];
		let activeEnergy = 0;
		let activeSamples = 0;
		for (let i = 0; i < output.length; i++) {
			if (speech?.[i] > 0.5 && Number.isFinite(input?.[i])) {
				activeEnergy += input[i] * input[i];
				activeSamples++;
			}
		}
		let targetDb = this.gainDb;
		if (activeSamples > 0) {
			const smoothing = Math.exp(-activeSamples / (sampleRate * this.tuning.gainTimeConstantSeconds));
			this.energy = smoothing * this.energy + ((1 - smoothing) * activeEnergy) / activeSamples;
			if (this.energy > 1e-12) {
				targetDb = Math.min(this.tuning.gainMaxDb, this.tuning.gainTargetDbfs - 10 * Math.log10(this.energy));
			}
		}
		const stepDb = Math.max(
			-this.tuning.gainFallDbPerSecond / sampleRate,
			Math.min(this.tuning.gainRiseDbPerSecond / sampleRate, (targetDb - this.gainDb) / output.length),
		);
		const stepGain = 10 ** (stepDb / 20);
		let gain = 10 ** (this.gainDb / 20);
		for (let i = 0; i < output.length; i++) {
			const sample = Number.isFinite(input?.[i]) ? input[i] : 0;
			if (speech?.[i] > 0.5) {
				this.gainDb += stepDb;
				gain *= stepGain;
			}
			output[i] = sample * gain;
		}
		if (this.healthEnabled) {
			this.processingMs += Date.now() - started;
			this.audioFrames += output.length;
			if (this.audioFrames >= this.reportFrames) {
				this.port.postMessage({
					type: 'health',
					processingMs: this.processingMs,
					audioMs: (this.audioFrames / sampleRate) * 1000,
					contextTime: currentTime,
				});
				this.reportFrames = this.audioFrames + sampleRate / 2;
			}
		}
		return true;
	}
}
registerProcessor('fluxer-voice-soft-gain', VoiceSoftGainProcessor);
