// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	coreLoads: 0,
	turkishLoads: 0,
	frenchLoads: 0,
	coreGate: Promise.resolve(),
	locale: 'en-US',
	synthesize: vi.fn(),
	loadVoice: vi.fn(),
	acquireContext: vi.fn(),
}));

function mockEngine(): void {
	vi.doMock('mespeak', async () => {
		state.coreLoads += 1;
		await state.coreGate;
		return {
			default: {
				isConfigLoaded: () => true,
				loadConfig: vi.fn(),
				loadVoice: state.loadVoice,
				speak: state.synthesize,
			},
		};
	});
}
vi.mock('mespeak/voices/en/en-us.json', () => ({default: {voice_id: 'en/en-us'}}));
vi.mock('mespeak/voices/tr.json', () => {
	state.turkishLoads += 1;
	return {default: {voice_id: 'tr'}};
});
vi.mock('mespeak/voices/fr.json', () => {
	state.frenchLoads += 1;
	return {default: {voice_id: 'fr'}};
});
vi.mock('@app/features/notification/utils/SoundUtils', () => ({
	acquireOutputAudioContext: state.acquireContext,
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
	},
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {ttsRate: 1}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/messaging/state/MessageReferences', () => ({default: {}, MessageReferenceState: {}}));
vi.mock('@app/features/messaging/utils/SystemMessageUtils', () => ({SystemMessageUtils: {}}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {currentChannelId: null}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {}}));
vi.mock('@app/features/ui/state/Notification', () => ({default: {}, TTSNotificationMode: {}}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getNativePlatformSync: () => null,
	isChromiumBrowser: () => false,
}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {}}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {
		get locale() {
			return state.locale;
		},
	},
}));
vi.mock('@app/features/user/state/Users', () => ({default: {}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({}));
vi.mock('@app/features/voice/utils/TtsTextFormatter', () => ({formatMessageForTts: vi.fn()}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

let voiceTts: typeof import('./VoiceTtsUtils')['default'];
let source: {
	onended: (() => void) | null;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
	vi.resetModules();
	mockEngine();
	state.coreLoads = 0;
	state.turkishLoads = 0;
	state.frenchLoads = 0;
	state.coreGate = Promise.resolve();
	state.locale = 'en-US';
	state.synthesize.mockReset().mockImplementation(() => new ArrayBuffer(8));
	state.loadVoice.mockReset();
	source = {onended: null, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn()};
	state.acquireContext.mockReset().mockResolvedValue({
		state: 'running',
		decodeAudioData: async () => ({}),
		createBufferSource: () => source,
		createGain: () => ({gain: {value: 0}, connect: vi.fn(), disconnect: vi.fn()}),
		destination: {},
	});
	Object.defineProperty(window, 'speechSynthesis', {value: undefined, configurable: true});
	vi.stubGlobal('AudioContext', class {});
	voiceTts = (await import('./VoiceTtsUtils')).default;
});

afterEach(() => voiceTts.dispose());

describe('lazy TTS fallback', () => {
	it('loads the engine on first speech, finishes playback and keeps initialization cold', async () => {
		voiceTts.init();
		expect(voiceTts.isUsingFallback()).toBe(true);
		expect(state.coreLoads).toBe(0);
		const onEnd = vi.fn();
		voiceTts.speak('Hello', {onEnd});
		await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
		expect(state.coreLoads).toBe(1);
		expect(state.synthesize).toHaveBeenCalledWith('Hello', {rawdata: true, voice: 'en/en-us', speed: 175});
		expect(voiceTts.isSpeaking()).toBe(true);
		source.onended?.();
		expect(onEnd).toHaveBeenCalledOnce();
		expect(voiceTts.isSpeaking()).toBe(false);
	});

	it('loads Turkish on demand, reuses it and loads French only after a locale change', async () => {
		state.locale = 'tr-TR';
		voiceTts.speak('Merhaba');
		await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
		expect(state.turkishLoads).toBe(1);
		expect(state.frenchLoads).toBe(0);
		expect(state.synthesize).toHaveBeenLastCalledWith('Merhaba', {rawdata: true, voice: 'tr', speed: 175});
		voiceTts.speak('Tekrar');
		await vi.waitFor(() => expect(source.start).toHaveBeenCalledTimes(2));
		expect(state.loadVoice).toHaveBeenCalledTimes(1);
		state.locale = 'fr-FR';
		voiceTts.speak('Bonjour');
		await vi.waitFor(() => expect(source.start).toHaveBeenCalledTimes(3));
		expect(state.frenchLoads).toBe(1);
		expect(state.synthesize).toHaveBeenLastCalledWith('Bonjour', {rawdata: true, voice: 'fr', speed: 175});
	});

	it('uses the default voice for unsupported locales and applies the requested rate', async () => {
		state.locale = 'unknown-ZZ';
		voiceTts.speak('Hello', {rate: 2});
		await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
		expect(state.synthesize).toHaveBeenCalledWith('Hello', {rawdata: true, voice: 'en/en-us', speed: 350});
		expect(state.turkishLoads + state.frenchLoads).toBe(0);
	});

	it('reports a failed lazy engine import through the existing unsupported callback', async () => {
		state.coreGate = Promise.reject(new Error('chunk unavailable'));
		// Attach a handler before the asynchronous module factory observes it.
		void state.coreGate.catch(() => {});
		const onError = vi.fn();
		voiceTts.speak('Hello', {onError});
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('unsupported'));
		expect(source.start).not.toHaveBeenCalled();
		expect(voiceTts.isSpeaking()).toBe(false);
	});

	it('reports synthesis failure without starting playback', async () => {
		state.synthesize.mockImplementation(() => {
			throw new Error('voice unavailable');
		});
		const onError = vi.fn();
		voiceTts.speak('Hello', {onError});
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('synthesis-failed'));
		expect(source.start).not.toHaveBeenCalled();
	});

	it('does not synthesize or call completion after cancel during lazy engine loading', async () => {
		let release!: () => void;
		state.coreGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onEnd = vi.fn();
		voiceTts.speak('Canceled speech', {onEnd});
		await vi.waitFor(() => expect(state.coreLoads).toBe(1));
		voiceTts.stop();
		release();
		await import('./EspeakTtsFallback');
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(state.synthesize).not.toHaveBeenCalled();
		expect(source.start).not.toHaveBeenCalled();
		expect(onEnd).not.toHaveBeenCalled();
	});

	it('stops active playback and clears its completion callback on cancel', async () => {
		const onEnd = vi.fn();
		voiceTts.speak('Hello', {onEnd});
		await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
		voiceTts.stop();
		expect(source.stop).toHaveBeenCalledOnce();
		expect(source.onended).toBeNull();
		expect(voiceTts.isSpeaking()).toBe(false);
		expect(onEnd).not.toHaveBeenCalled();
	});
});
