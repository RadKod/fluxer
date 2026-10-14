// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	CosmeticItemResponse,
	UltraFront,
	UltraLayout,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {autorun} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: vi.fn()}}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const {Endpoints} = await import('@app/features/app/constants/Endpoints');
const {default: UltraLayouts} = await import('@app/features/cosmetics/state/UltraLayouts');

const get = vi.mocked(http.get);
const LAYOUT: UltraLayout = {
	compact: {width: 2.5, height: 2.5, offset_x: 0, offset_y: -0.1},
	voice: null,
	profile: null,
};
const FRONT: UltraFront = {closed: 'c0', open: ['c0', 'f1', 'f2'], idle: 'a_idle'};

function ultra(id: string, ultraLayout: UltraLayout | null): CosmeticItemResponse {
	return {
		id,
		type: 'avatar_ultra',
		name: `ultra ${id}`,
		description: null,
		asset: `hash${id}`,
		availability: 'owned',
		ultra_layout: ultraLayout,
	};
}

const winged = (id: string): CosmeticItemResponse => ({...ultra(id, null), ultra_front: FRONT});

const answer = (items: Array<CosmeticItemResponse>) => ({body: items}) as Awaited<ReturnType<typeof http.get>>;
const askedIds = () => get.mock.calls.map(([, options]) => (options as {query: {ids: string}}).query.ids.split(','));

// The store lives for the whole session, so every case uses IDs no other case has seen.
describe('UltraLayouts', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		get.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('batches the IDs seen within 50 ms into one request', async () => {
		get.mockResolvedValue(answer([ultra('101', LAYOUT), ultra('102', null)]));
		expect(UltraLayouts.layoutFor('101')).toBeNull();
		await vi.advanceTimersByTimeAsync(30);
		expect(UltraLayouts.layoutFor('102')).toBeNull();
		await vi.advanceTimersByTimeAsync(19);
		expect(get).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith(Endpoints.COSMETICS_ITEMS, {query: {ids: '101,102'}});
		expect(UltraLayouts.layoutFor('101')).toEqual(LAYOUT);
		expect(UltraLayouts.layoutFor('102')).toBeNull();
	});

	it('asks at most 50 IDs per request', async () => {
		get.mockResolvedValue(answer([]));
		const ids = Array.from({length: 120}, (_, index) => String(2000 + index));
		for (const id of ids) UltraLayouts.layoutFor(id);
		await vi.advanceTimersByTimeAsync(50);
		expect(askedIds().map((batch) => batch.length)).toEqual([50, 50, 20]);
		expect(askedIds().flat()).toEqual(ids);
	});

	it('never asks twice for a known ID', async () => {
		UltraLayouts.prime([ultra('301', LAYOUT)]);
		expect(UltraLayouts.layoutFor('301')).toEqual(LAYOUT);
		await vi.advanceTimersByTimeAsync(50);
		expect(get).not.toHaveBeenCalled();

		get.mockResolvedValue(answer([ultra('302', null)]));
		UltraLayouts.layoutFor('302');
		UltraLayouts.layoutFor('303');
		UltraLayouts.layoutFor('302');
		await vi.advanceTimersByTimeAsync(50);
		expect(askedIds()).toEqual([['302', '303']]);

		for (const id of ['301', '302', '303']) UltraLayouts.layoutFor(id);
		await vi.advanceTimersByTimeAsync(50);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('redraws a reader when the layout arrives', async () => {
		get.mockResolvedValue(answer([ultra('501', LAYOUT)]));
		const seen: Array<UltraLayout | null> = [];
		const stop = autorun(() => {
			seen.push(UltraLayouts.layoutFor('501'));
		});
		await vi.advanceTimersByTimeAsync(50);
		stop();
		expect(seen).toEqual([null, LAYOUT]);
	});

	it('falls back to the fixed sizes when the request fails', async () => {
		get.mockRejectedValue(new Error('offline'));
		expect(UltraLayouts.layoutFor('401')).toBeNull();
		await vi.advanceTimersByTimeAsync(50);
		expect(UltraLayouts.layoutFor('401')).toBeNull();
		await vi.advanceTimersByTimeAsync(50);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('answers undefined until the item is read, then its front', async () => {
		get.mockResolvedValue(answer([winged('601')]));
		expect(UltraLayouts.frontFor('601')).toBeUndefined();
		await vi.advanceTimersByTimeAsync(50);
		expect(UltraLayouts.frontFor('601')).toEqual(FRONT);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('a failed read draws behind: null for every asked ID and no second request', async () => {
		get.mockRejectedValue(new Error('offline'));
		expect(UltraLayouts.frontFor('701')).toBeUndefined();
		expect(UltraLayouts.layoutFor('702')).toBeNull();
		await vi.advanceTimersByTimeAsync(50);
		expect(UltraLayouts.frontFor('701')).toBeNull();
		expect(UltraLayouts.frontFor('702')).toBeNull();
		await vi.advanceTimersByTimeAsync(50);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('an ID the server leaves out draws behind', async () => {
		get.mockResolvedValue(answer([ultra('801', null)]));
		expect(UltraLayouts.frontFor('801')).toBeUndefined();
		expect(UltraLayouts.frontFor('802')).toBeUndefined();
		await vi.advanceTimersByTimeAsync(50);
		expect(UltraLayouts.frontFor('801')).toBeNull();
		expect(UltraLayouts.frontFor('802')).toBeNull();
		expect(get).toHaveBeenCalledTimes(1);
	});

	it('prime fills the front from catalog answers', async () => {
		UltraLayouts.prime([winged('901'), ultra('902', LAYOUT)]);
		expect(UltraLayouts.frontFor('901')).toEqual(FRONT);
		expect(UltraLayouts.frontFor('902')).toBeNull();
		expect(UltraLayouts.layoutFor('902')).toEqual(LAYOUT);
		await vi.advanceTimersByTimeAsync(50);
		expect(get).not.toHaveBeenCalled();
	});

	it('an item whose in-front images fail to load draws behind for a minute, then tries the front again', async () => {
		UltraLayouts.prime([winged('1001')]);
		const seen: Array<UltraFront | null | undefined> = [];
		const stop = autorun(() => {
			seen.push(UltraLayouts.frontFor('1001'));
		});
		UltraLayouts.frontFailed('1001');
		stop();
		expect(seen).toEqual([FRONT, null]);
		// The shop tab's catalog answer does not undo the failure.
		UltraLayouts.prime([winged('1001')]);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(UltraLayouts.frontFor('1001')).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		expect(UltraLayouts.frontFor('1001')).toEqual(FRONT);
		// Tried again only when read again: no timer, no request.
		expect(vi.getTimerCount()).toBe(0);
		expect(get).not.toHaveBeenCalled();
	});
});
