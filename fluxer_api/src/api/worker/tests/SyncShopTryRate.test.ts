// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopConfig} from '@app/api/instance/InstanceConfigRepository';
import {getEffectiveShopTryRate} from '@app/api/shop/ShopTryRate';
import syncShopTryRate from '@app/api/worker/tasks/SyncShopTryRate';
import * as WorkerContext from '@app/api/worker/WorkerContext';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, describe, expect, it, vi} from 'vitest';

const xml =
	'<ValCurs Date="02.10.2026"><ValType><Valute Code="TRY"><Nominal>1</Nominal><Value>0.04</Value></Valute></ValType></ValCurs>';

describe('CBAR worker', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	function setup(initial: Partial<ShopConfig> = {}) {
		let config: Partial<ShopConfig> = initial;
		const updateShopConfig = vi.fn(async (plan: (value: Partial<ShopConfig>) => Partial<ShopConfig>) => {
			config = {...config, ...plan(config)};
			return config;
		});
		vi.spyOn(WorkerContext, 'getWorkerDependencies').mockReturnValue({
			instanceConfigRepository: {updateShopConfig},
		} as unknown as ReturnType<typeof WorkerContext.getWorkerDependencies>);
		const warn = vi.fn();
		const helpers = {logger: {warn}} as unknown as WorkerTaskHelpers;
		return {helpers, warn, updateShopConfig, read: () => config};
	}
	it('persists a rejected jump, then recovers on the next bulletin', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(new Response(xml))
				.mockResolvedValueOnce(new Response(xml.replace('02.10', '03.10'))),
		);
		const state = setup({try_to_azn_rate_micro: 60_000});
		await syncShopTryRate({}, state.helpers);
		expect(state.read()).toMatchObject({
			try_to_azn_rate_micro: null,
			try_rate_date: '2026-10-02',
			try_rate_fetched_at: new Date().toISOString(),
		});
		expect(getEffectiveShopTryRate(state.read(), new Date())).toBeNull();
		await syncShopTryRate({}, state.helpers);
		expect(state.read()).toMatchObject({try_to_azn_rate_micro: 40_000, try_rate_date: '2026-10-03'});
		expect(state.warn).not.toHaveBeenCalled();
	});
	it('fetches a fixed Baku URL with timeout, no redirects and persists the bulletin date', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-10-05T20:30:00Z'));
		const fetchMock = vi.fn().mockResolvedValue(new Response(xml));
		vi.stubGlobal('fetch', fetchMock);
		const state = setup();
		await syncShopTryRate({}, state.helpers);
		expect(fetchMock).toHaveBeenCalledWith('https://www.cbar.az/currencies/06.10.2026.xml', {
			signal: expect.any(AbortSignal),
			redirect: 'error',
		});
		expect(state.read()).toMatchObject({try_to_azn_rate_micro: 40_000, try_rate_date: '2026-10-02'});
	});
	it.each(['network', 'http', 'doctype', 'oversize'])(
		'warns and returns normally on %s failure without changing config',
		async (kind) => {
			const fetchMock =
				kind === 'network'
					? vi.fn().mockRejectedValue(new Error('network'))
					: vi
							.fn()
							.mockResolvedValue(
								new Response(
									kind === 'doctype' ? `<!DOCTYPE x>${xml}` : kind === 'oversize' ? 'x'.repeat(65_537) : '',
									{status: kind === 'http' ? 503 : 200},
								),
							);
			vi.stubGlobal('fetch', fetchMock);
			const state = setup();
			await expect(syncShopTryRate({}, state.helpers)).resolves.toBeUndefined();
			expect(state.warn).toHaveBeenCalled();
			expect(state.updateShopConfig).not.toHaveBeenCalled();
		},
	);
});
