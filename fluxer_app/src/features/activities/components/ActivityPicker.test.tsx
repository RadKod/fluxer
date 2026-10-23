// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceActivitySessionMetadata} from '@fluxer/constants/src/VoiceActivityConstants';
import type React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({
	msg: (descriptor: {message: string}) => ({id: descriptor.message, ...descriptor}),
}));
// Fills in plain {placeholders}; enough for the chips and notes these tests read.
function translate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: translate, locale: 'en', number: String}}),
}));
vi.mock('@app/features/activities/band/BandCatalog', () => ({default: {songCount: null}}));
vi.mock('@app/features/activities/commands/VoiceActivityCommands', () => ({
	startVoiceActivity: vi.fn(async () => ({ok: true})),
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Content: ({children}: {children: React.ReactNode}) => <div data-flx="test.modal-content">{children}</div>,
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: ({value, onChange, placeholder}: React.InputHTMLAttributes<HTMLInputElement>) => (
		<input value={value} onChange={onChange} placeholder={placeholder} data-flx="test.input" />
	),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, disabled, onClick}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button type="button" data-start="true" disabled={disabled} onClick={onClick} data-flx="test.button">
			{children}
		</button>
	),
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({pop: vi.fn(), pushWithKey: vi.fn(), modal: vi.fn()}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => null}}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {guildId: null, getAllVoiceStatesInChannel: () => ({})},
}));

const {ActivityPickerPanel} = await import('@app/features/activities/components/ActivityPicker');
const {startVoiceActivity} = await import('@app/features/activities/commands/VoiceActivityCommands');
const {default: VoiceActivities} = await import('@app/features/activities/state/VoiceActivities');

const CHANNEL_ID = '500';
const RUNNING: VoiceActivitySessionMetadata = {
	activity_id: 'band',
	session_id: '11',
	started_by: '1',
	started_at: 0,
};

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function render(): void {
	act(() =>
		root.render(
			<ActivityPickerPanel
				channelId={CHANNEL_ID}
				channelName="Sahne"
				peopleCount={2}
				onClose={onClose}
				data-flx="test.picker"
			/>,
		),
	);
}

function cardNames(): Array<string> {
	return [...container.querySelectorAll('[data-flx="activities.activity-picker.activity-card.name"]')].map(
		(element) => element.textContent ?? '',
	);
}

function openCard(name: string): void {
	const card = [
		...container.querySelectorAll<HTMLButtonElement>('[data-flx="activities.activity-picker.activity-card.card"]'),
	].find((element) => element.textContent?.includes(name));
	if (!card) throw new Error(`No card named ${name}`);
	act(() => card.click());
}

function startButton(): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>('[data-start]');
	if (!button) throw new Error('No Start button');
	return button;
}

function search(query: string): void {
	const input = container.querySelector('input');
	if (!input) throw new Error('No search field');
	act(() => {
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
		setValue?.call(input, query);
		input.dispatchEvent(new Event('input', {bubbles: true}));
	});
}

beforeEach(() => {
	Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
	vi.mocked(startVoiceActivity).mockClear();
	onClose.mockClear();
	VoiceActivities.reset();
	VoiceActivities.handleSession(CHANNEL_ID, null);
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe('ActivityPickerPanel', () => {
	it('lists the band game and jam as two startable cards, with nothing announced for later', () => {
		render();
		expect(cardNames()).toEqual(['Bir Daha Baştan', 'Jam']);
		expect(container.textContent).not.toContain('Coming soon');
	});

	it('starts the band activity in jam from the jam card', async () => {
		render();
		openCard('Jam');
		expect(container.textContent).toContain('Take your instrument');
		expect(container.textContent).toContain('1–6 people');
		await act(async () => startButton().click());
		expect(startVoiceActivity).toHaveBeenCalledWith(CHANNEL_ID, 'band', 'jam');
		expect(onClose).toHaveBeenCalled();
	});

	it('starts the band game without a mode from its own card', async () => {
		render();
		openCard('Bir Daha Baştan');
		await act(async () => startButton().click());
		expect(startVoiceActivity).toHaveBeenCalledWith(CHANNEL_ID, 'band', null);
	});

	it('keeps jam behind the one-activity rule while something runs', () => {
		VoiceActivities.handleSession(CHANNEL_ID, RUNNING);
		render();
		openCard('Jam');
		expect(startButton().disabled).toBe(true);
		expect(container.textContent).toContain('An activity is already running. End it before starting another.');
	});

	it('searches both cards', () => {
		render();
		search('freely');
		expect(cardNames()).toEqual(['Jam']);
		search('guitar');
		expect(cardNames()).toEqual(['Bir Daha Baştan']);
		search('nothing like this');
		expect(cardNames()).toEqual([]);
		expect(container.querySelector('[data-flx="activities.activity-picker.empty"]')).not.toBeNull();
	});
});
