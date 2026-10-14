// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ReferralMeResponse} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Fills {name} and the one plural shape the tab uses: {days, plural, one {# day} other {# days}}.
function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message
		.replace(/{(\w+), plural, one {((?:[^{}]|{\w+})*)} other {((?:[^{}]|{\w+})*)}}/g, (_all, key, one, other) =>
			(Number(values[key]) === 1 ? one : other).replace('#', String(values[key])),
		)
		.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/referral/commands/ReferralCommands', () => ({fetchReferral: vi.fn()}));
vi.mock('@app/features/cosmetics/commands/CosmeticCommands', () => ({fetchItems: vi.fn()}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {webAppEndpoint: 'https://beta.micup.test'}}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PREMIUM_PRODUCT_NAME: 'Plus'}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({
	getFormattedShortDate: (value: string) => value.slice(0, 10),
}));
vi.mock('@app/features/ui/commands/TextCopyCommands', () => ({copy: vi.fn()}));
vi.mock('@app/features/ui/components/Spinner', () => ({
	Spinner: () => createElement('span', {'data-testid': 'spinner'}),
}));
// Settings chrome has its own tests; here it only needs to show what it gets.
vi.mock('@app/features/app/components/dialogs/shared/SettingsSection', () => ({
	SettingsSection: ({title, children}: {title: React.ReactNode; children: React.ReactNode}) =>
		createElement('section', null, createElement('h2', null, title), children),
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsTabLayout', () => ({
	SettingsTabContainer: ({children}: {children: React.ReactNode}) => children,
	SettingsTabContent: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/app/components/dialogs/shared/StatusSlate', () => ({
	StatusSlate: ({title, actions = []}: {title: React.ReactNode; actions?: Array<{onClick: () => void}>}) =>
		createElement('div', {'data-testid': 'slate', onClick: actions[0]?.onClick}, title),
}));
vi.mock('@app/features/app/components/dialogs/shared/CopyLinkSection', () => ({
	CopyLinkSection: ({label, value}: {label: React.ReactNode; value: string}) =>
		createElement('label', null, label, createElement('input', {readOnly: true, value})),
}));

const ReferralCommands = await import('@app/features/referral/commands/ReferralCommands');
const CosmeticCommands = await import('@app/features/cosmetics/commands/CosmeticCommands');
const {default: ReferralSettingsTab} = await import('@app/features/referral/components/ReferralSettingsTab');

const CODE = 'abcdef2345';

function me(extra: Partial<ReferralMeResponse> = {}): ReferralMeResponse {
	return {
		enabled: true,
		code: CODE,
		counts: {pending: 2, valid: 3, rejected: 1},
		min_active_days: 3,
		tiers: [
			{id: '1', threshold: 5, reward: {type: 'premium_days', days: 30}},
			{id: '2', threshold: 3, reward: {type: 'offsite', description: 'Mug'}},
			{id: '3', threshold: 10, reward: {type: 'cosmetic', item_id: '77'}},
		],
		rewards: [],
		...extra,
	};
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

describe('ReferralSettingsTab', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	const render = async (state: ReferralMeResponse) => {
		vi.mocked(ReferralCommands.fetchReferral).mockResolvedValue(state);
		await act(async () => {
			root.render(createElement(ReferralSettingsTab));
		});
		await settle();
	};

	beforeEach(() => {
		vi.mocked(CosmeticCommands.fetchItems).mockResolvedValue([{id: '77', name: 'Alev'}] as never);
		container = document.createElement('div');
		root = createRoot(container);
	});
	afterEach(() => act(() => root.unmount()));

	it('renders link from webAppEndpoint', async () => {
		await render(me());

		expect(container.querySelector('input')?.value).toBe(`https://beta.micup.test/r/${CODE}`);
	});

	it('counts', async () => {
		await render(me());

		const values = [...container.querySelectorAll('[data-flx$="stat-value"]')].map((node) => node.textContent);
		expect(values).toEqual(['2', '3', '1']);
	});

	it('tier progress', async () => {
		await render(me());

		const bars = [...container.querySelectorAll('[role="progressbar"]')];
		expect(bars.map((bar) => [bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')])).toEqual([
			['3', '5'],
			['3', '3'],
			['3', '10'],
		]);
		expect(container.textContent).toContain('3 / 5');
		expect(container.textContent).toContain('Reached');
		expect(container.textContent).toContain('30 days of Plus');
		expect(container.textContent).toContain('Alev');
	});

	it('names a cosmetic reward generically when the name lookup fails', async () => {
		vi.mocked(CosmeticCommands.fetchItems).mockRejectedValue(new Error('offline'));

		await render(me());

		expect(container.textContent).toContain('Cosmetic item');
	});

	it('offsite code only when present', async () => {
		const reward = {
			tier_id: '2',
			reward: {type: 'offsite' as const, description: 'Mug'},
			granted_at: '2026-10-01T10:00:00.000Z',
		};
		await render(
			me({
				rewards: [
					{...reward, status: 'pending_admin', delivered_at: null, code: null},
					{...reward, tier_id: '9', status: 'delivered', delivered_at: '2026-10-02T10:00:00.000Z', code: 'GIFT-1234'},
				],
			}),
		);

		const inputs = [...container.querySelectorAll('input')].map((input) => input.value);
		expect(inputs).toEqual([`https://beta.micup.test/r/${CODE}`, 'GIFT-1234']);
		expect(container.textContent).toContain('Staff will hand it over');
		expect(container.textContent).toContain('Delivered 2026-10-02');
	});

	it('disabled state', async () => {
		await render(me({enabled: false, code: null}));

		expect(container.querySelector('[data-testid="slate"]')?.textContent).toBe('Referrals are closed right now');
		expect(container.querySelector('input')).toBeNull();
	});

	it('closed programme still shows earned rewards and offsite code', async () => {
		await render(
			me({
				enabled: false,
				code: null,
				rewards: [
					{
						tier_id: '2',
						reward: {type: 'offsite', description: 'Mug'},
						granted_at: '2026-10-01T10:00:00.000Z',
						status: 'delivered',
						delivered_at: '2026-10-02T10:00:00.000Z',
						code: 'GIFT-1234',
					},
				],
			}),
		);

		expect(container.querySelector('[data-testid="slate"]')?.textContent).toBe('Referrals are closed right now');
		expect(container.textContent).toContain('Your rewards');
		expect(container.textContent).toContain('Mug');
		expect([...container.querySelectorAll('input')].map((input) => input.value)).toEqual(['GIFT-1234']);
		expect(container.querySelector('[role="progressbar"]')).toBeNull();
		expect(container.querySelector('[data-flx$="stat-value"]')).toBeNull();
	});

	it('offers a retry when the request fails', async () => {
		vi.mocked(ReferralCommands.fetchReferral).mockRejectedValueOnce(new Error('offline'));
		await act(async () => {
			root.render(createElement(ReferralSettingsTab));
		});
		await settle();
		expect(container.querySelector('[data-testid="slate"]')?.textContent).toBe('Something went wrong');

		vi.mocked(ReferralCommands.fetchReferral).mockResolvedValue(me());
		await act(async () => {
			(container.querySelector('[data-testid="slate"]') as HTMLElement).click();
		});
		await settle();

		expect(container.querySelector('input')?.value).toBe(`https://beta.micup.test/r/${CODE}`);
	});
});
