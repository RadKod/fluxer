// SPDX-License-Identifier: AGPL-3.0-or-later

// Radix-2 FFT and a masked STFT round trip, used only by the spectral pinch harmonic (approach C) at load time.

// In place; `inverse` also divides by n.
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const angle = ((inverse ? 2 : -2) * Math.PI) / size;
		const wRe = Math.cos(angle);
		const wIm = Math.sin(angle);
		for (let start = 0; start < n; start += size) {
			let curRe = 1;
			let curIm = 0;
			for (let k = 0; k < size / 2; k++) {
				const a = start + k;
				const b = a + size / 2;
				const tRe = re[b] * curRe - im[b] * curIm;
				const tIm = re[b] * curIm + im[b] * curRe;
				re[b] = re[a] - tRe;
				im[b] = im[a] - tIm;
				re[a] += tRe;
				im[a] += tIm;
				const nextRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nextRe;
			}
		}
	}
	if (inverse) {
		for (let i = 0; i < n; i++) {
			re[i] /= n;
			im[i] /= n;
		}
	}
}

// Hann-windowed STFT, a real gain per bin (index 0..size/2), then weighted overlap-add back, as scipy's stft/istft
// pair does with zero boundary padding. `gainForBin` must give the same gain to a bin and its mirror.
export function stftMask(
	signal: Float32Array,
	size: number,
	hop: number,
	gainForBin: (bin: number) => number,
): Float32Array<ArrayBuffer> {
	const pad = size / 2;
	const padded = new Float64Array(signal.length + 2 * pad + size);
	padded.set(signal, pad);
	const out = new Float64Array(padded.length);
	const norm = new Float64Array(padded.length);
	const window = new Float64Array(size);
	for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
	const gains = new Float64Array(size / 2 + 1);
	for (let bin = 0; bin <= size / 2; bin++) gains[bin] = gainForBin(bin);
	const re = new Float64Array(size);
	const im = new Float64Array(size);
	for (let start = 0; start + size <= padded.length; start += hop) {
		for (let i = 0; i < size; i++) {
			re[i] = padded[start + i] * window[i];
			im[i] = 0;
		}
		fft(re, im);
		for (let bin = 0; bin < size; bin++) {
			const gain = gains[bin <= size / 2 ? bin : size - bin];
			re[bin] *= gain;
			im[bin] *= gain;
		}
		fft(re, im, true);
		for (let i = 0; i < size; i++) {
			out[start + i] += re[i] * window[i];
			norm[start + i] += window[i] * window[i];
		}
	}
	const result = new Float32Array(signal.length);
	for (let i = 0; i < signal.length; i++) {
		const n = norm[i + pad];
		result[i] = n > 1e-10 ? out[i + pad] / n : 0;
	}
	return result;
}
