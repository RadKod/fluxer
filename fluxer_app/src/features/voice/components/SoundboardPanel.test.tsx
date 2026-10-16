// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {GuildSoundboardSoundResponse} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {makeAutoObservable, observable, runInAction} from 'mobx';
import {act, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const controls = vi.hoisted(() => ({capacity: 8, create: true, manage: false}));
makeAutoObservable(controls);
const commands = vi.hoisted(() => ({
	uploadSound: vi.fn(),
	updateSound: vi.fn(),
	deleteSound: vi.fn(),
	playSound: vi.fn(),
}));
const picker = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());
const volumeCommit = vi.hoisted(() => vi.fn());
const slider = vi.hoisted(() => ({
	props: {} as {asValueChanges?: (value: number) => void; onValueChange?: (value: number) => void},
}));
const library = observable({
	guildId: 'g',
	sounds: [] as Array<GuildSoundboardSoundResponse>,
	loading: false,
	error: null as Error | null,
});
const settings = observable({
	disabled: false,
	volume: 1,
	favorites: [] as Array<string>,
	recent: {} as Record<string, Array<string>>,
});
const media = observable({
	guildId: 'g' as string | null,
	channelId: 'c' as string | null,
	connected: true,
	connectionId: 'connection',
});
const users = observable({currentUserId: 'me', viewAccountKey: 'main:me'});
const gateway = observable({sessionId: 'session'});
const bus = vi.hoisted(() => ({subscribe: vi.fn(), unsubscribe: vi.fn()}));
const modals = vi.hoisted(() => ({
	pushWithKey: vi.fn(),
	popWithKey: vi.fn(),
	push: vi.fn(),
	modal: (render: unknown) => render,
}));
const passThrough = ({children}: {children?: ReactNode}) => children;
const popouts = vi.hoisted(() => ({open: false, closing: false, openPopout: vi.fn(), close: vi.fn()}));
const layout = vi.hoisted(() => ({enabled: false}));

vi.mock('@lingui/core/macro', () => ({msg: (value: unknown) => value}));
// By default messages are interpolated from their source text. With `lingui.catalog` on, a descriptor is reduced to the
// hashed id a production build keeps and resolved through the real compiled catalog, so a msgid missing from a locale
// catalog shows up as a raw id instead of passing silently.
const lingui = vi.hoisted(() => ({catalog: false}));
vi.mock('@lingui/react/macro', async () => {
	const {i18n: real} = await vi.importActual<typeof import('@lingui/core')>('@lingui/core');
	const {createHash} = await import('node:crypto');
	const messageId = (message: string, context = '') =>
		createHash('sha256')
			.update(`${message}\u001F${context}`)
			.digest('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')
			.slice(0, 6);
	return {
		useLingui: () => ({
			i18n: {
				_: (d: {message: string; context?: string}, values?: Record<string, unknown>) =>
					lingui.catalog
						? real._({id: messageId(d.message, d.context)}, values)
						: d.message.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? key)),
			},
		}),
	};
});
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {resolve: vi.fn(() => controls.capacity)},
}));
vi.mock('@app/features/permissions/state/Permission', () => ({
	default: {
		can: (permission: bigint) =>
			permission === Permissions.CREATE_EXPRESSIONS
				? controls.create
				: permission === Permissions.MANAGE_EXPRESSIONS
					? controls.manage
					: true,
	},
}));
vi.mock('@app/features/user/state/Users', () => ({default: users}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({default: {foregroundConnection: gateway}}));
vi.mock('@app/features/voice/state/SoundboardLibrary', () => ({default: Object.assign(library, {load})}));
vi.mock('@app/features/voice/state/SoundboardSettings', () => ({
	default: Object.assign(settings, {
		setDisabled: (value: boolean) =>
			runInAction(() => {
				settings.disabled = value;
			}),
		setVolume: (value: number) =>
			runInAction(() => {
				settings.volume = value;
			}),
		commitVolume: volumeCommit,
		isFavorite: (id: string) => settings.favorites.includes(id),
		toggleFavorite: (id: string) =>
			runInAction(() => {
				settings.favorites = settings.favorites.includes(id)
					? settings.favorites.filter((entry) => entry !== id)
					: [id, ...settings.favorites];
			}),
		recentFor: (guildId: string) => settings.recent[guildId] ?? [],
		recordPlay: (guildId: string, id: string) =>
			runInAction(() => {
				settings.recent = {
					...settings.recent,
					[guildId]: [id, ...(settings.recent[guildId] ?? []).filter((entry) => entry !== id)].slice(0, 6),
				};
			}),
	}),
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => ({name: 'Kanka'})}}));
vi.mock('@app/features/voice/commands/SoundboardCommands', () => commands);
vi.mock('@app/features/voice/events/SoundboardPlay', async () => ({
	...(await vi.importActual<object>('@app/features/voice/events/SoundboardPlay')),
	initSoundboardRuntime: () => vi.fn(),
}));
vi.mock('@app/features/messaging/utils/FilePickerUtils', () => ({openFilePicker: picker}));
vi.mock('@app/features/platform/utils/ComponentBus', () => ({ComponentBus: bus}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: media, useMediaEngineVersion: () => 0}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modals);
vi.mock('@app/features/ui/popover/PopoverPopout', () => ({openPopout: popouts.openPopout}));
vi.mock('@app/features/ui/commands/PopoutCommands', () => ({close: popouts.close}));
vi.mock('@app/features/ui/state/Popout', () => ({
	default: {isOpen: () => popouts.open, isClosing: () => popouts.closing},
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({
	default: Object.assign(layout, {isMobileLayout: () => layout.enabled}),
}));
vi.mock('@app/features/ui/state/Modal', async () => ({
	...(await vi.importActual<object>('@app/features/ui/state/Modal')),
	default: {hasModal: () => false},
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: passThrough,
	Content: passThrough,
	Header: ({title}: {title: string}) => createElement('h1', null, title),
}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, submitting, leftIcon, small, variant, square, icon, ...props}: Record<string, unknown>) =>
		createElement('button', {type: 'button', ...props, disabled: props.disabled || submitting}, children as ReactNode),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: ({label, leftIcon, rightElement, ...props}: Record<string, unknown>) =>
		createElement('label', null, label as ReactNode, createElement('input', props), rightElement as ReactNode),
}));
vi.mock('@app/features/ui/checkbox/Checkbox', () => ({
	Checkbox: ({
		children,
		checked,
		onChange,
	}: {
		children: ReactNode;
		checked: boolean;
		onChange: (value: boolean) => void;
	}) =>
		createElement(
			'label',
			null,
			children,
			createElement('input', {
				type: 'checkbox',
				checked,
				onChange: (event: {target: {checked: boolean}}) => onChange(event.target.checked),
			}),
		),
}));
vi.mock('@app/features/ui/components/Slider', () => ({
	Slider: ({
		value,
		onValueChange,
		ariaLabel,
		minValue,
		maxValue,
		step,
		asValueChanges,
	}: {
		value: number;
		onValueChange: (value: number) => void;
		ariaLabel: string;
		minValue: number;
		maxValue: number;
		step: number;
		asValueChanges?: (value: number) => void;
	}) => {
		slider.props = {asValueChanges, onValueChange};
		return createElement('input', {
			type: 'range',
			value,
			min: minValue,
			max: maxValue,
			step,
			'aria-label': ariaLabel,
			onChange: (event: {target: {value: string}}) => onValueChange(Number(event.target.value)),
		});
	},
}));

const {SoundboardPanel, SoundboardPopout, SoundboardRoot} = await import('./SoundboardPanel');
const {registerSoundboardAnchor} = await import('@app/features/voice/state/SoundboardAnchor');
const {SoundboardManagePanel} = await import('./SoundboardManagePanel');
const {LimitResolver} = await import('@app/features/app/utils/LimitResolverAdapter');
const {HttpError} = await import('@app/features/platform/types/EndpointError');
let host: HTMLDivElement;
let root: Root;

function sound(id: string, creatorId = 'me'): GuildSoundboardSoundResponse {
	return {
		id,
		guild_id: 'g',
		creator_id: creatorId,
		name: `Sound ${id}`,
		asset_hash: 'a'.repeat(64),
		extension: 'mp3',
		size_bytes: 3,
		duration_ms: 1000,
		volume: 0.5,
		created_at: '2026-10-14T00:00:00.000Z',
		version: 1,
		url: 'https://cdn.micup.test/audio.mp3',
	};
}
function button(label: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
		(element) => element.textContent === label || element.getAttribute('aria-label') === label,
	);
}
async function open(): Promise<void> {
	await act(async () => root.render(createElement(SoundboardPanel, {guildId: 'g', channelId: 'c'})));
}
async function openSettings(): Promise<void> {
	await click('Soundboard listening settings');
}
async function search(value: string): Promise<void> {
	const input = host.querySelector<HTMLInputElement>('input[aria-label="Search sounds"]')!;
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
		setter.call(input, value);
		input.dispatchEvent(new Event('input', {bubbles: true}));
	});
}
function playable(): Array<string> {
	return [...host.querySelectorAll('[data-flx="voice.soundboard-panel.play-sound"]')].map(
		(element) => element.getAttribute('aria-label') ?? '',
	);
}
function named(id: string, name: string): GuildSoundboardSoundResponse {
	return {...sound(id), name};
}
async function click(label: string): Promise<void> {
	expect(button(label), label).toBeDefined();
	await act(async () => {
		const target = button(label)!;
		if (target.type === 'submit' && target.form && !target.disabled) {
			target.form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
		} else target.click();
	});
}
beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.clearAllMocks();
	Object.assign(controls, {capacity: 8, create: true, manage: false});
	Object.assign(popouts, {open: false, closing: false});
	layout.enabled = false;
	lingui.catalog = false;
	runInAction(() => {
		library.sounds = [];
		library.error = null;
		library.loading = false;
		settings.disabled = false;
		settings.volume = 1;
		settings.favorites = [];
		settings.recent = {};
		Object.assign(media, {guildId: 'g', channelId: 'c', connected: true, connectionId: 'connection'});
		Object.assign(users, {currentUserId: 'me', viewAccountKey: 'main:me'});
		gateway.sessionId = 'session';
	});
	load.mockResolvedValue(undefined);
	for (const command of Object.values(commands)) command.mockResolvedValue(undefined);
	picker.mockResolvedValue([]);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('soundboard panel', () => {
	it('resolves sound capacity with the active guild limit scope', async () => {
		await open();
		expect(LimitResolver.resolve).toHaveBeenCalledWith({
			key: 'max_guild_soundboard_sounds',
			fallback: 8,
			context: {guildId: 'g'},
			evaluationContext: 'guild',
		});
	});
	it.each([8, 24, 36, 48])('uses the current guild limit %i and locks uploads at capacity', async (capacity) => {
		controls.capacity = capacity;
		runInAction(() => {
			library.sounds = Array.from({length: capacity}, (_, id) => sound(String(id)));
		});
		await open();
		expect(host.textContent).toContain(`${capacity} / ${capacity}`);
		expect(button('Add sound')?.disabled).toBe(true);
		expect(host.textContent).toContain('Boost to a higher level for more slots.');
	});
	it('renders at most 48 sounds and keeps existing overflow playable on the next page', async () => {
		runInAction(() => {
			library.sounds = Array.from({length: 49}, (_, id) => sound(String(id)));
		});
		await open();
		expect(host.querySelectorAll('[data-flx="voice.soundboard-panel.play-sound"]')).toHaveLength(48);
		await click('Next sounds');
		expect(host.querySelectorAll('[data-flx="voice.soundboard-panel.play-sound"]')).toHaveLength(1);
		await click('Play Sound 48');
		expect(commands.playSound).toHaveBeenCalledWith('c', '48');
	});
	it('only allows creators with Create Expressions or managers to edit', async () => {
		runInAction(() => {
			library.sounds = [sound('own'), sound('other', 'other')];
		});
		await open();
		expect(button('Edit Sound own')).toBeDefined();
		expect(button('Edit Sound other')).toBeUndefined();
		await act(async () => {
			runInAction(() => {
				controls.create = false;
				controls.manage = true;
			});
		});
		await open();
		expect(button('Edit Sound other')).toBeDefined();
		expect(button('Add sound')?.disabled).toBe(true);
	});
	it('keeps the account soundboard switch local and normalizes the listening volume', async () => {
		await open();
		await openSettings();
		const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		await act(async () => checkbox.click());
		expect(settings.disabled).toBe(true);
		const volume = host.querySelector<HTMLInputElement>('input[aria-label="Soundboard volume"]')!;
		expect(volume.min).toBe('0');
		expect(volume.max).toBe('1');
	});
	it('shows load failure with a retry and play failure inline', async () => {
		runInAction(() => {
			library.error = new Error('load');
		});
		await open();
		expect(host.textContent).toContain('Could not load sounds. Try again.');
		await click('Retry');
		expect(load).toHaveBeenCalledWith('g', true);
		runInAction(() => {
			library.error = null;
			library.sounds = [sound('one')];
		});
		commands.playSound.mockRejectedValueOnce(new Error('play'));
		await open();
		await click('Play Sound one');
		expect(host.textContent).toContain('Could not play this sound. Try again.');
	});
	it('changes listening volume live and commits only when the slider finishes', async () => {
		await open();
		await openSettings();
		await act(async () => {
			slider.props.asValueChanges?.(0.6);
			slider.props.asValueChanges?.(0.4);
		});
		expect(settings.volume).toBe(0.4);
		expect(volumeCommit).not.toHaveBeenCalled();
		await act(async () => slider.props.onValueChange?.(0.4));
		expect(volumeCommit).toHaveBeenCalledExactlyOnceWith(0.4);
	});
	it('filters sounds by name ignoring case and Turkish diacritics, and clears the search', async () => {
		runInAction(() => {
			library.sounds = [named('1', 'Işık Yandı'), named('2', 'Gülüş'), named('3', 'Alkış')];
		});
		await open();
		expect(playable()).toHaveLength(3);
		await search('ISIK');
		expect(playable()).toEqual(['Play Işık Yandı']);
		await search('gulus');
		expect(playable()).toEqual(['Play Gülüş']);
		await search('kis');
		expect(playable()).toEqual(['Play Alkış']);
		await search('yok böyle');
		expect(playable()).toHaveLength(0);
		expect(host.textContent).toContain('No sounds match your search.');
		await click('Clear sound search');
		expect(host.querySelector<HTMLInputElement>('input[aria-label="Search sounds"]')!.value).toBe('');
		expect(playable()).toHaveLength(3);
		expect(button('Clear sound search')).toBeUndefined();
	});
	it('stars a sound into the favorites section and unstars it again', async () => {
		runInAction(() => {
			library.sounds = [sound('one'), sound('two')];
		});
		await open();
		expect(host.textContent).not.toContain('Favorite sounds');
		expect(host.textContent).toContain('Kanka sounds');
		await click('Add Sound two to favorites');
		expect(settings.favorites).toEqual(['two']);
		expect(host.textContent).toContain('Favorite sounds');
		expect(button('Remove Sound two from favorites')?.getAttribute('aria-pressed')).toBe('true');
		// The starred sound shows in favorites and in the community list.
		expect(playable()).toEqual(['Play Sound two', 'Play Sound one', 'Play Sound two']);
		await click('Remove Sound two from favorites');
		expect(settings.favorites).toEqual([]);
		expect(host.textContent).not.toContain('Favorite sounds');
	});
	it('collapses and expands a section from its header', async () => {
		runInAction(() => {
			library.sounds = [sound('one')];
		});
		await open();
		const header = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((element) =>
			element.textContent?.startsWith('Kanka sounds'),
		)!;
		expect(header.getAttribute('aria-expanded')).toBe('true');
		await act(async () => header.click());
		expect(header.getAttribute('aria-expanded')).toBe('false');
		expect(playable()).toHaveLength(0);
		await act(async () => header.click());
		expect(playable()).toHaveLength(1);
	});
	it('lists recently played sounds after a successful play', async () => {
		runInAction(() => {
			library.sounds = [sound('one'), sound('two')];
		});
		await open();
		expect(host.textContent).not.toContain('Recently played');
		await click('Play Sound two');
		expect(host.textContent).toContain('Recently played');
		expect(playable()[0]).toBe('Play Sound two');
	});
	it('shows a rate limit countdown that clears itself after retry_after', async () => {
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
		try {
			runInAction(() => {
				library.sounds = [sound('one')];
			});
			commands.playSound.mockRejectedValueOnce(
				new HttpError({method: 'POST', path: '/play', status: 429, body: {retry_after: 2.5}}),
			);
			await open();
			await click('Play Sound one');
			expect(host.textContent).toContain('Slow down. Try again in 3 s.');
			// Presses during the cooldown do not hit the server again.
			await click('Play Sound one');
			expect(commands.playSound).toHaveBeenCalledOnce();
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});
			expect(host.textContent).toContain('Slow down. Try again in 2 s.');
			await act(async () => {
				vi.advanceTimersByTime(1600);
			});
			expect(host.textContent).not.toContain('Slow down');
			expect(host.querySelector('[role="alert"]')).toBeNull();
			await click('Play Sound one');
			expect(commands.playSound).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
	it('explains a refused play and clears the message on the next successful play', async () => {
		runInAction(() => {
			library.sounds = [sound('one')];
		});
		commands.playSound.mockRejectedValueOnce(new HttpError({method: 'POST', path: '/play', status: 403}));
		await open();
		await click('Play Sound one');
		expect(host.textContent).toContain('To play sounds, join this voice channel and undeafen yourself.');
		await click('Play Sound one');
		expect(host.textContent).not.toContain('join this voice channel');
	});
	it('registers one toggle listener and removes it on unmount', async () => {
		const remove = vi.fn();
		bus.subscribe.mockReturnValue(remove);
		await act(async () => root.render(createElement(SoundboardRoot)));
		expect(bus.subscribe).toHaveBeenCalledWith('SOUNDBOARD_TOGGLE', expect.any(Function));
		act(() => bus.subscribe.mock.calls[0][1]());
		expect(modals.pushWithKey).toHaveBeenCalledWith(expect.any(Function), 'soundboard');
		act(() => root.unmount());
		root = createRoot(host);
		expect(remove).toHaveBeenCalledOnce();
		expect(modals.popWithKey).toHaveBeenCalledWith('soundboard');
	});
	it.each(['account', 'connection', 'session'])(
		'closes the old form and replaces its listener on a same-channel %s change',
		async (kind) => {
			const remove = vi.fn();
			bus.subscribe.mockReturnValue(remove);
			await act(async () => root.render(createElement(SoundboardRoot)));
			await act(async () => {
				runInAction(() => {
					if (kind === 'account') users.viewAccountKey = 'main:other';
					if (kind === 'connection') media.connectionId = 'new-connection';
					if (kind === 'session') gateway.sessionId = 'new-session';
				});
			});
			expect(remove).toHaveBeenCalledOnce();
			expect(modals.popWithKey).toHaveBeenCalledExactlyOnceWith('soundboard');
			expect(bus.subscribe).toHaveBeenCalledTimes(2);
		},
	);
});

describe('soundboard management', () => {
	async function manage(existing?: GuildSoundboardSoundResponse): Promise<void> {
		await act(async () =>
			root.render(
				createElement(SoundboardManagePanel, {guildId: 'g', sound: existing, onClose: vi.fn(), uploadAllowed: true}),
			),
		);
	}
	it.each([
		{name: 'clip.wav', type: 'audio/wav', bytes: 3},
		{name: 'clip.mp3', type: 'audio/mpeg', bytes: 1000001},
	])('rejects invalid upload $name with $bytes bytes before sending', async ({name, type, bytes}) => {
		await manage();
		picker.mockResolvedValue([new File([new Uint8Array(bytes)], name, {type})]);
		await click('Choose audio');
		expect(host.textContent).toContain('Choose an MP3 or Ogg file up to 1,000,000 bytes.');
		expect(commands.uploadSound).not.toHaveBeenCalled();
	});
	it('uploads accepted MP3 as raw base64 with normalized volume', async () => {
		await manage();
		picker.mockResolvedValue([new File([new Uint8Array([1, 2, 3])], 'clip.mp3', {type: 'audio/mpeg'})]);
		await click('Choose audio');
		await click('Save sound');
		expect(commands.uploadSound).toHaveBeenCalledWith('g', {name: 'clip', audio: 'AQID', volume: 1});
	});
	it('rejects a mismatched audio MIME type even with an MP3 filename', async () => {
		await manage();
		picker.mockResolvedValue([new File([new Uint8Array([1, 2, 3])], 'clip.mp3', {type: 'audio/wav'})]);
		await click('Choose audio');
		expect(host.textContent).toContain('Choose an MP3 or Ogg file up to 1,000,000 bytes.');
		expect(button('Save sound')?.disabled).toBe(true);
	});
	it('keeps a failed save in the form with an actionable error', async () => {
		await manage(sound('own'));
		commands.updateSound.mockRejectedValueOnce(new Error('save'));
		await click('Save sound');
		expect(host.textContent).toContain('Could not save this sound. Try again.');
		expect(button('Save sound')?.disabled).toBe(false);
	});
	it.each(['own', 'managed'])('deletes an authorized %s sound after confirmation', async (kind) => {
		controls.manage = kind === 'managed';
		await manage(sound(kind, kind === 'managed' ? 'other' : 'me'));
		await click('Delete sound');
		expect(commands.deleteSound).not.toHaveBeenCalled();
		const confirmation = modals.push.mock.calls[0][0]() as ReactElement<{onPrimary: () => Promise<void>}>;
		await act(async () => confirmation.props.onPrimary());
		expect(commands.deleteSound).toHaveBeenCalledWith('g', kind);
	});
	it('saves an owned sound through the metadata update without sending audio', async () => {
		await manage(sound('own'));
		await click('Save sound');
		expect(commands.updateSound).toHaveBeenCalledWith('g', 'own', {name: 'Sound own', volume: 0.5});
		expect(commands.uploadSound).not.toHaveBeenCalled();
	});
	it('does not save or delete another creator sound without Manage Expressions', async () => {
		await manage(sound('other', 'other'));
		expect(button('Save sound')?.disabled).toBe(true);
		expect(button('Delete sound')).toBeUndefined();
		await click('Save sound');
		expect(commands.updateSound).not.toHaveBeenCalled();
		expect(commands.deleteSound).not.toHaveBeenCalled();
	});
});

describe('soundboard popout', () => {
	type PopoutOptions = {
		position: string;
		render: (props: {popoutKey: string; onClose: () => void}) => ReactElement;
		returnFocusRef: {current: HTMLElement | null};
	};
	let anchor: HTMLButtonElement;
	let unregister: () => void;
	beforeEach(() => {
		anchor = document.createElement('button');
		document.body.append(anchor);
		unregister = registerSoundboardAnchor(anchor);
		bus.subscribe.mockReturnValue(vi.fn());
	});
	afterEach(() => {
		unregister();
		anchor.remove();
	});
	async function toggle(): Promise<void> {
		await act(async () => root.render(createElement(SoundboardRoot)));
		act(() => bus.subscribe.mock.calls.at(-1)![1]());
	}
	it('opens anchored above the voice panel button instead of a modal and closes on the next toggle', async () => {
		await toggle();
		expect(modals.pushWithKey).not.toHaveBeenCalled();
		expect(popouts.openPopout).toHaveBeenCalledOnce();
		const [target, options, key] = popouts.openPopout.mock.calls[0] as [HTMLElement, PopoutOptions, string];
		expect(target).toBe(anchor);
		expect(key).toBe('soundboard-popout');
		expect(options.position).toBe('top-start');
		expect(options.returnFocusRef.current).toBe(anchor);
		popouts.open = true;
		act(() => bus.subscribe.mock.calls.at(-1)![1]());
		expect(popouts.close).toHaveBeenCalledExactlyOnceWith('soundboard-popout');
		expect(popouts.openPopout).toHaveBeenCalledOnce();
	});
	it('falls back to the modal on the mobile layout or without a mounted button', async () => {
		layout.enabled = true;
		await toggle();
		expect(popouts.openPopout).not.toHaveBeenCalled();
		expect(modals.pushWithKey).toHaveBeenCalledWith(expect.any(Function), 'soundboard');
		layout.enabled = false;
		unregister();
		modals.pushWithKey.mockClear();
		act(() => bus.subscribe.mock.calls.at(-1)![1]());
		expect(popouts.openPopout).not.toHaveBeenCalled();
		expect(modals.pushWithKey).toHaveBeenCalledWith(expect.any(Function), 'soundboard');
	});
	it('renders the same picker with the search box marked for initial focus', async () => {
		runInAction(() => {
			library.sounds = [sound('one')];
		});
		const onClose = vi.fn();
		await act(async () => root.render(createElement(SoundboardPopout, {guildId: 'g', channelId: 'c', onClose})));
		expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Soundboard');
		const input = host.querySelector<HTMLInputElement>('input[aria-label="Search sounds"]')!;
		expect(input.hasAttribute('data-autofocus')).toBe(true);
		await click('Play Sound one');
		expect(commands.playSound).toHaveBeenCalledWith('c', 'one');
		expect(onClose).not.toHaveBeenCalled();
	});
	it('closes itself and opens the manage form as a modal', async () => {
		runInAction(() => {
			library.sounds = [sound('one')];
		});
		const onClose = vi.fn();
		await act(async () => root.render(createElement(SoundboardPopout, {guildId: 'g', channelId: 'c', onClose})));
		await click('Edit Sound one');
		expect(onClose).toHaveBeenCalledOnce();
		expect(modals.pushWithKey).toHaveBeenCalledWith(expect.any(Function), 'soundboard-manage');
	});
	it('closes when the voice session leaves the channel it was opened for', async () => {
		const onClose = vi.fn();
		await act(async () => root.render(createElement(SoundboardPopout, {guildId: 'g', channelId: 'c', onClose})));
		expect(onClose).not.toHaveBeenCalled();
		await act(async () => {
			runInAction(() => {
				media.channelId = 'other';
			});
		});
		expect(onClose).toHaveBeenCalled();
	});
});

describe('soundboard copy from the compiled catalogs', () => {
	async function activate(locale: string): Promise<void> {
		const {i18n} = await import('@lingui/core');
		const {messages} = (await import(`../../i18n/locales/${locale}/messages.mjs`)) as {
			messages: Record<string, unknown>;
		};
		i18n.load(locale, messages as never);
		i18n.activate(locale);
		lingui.catalog = true;
	}
	it.each([
		['en-US', 'Kanka sounds', '5 / 8 sounds', 'Slow down. Try again in 3 s.', 'Add Sound 0 to favorites'],
		['tr', 'Kanka sunucusunun sesleri', '5 / 8 ses', 'Yavaşla, 3 sn sonra tekrar dene.', 'Favorilere ekle: Sound 0'],
	])(
		'interpolates the header, capacity, favorite and rate limit copy in %s',
		async (locale, header, footer, rate, star) => {
			await activate(locale);
			runInAction(() => {
				library.sounds = Array.from({length: 5}, (_, id) => sound(String(id)));
			});
			commands.playSound.mockRejectedValueOnce(
				new HttpError({method: 'POST', path: '/play', status: 429, body: {retry_after: 2.5}}),
			);
			await open();
			const headerButton = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((element) =>
				element.textContent?.startsWith(header),
			);
			expect(headerButton?.textContent).toBe(`${header}5`);
			expect(host.textContent).toContain(footer);
			expect(button(star)).toBeDefined();
			const play = host.querySelector<HTMLButtonElement>('[data-flx="voice.soundboard-panel.play-sound"]')!;
			await act(async () => play.click());
			expect(host.textContent).toContain(rate);
			expect(host.innerHTML).not.toMatch(/\{\w+\}/);
		},
	);
});
