// SPDX-License-Identifier: AGPL-3.0-or-later

import {access, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {release} from 'node:os';
import {join} from 'node:path';
import {app} from 'electron';
import log from 'electron-log';

const requireModule = createRequire(import.meta.url);
let requestAttempt: Promise<void> | undefined;

export async function ensureWindowsCaptureBorderAccess(): Promise<void> {
	// Borderless consent requires package identity; Setup.exe keeps the border.
	if (process.platform !== 'win32' || !process.windowsStore || !(Number(release().split('.')[2]) >= 20348)) return;
	requestAttempt ??= requestOnce().catch((error) => {
		log.warn('[WindowsCaptureBorder] Borderless consent unavailable; continuing capture:', error);
	});
	await requestAttempt;
}

async function requestOnce(): Promise<void> {
	const marker = join(app.getPath('userData'), 'capture-borderless-requested-v1');
	try {
		await access(marker);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const addon = requireModule('@fluxer/win-game-capture') as {requestBorderlessAccess(): Promise<boolean>};
	// Persist before asking: denial, process exit and write failure must not cause
	// repeated prompts on the next share or launch.
	await writeFile(marker, '1', {encoding: 'utf8', flag: 'wx'});
	await addon.requestBorderlessAccess();
}
