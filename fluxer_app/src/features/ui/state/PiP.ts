// SPDX-License-Identifier: AGPL-3.0-or-later

import {AppStorageKey} from '@app/features/platform/state/AppStorageKeys';
import AppStorage from '@app/features/platform/state/PersistentStorage';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {makeAutoObservable, runInAction} from 'mobx';

type PiPCorner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left';

const PIP_DEFAULT_WIDTH = 320;
// The voice activity is played in its mini window, so it opens wider than a stream and keeps its own width.
const PIP_ACTIVITY_DEFAULT_WIDTH = 400;

interface StreamPiPContent {
	type: 'stream';
	participantIdentity: string;
	channelId: string;
	guildId: string | null;
	connectionId: string;
	userId: string;
}

// The voice activity I take part in, followed out of the call.
interface ActivityPiPContent {
	type: 'activity';
	channelId: string;
	guildId: string | null;
	sessionId: string;
}

type PiPContent = StreamPiPContent | ActivityPiPContent;
type PiPContentType = PiPContent['type'];

const PIP_CORNER_STORAGE_KEY = 'pip_corner';
const PIP_WIDTH_STORAGE_KEY = 'pip_width';
const PIP_CORNERS: ReadonlyArray<PiPCorner> = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const logger = new Logger('PiP');

function isPiPCorner(value: string | null): value is PiPCorner {
	if (!value) return false;
	return PIP_CORNERS.includes(value as PiPCorner);
}

function parsePiPWidth(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

class PiP {
	isOpen = false;
	content: PiPContent | null = null;
	corner: PiPCorner = 'bottom-right';
	// The activity's mini window has its own place, top right by default, as the call's design shows it.
	activityCorner: PiPCorner = 'top-right';
	sessionDisable = false;
	width = PIP_DEFAULT_WIDTH;
	activityWidth = PIP_ACTIVITY_DEFAULT_WIDTH;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		const storedCorner = AppStorage.getItem(PIP_CORNER_STORAGE_KEY);
		if (isPiPCorner(storedCorner)) {
			this.corner = storedCorner;
		}
		const storedActivityCorner = AppStorage.getItem(AppStorageKey.UI_PIP_ACTIVITY_CORNER);
		if (isPiPCorner(storedActivityCorner)) {
			this.activityCorner = storedActivityCorner;
		}
		const storedWidth = parsePiPWidth(AppStorage.getItem(PIP_WIDTH_STORAGE_KEY));
		if (storedWidth != null) {
			this.width = storedWidth;
		}
		const storedActivityWidth = parsePiPWidth(AppStorage.getItem(AppStorageKey.UI_PIP_ACTIVITY_WIDTH));
		if (storedActivityWidth != null) {
			this.activityWidth = storedActivityWidth;
		}
	}

	open(content: PiPContent): void {
		logger.debug('Opening PiP', {previousContent: this.content, content});
		runInAction(() => {
			this.isOpen = true;
			this.content = content;
		});
	}

	close(): void {
		logger.debug('Closing PiP', {previousContent: this.content, wasOpen: this.isOpen});
		runInAction(() => {
			this.isOpen = false;
			this.content = null;
		});
	}

	clearForChannel(channelId: string): void {
		logger.debug('Clearing PiP for channel', {
			channelId,
			previousContent: this.content,
			wasOpen: this.isOpen,
			willClear: this.content?.channelId === channelId,
		});
		runInAction(() => {
			if (this.content?.channelId === channelId) {
				this.isOpen = false;
				this.content = null;
			}
		});
	}

	setSessionDisable(value: boolean): void {
		logger.debug('Setting PiP session disable', {previousValue: this.sessionDisable, value});
		runInAction(() => {
			this.sessionDisable = value;
		});
	}

	setCorner(corner: PiPCorner, type: PiPContentType = 'stream'): void {
		runInAction(() => {
			if (type === 'activity') this.activityCorner = corner;
			else this.corner = corner;
		});
		AppStorage.setItem(type === 'activity' ? AppStorageKey.UI_PIP_ACTIVITY_CORNER : PIP_CORNER_STORAGE_KEY, corner);
	}

	setWidth(width: number, type: PiPContentType = 'stream'): void {
		runInAction(() => {
			if (type === 'activity') this.activityWidth = width;
			else this.width = width;
		});
		AppStorage.setItem(type === 'activity' ? AppStorageKey.UI_PIP_ACTIVITY_WIDTH : PIP_WIDTH_STORAGE_KEY, `${width}`);
	}

	getContent(): PiPContent | null {
		return this.content;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	getEffectiveCorner(type: PiPContentType = 'stream'): PiPCorner {
		return type === 'activity' ? this.activityCorner : this.corner;
	}

	getSessionDisable(): boolean {
		return this.sessionDisable;
	}

	getWidth(type: PiPContentType = 'stream'): number {
		return type === 'activity' ? this.activityWidth : this.width;
	}
}

export type {ActivityPiPContent, PiPContent, PiPContentType, StreamPiPContent};
export {PIP_ACTIVITY_DEFAULT_WIDTH, PIP_DEFAULT_WIDTH};

export default new PiP();
