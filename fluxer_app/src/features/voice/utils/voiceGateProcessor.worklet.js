const FLOOR_PERCENTILE = 0.1;
const FLOOR_BIAS = 1.5;
const FLOOR_WINDOW_SECONDS = 2;
const SEED_SECONDS = 0.3;
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.02;

class VoiceGateProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const config = options.processorOptions;
		this.tuning = config.tuning;
		this.apply = config.apply;
		this.auto = config.auto;
		this.manualThresholdRms = config.manualThresholdRms;
		this.minRms = config.minRms;
		this.maxRms = config.maxRms;
		this.releaseFrames = Math.round((config.releaseMs / 1000) * sampleRate);
		this.channelCount = config.channelCount;
		this.delayFrames = this.channelCount === 1 ? Math.round((this.tuning.gateLookaheadMs / 1000) * sampleRate) : 0;
		this.delay = new Float32Array(this.delayFrames);
		this.delayIndex = 0;
		this.energy = new Float64Array(4);
		this.energyIndex = 0;
		this.energyCount = 0;
		this.energySum = 0;
		this.histogram = new Uint16Array(240);
		this.floorBins = new Uint8Array(Math.ceil((FLOOR_WINDOW_SECONDS * sampleRate) / 128));
		this.floorIndex = 0;
		this.floorCount = 0;
		this.silenceFrames = 0;
		this.frame = 0;
		this.seedUntilFrame = SEED_SECONDS * sampleRate;
		this.reportFrame = 0;
		this.gain = this.auto || !this.apply ? 1 : 0;
		this.attackStep = 1 / (ATTACK_SECONDS * sampleRate);
		this.releaseFactor = Math.exp(-1 / (RELEASE_SECONDS * sampleRate));
		this.speaking = false;
		this.nonFinite = false;
		this.disposed = false;
		this.processingMs = 0;
		this.processedFrames = 0;
		this.vadFailed = false;
		this.configureVad(config.pipelineV2Enabled);
		this.port.onmessage = ({data}) => {
			if (data.type === 'disable-vad' && !this.vadFailed) this.failVad();
			if (data.type === 'dispose') {
				this.disposed = true;
				this.releaseVad();
			}
			if (data.type === 'reset') this.resetFloor();
			if (data.type !== 'config') return;
			this.apply = data.apply;
			this.auto = data.auto;
			this.manualThresholdRms = data.manualThresholdRms;
			if (data.tuning) this.tuning = data.tuning;
			this.configureVad(data.pipelineV2Enabled);
		};
	}

	releaseVad() {
		if (!this.vad) return;
		this.vad._rnnoise_destroy(this.vadState);
		this.vad._free(this.vadPointer);
		this.vad = null;
	}

	configureVad(enabled) {
		this.pipelineV2Enabled = enabled === true && this.channelCount === 1 && sampleRate === 48000;
		if (!this.pipelineV2Enabled) {
			this.releaseVad();
			return;
		}
		if (this.vad || this.vadFailed || !globalThis.fluxerCreateVoiceVad) return;
		try {
			this.vad = globalThis.fluxerCreateVoiceVad();
			this.vadState = this.vad._rnnoise_create(0);
			this.vadPointer = this.vad._malloc(480 * 4);
			if (!this.vadState || !this.vadPointer) throw new Error('VAD allocation failed');
			this.vadIndex = 0;
			this.probability = 0;
			this.sideHigh = 0;
			this.sidePrevious = 0;
			this.sideLow = 0;
			this.highFactor = Math.exp((-2 * Math.PI * this.tuning.gateHighpassHz) / sampleRate);
			this.lowFactor = 1 - Math.exp((-2 * Math.PI * this.tuning.gateLowpassHz) / sampleRate);
			this.speaking = false;
			this.silenceFrames = 0;
			if (this.apply) this.gain = 0;
		} catch {
			this.failVad();
		}
	}

	failVad() {
		this.vadFailed = true;
		try {
			this.releaseVad();
		} catch {
			this.vad = null;
		}
		this.resetFloor();
		this.port.postMessage({type: 'vad-failure'});
	}

	resetFloor() {
		this.energy.fill(0);
		this.energySum = 0;
		this.energyCount = 0;
		this.histogram.fill(0);
		this.floorCount = 0;
		this.seedUntilFrame = this.frame + SEED_SECONDS * sampleRate;
		if (this.auto) {
			this.speaking = false;
			this.silenceFrames = 0;
			this.gain = this.vad && this.apply ? 0 : 1;
		}
	}

	trackFloor(rms) {
		const bin = Math.min(239, Math.max(0, Math.floor((20 * Math.log10(Math.max(1e-6, rms)) + 120) * 2)));
		if (this.floorCount === this.floorBins.length) this.histogram[this.floorBins[this.floorIndex]]--;
		else this.floorCount++;
		this.floorBins[this.floorIndex] = bin;
		this.floorIndex = (this.floorIndex + 1) % this.floorBins.length;
		this.histogram[bin]++;
		const target = Math.ceil(this.floorCount * FLOOR_PERCENTILE);
		let count = 0;
		let floorBin = 0;
		while (floorBin < 239) {
			count += this.histogram[floorBin];
			if (count >= target) break;
			floorBin++;
		}
		return Math.min(this.maxRms, Math.max(this.minRms / 3, 10 ** ((floorBin / 2 - 120) / 20) * FLOOR_BIAS));
	}

	process(inputs, outputs) {
		if (this.disposed) return false;
		const started = this.pipelineV2Enabled ? Date.now() : 0;
		const input = inputs[0];
		const output = outputs[0];
		const length = output[0]?.length ?? 128;
		let energy = 0;
		let sideEnergy = 0;
		for (let channel = 0; channel < output.length; channel++) {
			const source = input[channel];
			for (let index = 0; index < length; index++) {
				const sample = source?.[index] ?? 0;
				if (Number.isFinite(sample)) energy += sample * sample;
				else this.nonFinite = true;
				if (this.vad && channel === 0) {
					const value = Number.isFinite(sample) ? sample : 0;
					this.sideHigh = this.highFactor * (this.sideHigh + value - this.sidePrevious);
					this.sidePrevious = value;
					this.sideLow += this.lowFactor * (this.sideHigh - this.sideLow);
					sideEnergy += this.sideLow * this.sideLow;
					this.vad.HEAPF32[this.vadPointer / 4 + this.vadIndex++] = value * 32768;
					if (this.vadIndex === 480) {
						this.vadIndex = 0;
						try {
							this.probability = this.vad._rnnoise_process_frame(this.vadState, this.vadPointer, this.vadPointer);
							if (!Number.isFinite(this.probability) || this.probability < 0 || this.probability > 1) {
								throw new Error('Invalid VAD probability');
							}
						} catch {
							this.failVad();
						}
					}
				}
			}
		}
		energy /= Math.max(1, output.length * length);
		const decisionEnergy = this.vad ? sideEnergy / length : energy;
		this.energySum += decisionEnergy - this.energy[this.energyIndex];
		this.energy[this.energyIndex] = decisionEnergy;
		this.energyIndex = (this.energyIndex + 1) % this.energy.length;
		this.energyCount = Math.min(this.energy.length, this.energyCount + 1);
		const rms = Math.sqrt(Math.max(0, this.energySum / this.energyCount));
		const floorRms = this.trackFloor(rms);
		const thresholdRms = this.auto
			? Math.min(this.maxRms, Math.max(this.minRms, floorRms * 3))
			: this.manualThresholdRms;
		let activeSpeech = false;
		if (this.vad) {
			activeSpeech = this.speaking
				? this.probability >= this.tuning.gateRefreshProbability
				: this.probability >= this.tuning.gateOpenProbability && Math.sqrt(decisionEnergy) >= thresholdRms;
			if (activeSpeech) {
				this.speaking = true;
				this.silenceFrames = 0;
			} else {
				this.silenceFrames += length;
				if (this.silenceFrames >= (sampleRate * this.tuning.gateHangoverMs) / 1000) this.speaking = false;
			}
		} else if (this.auto && this.frame < this.seedUntilFrame) {
			this.speaking = false;
			this.silenceFrames = 0;
		} else if (Math.sqrt(energy) >= thresholdRms) {
			this.speaking = true;
			this.silenceFrames = 0;
		} else if (rms < thresholdRms * 0.7) {
			this.silenceFrames += length;
			if (this.silenceFrames >= this.releaseFrames) this.speaking = false;
		} else this.silenceFrames = 0;
		if (!this.vad) activeSpeech = this.speaking && Math.sqrt(energy) >= thresholdRms;
		const open = !this.apply || this.speaking || (!this.vad && this.auto && this.frame < this.seedUntilFrame);
		outputs[1]?.[0]?.fill(activeSpeech ? 1 : 0);
		for (let index = 0; index < length; index++) {
			this.gain = open ? Math.min(1, this.gain + this.attackStep) : this.gain * this.releaseFactor;
			for (let channel = 0; channel < output.length; channel++) {
				const value = input[channel]?.[index] ?? 0;
				const sample = Number.isFinite(value) ? value : 0;
				if (this.delayFrames > 0) {
					output[channel][index] = this.delay[this.delayIndex] * this.gain;
					this.delay[this.delayIndex] = sample;
				} else output[channel][index] = sample * this.gain;
			}
			if (this.delayFrames > 0) this.delayIndex = (this.delayIndex + 1) % this.delayFrames;
		}
		this.frame += length;
		if (this.pipelineV2Enabled) {
			this.processingMs += Date.now() - started;
			this.processedFrames += length;
		}
		if (this.frame >= this.reportFrame) {
			this.port.postMessage({
				type: 'level',
				rms,
				floorRms,
				thresholdRms,
				nonFinite: this.nonFinite,
				frame: this.frame,
				contextTime: currentTime,
				...(this.pipelineV2Enabled
					? {processingMs: this.processingMs, audioMs: (this.processedFrames / sampleRate) * 1000}
					: {}),
			});
			this.reportFrame = this.frame + sampleRate / 15;
			this.nonFinite = false;
		}
		return true;
	}
}

registerProcessor('fluxer-voice-gate', VoiceGateProcessor);
