// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/state/AuthSession', () => ({default: {userId: '123456789012345678'}}));

type Memory = typeof import('@app/features/app/components/skeleton/SkeletonLayoutMemory');

async function loadMemory(): Promise<Memory> {
	vi.resetModules();
	const memory = await import('@app/features/app/components/skeleton/SkeletonLayoutMemory');
	memory.setSkeletonLayoutCaptureEnabled(true);
	return memory;
}

function railLayout(feedVisible: boolean) {
	return {
		inlineDmRowCount: 0,
		inlineDmUnreadFlags: [],
		selectedInlineDmRowIndex: -1,
		outageVisible: false,
		fluxerVisible: true,
		favoritesVisible: true,
		feedVisible,
		discoveryVisible: true,
		addGuildVisible: true,
		downloadVisible: false,
		helpVisible: true,
		selectedItemIndex: -1,
		organizedItems: [],
	};
}

describe('skeleton guild rail memory and the feed button', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('remembers the feed button across reloads so the skeleton rail keeps its place', async () => {
		const memory = await loadMemory();
		memory.reportSkeletonGuildRailLayout(railLayout(true));
		expect(memory.getRememberedSkeletonGuildRailLayout()?.feedVisible).toBe(true);
		memory.flushSkeletonLayoutMemoryWrite();

		const reloaded = await loadMemory();
		expect(reloaded.getRememberedSkeletonGuildRailLayout()?.feedVisible).toBe(true);
	});

	it('still reads a rail snapshot saved before the feed button existed', async () => {
		const memory = await loadMemory();
		const {feedVisible: _, ...withoutFeed} = railLayout(false);
		memory.reportSkeletonGuildRailLayout(withoutFeed as ReturnType<typeof railLayout>);
		memory.flushSkeletonLayoutMemoryWrite();

		const reloaded = await loadMemory();
		const layout = reloaded.getRememberedSkeletonGuildRailLayout();
		expect(layout).not.toBeNull();
		expect(layout?.feedVisible).toBe(false);
	});
});
