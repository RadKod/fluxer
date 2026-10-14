// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {setupI18n} from '@lingui/core';
import {observable, runInAction} from 'mobx';
import {act, createElement, Profiler, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const mocks = vi.hoisted(() => ({
	openPanel: vi.fn(),
	openSettings: vi.fn(),
	open: vi.fn(),
	close: vi.fn(),
	boost: vi.fn(),
	error: vi.fn(),
}));
const accessibility = observable({useReducedMotion: false});
const guilds = observable({
	guild: {premiumTier: 0, premiumSubscriptionCount: 0, unavailable: false} as null | {
		premiumTier: number;
		premiumSubscriptionCount: number;
		unavailable: boolean;
	},
});
const boosts = observable({
	ready: true,
	failed: false,
	status: {level: 0, count: 0, next: {level: 1, boosts: 2}},
	hasFreeSlot: true,
	page: [],
	ownBoostIds: [],
});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => guilds.guild}}));
vi.mock('@app/features/boost/commands/GuildBoostPanelCommands', () => ({
	openGuildBoostPanel: mocks.openPanel,
	openGuildBoostSettings: mocks.openSettings,
}));
vi.mock('@app/features/boost/state/GuildBoosts', () => ({default: Object.assign(boosts, mocks)}));
vi.mock('@app/features/guild/components/alerts/GuildErrorModalUtils', () => ({showGuildErrorModal: mocks.error}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({shouldShowPremiumFeatures: () => true}));
vi.mock('@app/features/app/utils/UserLimits', () => ({Limits: {getPremiumValue: () => 5}}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PREMIUM_PRODUCT_NAME: 'Micup Plus'}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		limits: {
			traitDefinitions: [],
			rules: [{id: 'emoji', filters: {guildFeatures: [GuildFeatures.MORE_EMOJI]}, limits: {max_guild_emojis: 1000}}],
		},
	},
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({
	Tooltip: ({children, text}: {children: ReactNode; text: string | (() => ReactNode)}) => (
		<div>
			<div role="tooltip">{typeof text === 'function' ? text() : text}</div>
			{children}
		</div>
	),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		submitting,
		small: _small,
		...props
	}: {
		children: ReactNode;
		submitting?: boolean;
		small?: boolean;
	}) => (
		<button type="button" disabled={submitting} {...props}>
			{children}
		</button>
	),
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => <div role="status">Loading</div>}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/app/components/dialogs/shared/StatusSlate', () => ({StatusSlate: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({modal: (render: unknown) => render, push: vi.fn()}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({getUserAvatarURL: () => ''}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getFormattedShortDate: () => ''}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getDisplayName: () => ''}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: ({children}: {children: ReactNode}) => <div role="dialog">{children}</div>,
	Header: ({title, icon}: {title: ReactNode; icon: ReactNode}) => (
		<h1>
			{icon}
			{title}
		</h1>
	),
	Content: ({children}: {children: ReactNode}) => <div>{children}</div>,
	Footer: ({children}: {children: ReactNode}) => <footer>{children}</footer>,
}));

const {GuildBoostGoalRow} = await import('@app/features/boost/components/GuildBoostGoalRow');
const {GuildBoostPanel} = await import('@app/features/boost/components/GuildBoostPanel');
const {BoostGemIcon} = await import('@app/features/boost/components/BoostGemIcon');
const {default: GuildBoostTab} = await import('@app/features/boost/components/GuildBoostTab');

describe('community boost surfaces', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		update(() => {
			guilds.guild = {premiumTier: 0, premiumSubscriptionCount: 0, unavailable: false};
			accessibility.useReducedMotion = false;
			boosts.ready = true;
			boosts.failed = false;
			boosts.hasFreeSlot = true;
			boosts.status = {level: 0, count: 0, next: {level: 1, boosts: 2}};
		});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	const update = (action: () => void) => act(() => runInAction(action));
	const renderRow = () => act(() => root.render(createElement(GuildBoostGoalRow, {guildId: '42'})));
	const renderPanel = () => act(() => root.render(createElement(GuildBoostPanel, {guildId: '42'})));

	it('shows a focusable zero-level row for ordinary members without loading boosts', () => {
		renderRow();
		expect(container.querySelector('button')?.textContent).toContain('Goal: Level 1');
		expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
		expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuemax')).toBe('3');
		expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe(
			'Community boost level 0 of 3',
		);
		expect(container.querySelector('button')?.textContent).not.toContain('0/2');
		expect(mocks.open).not.toHaveBeenCalled();
		act(() => container.querySelector('button')!.click());
		expect(mocks.openPanel).toHaveBeenCalledWith('42');
		expect(container.querySelector('button button')).toBeNull();
	});
	it('hides missing and unavailable guilds', () => {
		update(() => {
			guilds.guild = null;
		});
		renderRow();
		expect(container.innerHTML).toBe('');
		update(() => {
			guilds.guild = {premiumTier: 0, premiumSubscriptionCount: 0, unavailable: true};
		});
		expect(container.innerHTML).toBe('');
	});
	it('ignores count changes and tells the fixed total and real next rewards', () => {
		update(() => {
			guilds.guild!.premiumSubscriptionCount = 1;
		});
		renderRow();
		expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
		expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('Level 1 requires 2 boosts in total');
		expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('128 kbps');
		expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('1,000 emoji');
		expect(mocks.open).not.toHaveBeenCalled();
	});
	it('shows full max-level progress and a boost CTA while keeping perks available', () => {
		update(() => {
			guilds.guild!.premiumTier = 3;
			guilds.guild!.premiumSubscriptionCount = 20;
		});
		renderRow();
		expect(container.querySelector('button')?.textContent).toContain('Level 3');
		expect(container.querySelector('[data-flx="boost.goal-row.cta"]')?.textContent).toBe('Boost now');
		const progress = container.querySelector('[role="progressbar"]')!;
		expect(progress.getAttribute('aria-valuenow')).toBe(progress.getAttribute('aria-valuemax'));
	});
	it('disables first-mount animation for reduced motion and never restarts it on count updates', () => {
		update(() => {
			accessibility.useReducedMotion = true;
		});
		renderRow();
		expect(container.querySelector('[data-animate]')?.getAttribute('data-animate')).toBe('false');
		update(() => {
			guilds.guild!.premiumSubscriptionCount = 1;
		});
		expect(container.querySelector('[data-animate]')?.getAttribute('data-animate')).toBe('false');
	});
	it.each([0, 1, 2, 3])('shows exactly three level segments from premiumTier %i alone', (level) => {
		update(() => {
			guilds.guild!.premiumTier = level;
			guilds.guild!.premiumSubscriptionCount = 99;
		});
		renderRow();
		const segments = container.querySelectorAll('[data-flx="boost.goal-row.segment"]');
		expect(segments).toHaveLength(3);
		expect([...segments].map((segment) => segment.getAttribute('data-state'))).toEqual(
			[1, 2, 3].map((candidate) => (candidate <= level ? 'unlocked' : candidate === level + 1 ? 'next' : 'locked')),
		);
		expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(String(level));
		expect(container.querySelector('button')?.textContent).not.toContain('99');
		expect(container.querySelector('[role="tooltip"]')?.textContent).not.toContain('99');
	});
	it('does not render the row again when only the cached boost count changes', () => {
		const render = vi.fn();
		act(() =>
			root.render(
				<Profiler id="row" onRender={render}>
					<GuildBoostGoalRow guildId="42" />
				</Profiler>,
			),
		);
		render.mockClear();
		update(() => {
			guilds.guild!.premiumSubscriptionCount = 99;
		});
		expect(render).not.toHaveBeenCalled();
	});
	it('uses unique SVG gradients for the original boost icon at the supported sizes', () => {
		act(() =>
			root.render(
				<>
					<BoostGemIcon size={16} />
					<BoostGemIcon size={20} />
					<BoostGemIcon size={24} />
				</>,
			),
		);
		const ids = [...container.querySelectorAll('linearGradient')].map((element) => element.id);
		expect(new Set(ids).size).toBe(3);
		expect([...container.querySelectorAll('svg')].map((element) => element.getAttribute('width'))).toEqual([
			'16',
			'20',
			'24',
		]);
	});
	it('keeps the authoritative top level full even if the cached count is missing', () => {
		update(() => {
			guilds.guild!.premiumTier = 3;
			guilds.guild!.premiumSubscriptionCount = 0;
		});
		renderRow();
		const progress = container.querySelector('[role="progressbar"]')!;
		expect(progress.getAttribute('aria-valuenow')).toBe('3');
	});
	it('animates once, then stays still after the count updates', () => {
		renderRow();
		const fill = container.querySelector('[data-animate]')!;
		expect(fill.getAttribute('data-animate')).toBe('true');
		act(() => fill.dispatchEvent(new Event('animationend', {bubbles: true})));
		expect(fill.getAttribute('data-animate')).toBe('false');
		update(() => {
			guilds.guild!.premiumSubscriptionCount = 1;
		});
		expect(container.querySelector('[data-animate]')).toBe(fill);
		expect(fill.getAttribute('data-animate')).toBe('false');
	});
	it('opens store only in the panel and shows thresholds, actual perks, unlocked and next marks', () => {
		update(() => {
			boosts.status = {level: 1, count: 3, next: {level: 2, boosts: 7}};
		});
		renderPanel();
		expect(mocks.open).toHaveBeenCalledWith('42');
		const cards = container.querySelectorAll('[data-flx="boost.panel.level-card"]');
		expect(cards).toHaveLength(3);
		expect([...cards].map((card) => card.getAttribute('data-level'))).toEqual(['1', '2', '3']);
		expect(cards[0].textContent).toContain('Unlocked');
		expect(cards[1].textContent).toContain('Next level');
		expect(cards[0].textContent).toContain('2 boosts');
		expect(cards[1].textContent).toContain('7 boosts');
		expect(cards[2].textContent).toContain('14 boosts');
		expect(cards[0].textContent).toContain('1,000 emoji');
		expect(cards[2].textContent).toContain('Vanity URL');
		expect(container.textContent).toContain('5 boost slots');
		expect(container.textContent).toContain('What is a boost?');
	});
	it('uses the shared boost action with free slots and Premium text with none', async () => {
		renderPanel();
		await act(async () => container.querySelector<HTMLButtonElement>('[data-flx="boost.action.button"]')!.click());
		expect(mocks.boost).toHaveBeenCalledTimes(1);
		update(() => {
			boosts.hasFreeSlot = false;
		});
		expect(container.querySelector('[data-flx="boost.action.button"]')!.textContent).toBe('Get Micup Plus');
		await act(async () => container.querySelector<HTMLButtonElement>('[data-flx="boost.action.button"]')!.click());
		expect(mocks.boost).toHaveBeenCalledTimes(2);
	});
	it('settings use the same action and reward list as the panel', async () => {
		act(() => root.render(createElement(GuildBoostTab, {guildId: '42'})));
		expect(container.querySelectorAll('[data-flx="boost.perks.list"]')).toHaveLength(3);
		expect(container.textContent).toContain('Clearer audio in voice channels.');
		update(() => {
			boosts.hasFreeSlot = false;
		});
		expect(container.querySelector('[data-flx="boost.action.button"]')!.textContent).toBe('Get Micup Plus');
		await act(async () => container.querySelector<HTMLButtonElement>('[data-flx="boost.action.button"]')!.click());
		expect(mocks.boost).toHaveBeenCalledOnce();
	});
	it('keeps the existing remove-boost and booster management entry accessible from the panel', () => {
		renderPanel();
		const manage = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Manage boosts');
		expect(manage).toBeDefined();
		act(() => manage!.click());
		expect(mocks.openSettings).toHaveBeenCalledWith('42');
	});
	it('shows loading, retries failed loads, and handles mutation failure without dismissing perks', async () => {
		update(() => {
			boosts.ready = false;
		});
		renderPanel();
		expect(container.querySelector('[role="status"]')).not.toBeNull();
		update(() => {
			boosts.failed = true;
		});
		expect(container.textContent).toContain('Try again');
		act(() => container.querySelector('button')!.click());
		expect(mocks.open).toHaveBeenCalledTimes(2);
		update(() => {
			boosts.failed = false;
			boosts.ready = true;
		});
		mocks.boost.mockRejectedValueOnce(new Error('offline'));
		await act(async () => container.querySelector<HTMLButtonElement>('[data-flx="boost.action.button"]')!.click());
		expect(mocks.error).toHaveBeenCalledTimes(1);
		expect(container.querySelectorAll('[data-level]')).toHaveLength(3);
	});
});
