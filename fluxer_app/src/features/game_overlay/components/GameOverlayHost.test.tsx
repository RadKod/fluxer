// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const settings = vi.hoisted(() => ({enabled: true, mode: 'room', corner: 'top-left'}));
const electron = vi.hoisted(() => ({setGameOverlayLayout: vi.fn()}));

vi.mock('@app/features/game_overlay/components/GameOverlayHost.module.css', () => ({
	default: new Proxy({}, {get: (_target, key) => String(key)}),
}));
vi.mock('@app/features/game_overlay/state/GameOverlaySettings', () => ({default: settings}));
vi.mock('@app/features/game_overlay/utils/GameOverlaySupport', () => ({isGameOverlaySupported: () => true}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => null}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
	},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({getElectronAPI: () => electron}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({getUserAvatarURL: () => 'avatar.png'}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: () => 'Ayşe'}));
vi.mock('@app/features/voice/components/popout/PopoutWindowDocument', () => ({
	copyStylesheetsIntoDocument: () => {},
	observeDocumentStylesheets: () => () => {},
	observeDocumentThemeAttributes: () => () => {},
	syncDocumentThemeAttributes: () => {},
}));
vi.mock('@app/features/voice/components/VoiceParticipantAvatarList', () => ({
	useVoiceParticipantAvatarEntries: () => [
		{userId: 'u1', connectionId: 'c1', speaking: false, selfMute: false, selfDeaf: false, user: {id: 'u1'}},
	],
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {connected: true, channelId: 'ch1', guildId: null},
	useMediaEngineVersion: () => 0,
}));

const {GameOverlayHost} = await import('@app/features/game_overlay/components/GameOverlayHost');

interface FakeChildWindow extends EventTarget {
	document: Document;
	closed: boolean;
	close: () => void;
}

let opened: Array<FakeChildWindow>;
let root: Root;

function openChildWindow(): FakeChildWindow {
	const child = Object.assign(new EventTarget(), {
		document: document.implementation.createHTMLDocument(''),
		closed: false,
		close: vi.fn(() => {
			child.closed = true;
			child.dispatchEvent(new Event('pagehide'));
		}),
	});
	opened.push(child);
	return child;
}

function overlayRoot(child: FakeChildWindow | undefined): Element | null {
	return child?.document.querySelector('[data-flx="game-overlay.game-overlay-host.root"]') ?? null;
}

function render(): void {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	root = createRoot(document.createElement('div'));
	act(() => root.render(createElement(GameOverlayHost)));
}

beforeEach(() => {
	opened = [];
	settings.corner = 'top-left';
	electron.setGameOverlayLayout.mockClear();
	vi.spyOn(window, 'open').mockImplementation(() => openChildWindow() as unknown as Window);
});

afterEach(() => {
	act(() => root.unmount());
	vi.restoreAllMocks();
});

describe('GameOverlayHost', () => {
	it.each(['bottom-left', 'bottom-right'])('pins the avatars to the window bottom in the %s corner', (corner) => {
		settings.corner = corner;
		render();
		expect(overlayRoot(opened[0])?.classList.contains('bottom')).toBe(true);
	});

	it.each(['top-left', 'top-right'])('keeps the avatars at the window top in the %s corner', (corner) => {
		settings.corner = corner;
		render();
		expect(overlayRoot(opened[0])?.classList.contains('bottom')).toBe(false);
	});

	it('fills the window height and aligns to its end in bottom corners', () => {
		const css = readFileSync('src/features/game_overlay/components/GameOverlayHost.module.css', 'utf8');
		expect(css).toMatch(/\.bottom \{\s*height: 100vh;\s*justify-content: flex-end;\s*\}/);
	});

	it('opens the overlay window again when it goes away under it and sends its layout again', () => {
		const layout = {visible: true, corner: 'top-left', width: 154, height: 40};
		render();
		expect(electron.setGameOverlayLayout).toHaveBeenLastCalledWith(layout);
		electron.setGameOverlayLayout.mockClear();

		act(() => {
			opened[0]?.dispatchEvent(new Event('pagehide'));
		});

		expect(opened).toHaveLength(2);
		expect(overlayRoot(opened[1])).not.toBeNull();
		// The main process forgets the layout of a closed overlay window, so the new one needs it sent again.
		expect(electron.setGameOverlayLayout).toHaveBeenLastCalledWith(layout);
	});

	it('does not reopen the window it closes itself', () => {
		render();
		act(() => root.unmount());
		root = createRoot(document.createElement('div'));
		expect(opened).toHaveLength(1);
		expect(opened[0]?.close).toHaveBeenCalledTimes(1);
	});
});
