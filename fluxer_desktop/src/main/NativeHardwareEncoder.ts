// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRequire} from 'node:module';
import {createChildLogger} from '@electron/common/Logger';
import {VOICE_ENGINE_V2_HARDWARE_ENCODER_IPC_CHANNEL} from '@fluxer/voice_engine_v2/bridge';
import type {VoiceEngineV2HardwareEncoderCapabilities} from '@fluxer/voice_engine_v2/src/protocol/types';
import {ipcMain} from 'electron';

type VoiceEngineV2BridgeHardwareEncoderCapabilities = VoiceEngineV2HardwareEncoderCapabilities;

// sanalyer: upstream removed these two helpers from the bridge package; the shell keeps them here, unchanged, since
// the native addon's answer still has to be shaped before it crosses IPC.
function unavailableVoiceEngineV2BridgeHardwareEncoderCapabilities(
	reason: NonNullable<VoiceEngineV2BridgeHardwareEncoderCapabilities['reason']>,
	detail?: string,
): VoiceEngineV2BridgeHardwareEncoderCapabilities {
	return {
		available: false,
		backend: 'none',
		compiled: false,
		runtime: false,
		codecs: [],
		zeroCopy: false,
		nativeInputs: [],
		reason,
		...(detail ? {detail} : {}),
	};
}

function normalizeVoiceEngineV2BridgeHardwareEncoderCapabilities(
	value: unknown,
): VoiceEngineV2BridgeHardwareEncoderCapabilities {
	if (typeof value !== 'object' || value === null) {
		return unavailableVoiceEngineV2BridgeHardwareEncoderCapabilities(
			'query-failed',
			'Native addon returned an invalid result',
		);
	}
	const candidate = value as Partial<VoiceEngineV2BridgeHardwareEncoderCapabilities>;
	const backend = typeof candidate.backend === 'string' && candidate.backend.length > 0 ? candidate.backend : 'none';
	return {
		available: candidate.available === true,
		backend,
		compiled: candidate.compiled === true,
		runtime: candidate.runtime === true,
		codecs: Array.isArray(candidate.codecs) ? candidate.codecs.filter((codec) => typeof codec === 'string') : [],
		zeroCopy: candidate.zeroCopy === true,
		nativeInputs: Array.isArray(candidate.nativeInputs)
			? candidate.nativeInputs.filter((input) => typeof input === 'string')
			: [],
		...(typeof candidate.reason === 'string' ? {reason: candidate.reason} : {}),
		...(typeof candidate.detail === 'string' ? {detail: candidate.detail} : {}),
	};
}

const logger = createChildLogger('NativeHardwareEncoder');
const requireModule = createRequire(import.meta.url);

interface HardwareEncoderModule {
	getHardwareEncoderCapabilities?: () => unknown;
}

let cachedModule: HardwareEncoderModule | null | undefined;
let cachedModuleLoadErrorDetail: string | undefined;

function loadHardwareEncoderModule(): HardwareEncoderModule | null {
	if (cachedModule !== undefined) return cachedModule;
	cachedModuleLoadErrorDetail = undefined;
	try {
		cachedModule = requireModule('@fluxer/hardware-encoder') as HardwareEncoderModule;
	} catch (error) {
		logger.warn('Failed to load @fluxer/hardware-encoder', error);
		cachedModuleLoadErrorDetail = error instanceof Error ? error.message : String(error);
		cachedModule = null;
	}
	return cachedModule;
}

function getHardwareEncoderCapabilities(): VoiceEngineV2BridgeHardwareEncoderCapabilities {
	const mod = loadHardwareEncoderModule();
	if (!mod) {
		return unavailableVoiceEngineV2BridgeHardwareEncoderCapabilities('load-failed', cachedModuleLoadErrorDetail);
	}
	if (typeof mod.getHardwareEncoderCapabilities !== 'function') {
		return unavailableVoiceEngineV2BridgeHardwareEncoderCapabilities('unsupported-addon-version');
	}
	try {
		return normalizeVoiceEngineV2BridgeHardwareEncoderCapabilities(mod.getHardwareEncoderCapabilities());
	} catch (error) {
		logger.warn('Native hardware encoder getHardwareEncoderCapabilities() threw', error);
		const detail = error instanceof Error ? error.message : String(error);
		return unavailableVoiceEngineV2BridgeHardwareEncoderCapabilities('query-failed', detail);
	}
}

let handlersRegistered = false;

export function registerNativeHardwareEncoderHandlers(): void {
	if (handlersRegistered) return;
	handlersRegistered = true;
	ipcMain.handle(
		VOICE_ENGINE_V2_HARDWARE_ENCODER_IPC_CHANNEL,
		(): VoiceEngineV2BridgeHardwareEncoderCapabilities => getHardwareEncoderCapabilities(),
	);
}

export function cleanupNativeHardwareEncoderHandlers(): void {
	if (!handlersRegistered) return;
	ipcMain.removeHandler(VOICE_ENGINE_V2_HARDWARE_ENCODER_IPC_CHANNEL);
	handlersRegistered = false;
}
