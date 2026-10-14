// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: true}}));
vi.mock('@app/features/ui/components/Slider', () => ({Slider: () => null}));
vi.mock('@app/features/ui/components/slider/SliderResetIconButton', () => ({SliderResetIconButton: () => null}));
vi.mock('@app/features/ui/accordion/Accordion', () => ({
	Accordion: ({children}: {children: ReactNode}) => createElement('div', null, children),
}));
// Switches as plain buttons: the label text and a click that flips the value.
function switchButton({label, value, onChange, disabled}: Record<string, unknown>) {
	return createElement(
		'button',
		{
			type: 'button',
			role: 'switch',
			'aria-checked': value === true,
			disabled: disabled === true,
			onClick: () => (onChange as (next: boolean) => void)(value !== true),
		},
		label as ReactNode,
	);
}
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({Switch: switchButton}));
vi.mock('@app/features/ui/components/SwitchGroup', () => ({
	SwitchGroup: ({children}: {children: ReactNode}) => createElement('div', null, children),
	SwitchGroupCustomItem: switchButton,
}));

const {SoundType} = await import('@app/features/notification/utils/SoundUtils');
const {TABLE_GAME_SOUND_TYPES} = await import('@app/features/table_game/sound/TableGameSoundFiles');
const {Sounds} = await import('@app/features/user/components/modals/tabs/notifications_tab/NotificationsTabSounds');

type SoundTypeValue = (typeof SoundType)[keyof typeof SoundType];

const TABLE_GROUP = 'Table game sounds';

describe('NotificationsTabSounds — table game sounds group', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let disabled: Set<SoundTypeValue>;
	const onToggleSound = vi.fn((type: SoundTypeValue, enabled: boolean) => {
		if (enabled) disabled.delete(type);
		else disabled.add(type);
	});

	function render(): void {
		const labels = Object.fromEntries(Object.values(SoundType).map((type) => [type, `label:${type}`]));
		act(() =>
			root.render(
				createElement(Sounds, {
					soundSettings: {allSoundsDisabled: false, disabledSounds: {}, masterVolume: 100, soundOverrides: {}},
					soundTypeLabels: labels as never,
					customSounds: {} as never,
					isSoundEnabled: (type: SoundTypeValue) => !disabled.has(type),
					onToggleAllSounds: vi.fn(),
					onToggleSound,
					onPreviewSound: vi.fn(),
					onUploadClick: vi.fn(),
					onCustomSoundDelete: vi.fn(),
					onMasterVolumeChange: vi.fn(),
					onSoundOverrideChange: vi.fn(),
					onSoundOverrideReset: vi.fn(),
					onAllOverridesReset: vi.fn(),
				}),
			),
		);
	}

	function switchNamed(text: string): HTMLButtonElement {
		const found = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((node) =>
			node.textContent?.includes(text),
		);
		if (!found) throw new Error(`no switch ${text}`);
		return found;
	}

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		disabled = new Set();
		onToggleSound.mockClear();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('Table game sounds group switch toggles all 21; single toggles work', () => {
		render();
		const group = switchNamed(TABLE_GROUP);
		expect(group.getAttribute('aria-checked')).toBe('true');
		for (const type of TABLE_GAME_SOUND_TYPES) switchNamed(`label:${type}`);

		act(() => group.click());
		expect(onToggleSound).toHaveBeenCalledTimes(21);
		expect(new Set(onToggleSound.mock.calls.map(([type]) => type))).toEqual(new Set(TABLE_GAME_SOUND_TYPES));
		expect(onToggleSound.mock.calls.every(([, enabled]) => enabled === false)).toBe(true);

		render();
		expect(switchNamed(TABLE_GROUP).getAttribute('aria-checked')).toBe('false');
		onToggleSound.mockClear();
		act(() => switchNamed(TABLE_GROUP).click());
		expect(onToggleSound).toHaveBeenCalledTimes(21);
		expect(onToggleSound.mock.calls.every(([, enabled]) => enabled === true)).toBe(true);

		render();
		onToggleSound.mockClear();
		act(() => switchNamed(`label:${SoundType.TableGameChessCheck}`).click());
		expect(onToggleSound.mock.calls).toEqual([[SoundType.TableGameChessCheck, false]]);
	});

	it('table game sounds live only in their group, not in the general list', () => {
		render();
		const showMore = Array.from(container.querySelectorAll('button')).find((node) =>
			node.textContent?.includes('Show more sound effects'),
		);
		act(() => showMore?.click());
		const general = Array.from(container.querySelectorAll('[role="switch"]'), (node) => node.textContent ?? '');
		expect(general.some((text) => text.includes(`label:${SoundType.UserJoin}`))).toBe(true);
		const tableRows = general.filter((text) => text.includes('label:table-game-'));
		expect(tableRows).toHaveLength(21);
		expect(general.filter((text) => text.includes(`label:${SoundType.Message}`))).toHaveLength(1);
	});

	it('the per-sound volume list leaves the table game sounds out (their group carries them)', () => {
		render();
		const rows = Array.from(
			container.querySelectorAll('[data-flx="user.notifications-tab.sounds.override-row"]'),
			(node) => node.textContent ?? '',
		);
		expect(rows.some((text) => text.includes(`label:${SoundType.UserJoin}`))).toBe(true);
		expect(rows.filter((text) => text.includes('label:table-game-'))).toEqual([]);
	});
});
