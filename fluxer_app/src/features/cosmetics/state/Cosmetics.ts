// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import * as CosmeticCommands from '@app/features/cosmetics/commands/CosmeticCommands';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import Users from '@app/features/user/state/Users';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {makeAutoObservable, runInAction} from 'mobx';

export interface CosmeticItem extends CosmeticItemResponse {
	owned: boolean;
}

// The shared schema's CosmeticItemType widens to string, so the four slots are spelled out here.
export const COSMETIC_TYPES = ['avatar_decoration', 'avatar_ultra', 'nameplate', 'profile_effect'] as const;
export type CosmeticType = (typeof COSMETIC_TYPES)[number];
// sanalyer: ultra decorations (Micup's wings) stay in the model and the API, but no screen offers them: the catalog
// has none and the instance sells none. Pickers, shop tabs and the settings search list these types only.
export const VISIBLE_COSMETIC_TYPES: ReadonlyArray<CosmeticType> = COSMETIC_TYPES.filter(
	(type) => type !== 'avatar_ultra',
);
export type CosmeticSelection = Partial<Record<CosmeticType, string | null>>;

const EQUIP_FIELDS = {
	avatar_decoration: 'avatar_decoration_id',
	avatar_ultra: 'avatar_ultra_id',
	profile_effect: 'profile_effect_id',
	nameplate: 'nameplate_id',
} as const satisfies Record<CosmeticType, keyof CosmeticCommands.EquipCosmeticsBody>;

// Owned items the catalog stopped offering stay wearable, so they follow the catalog. Items only an owner can wear
// stay hidden until they are owned: nothing on this tab can sell them.
export function mergeCosmeticItems(
	catalog: ReadonlyArray<CosmeticItemResponse>,
	owned: ReadonlyArray<CosmeticItemResponse>,
): Array<CosmeticItem> {
	const ownedIds = new Set(owned.map((item) => item.id));
	const catalogIds = new Set(catalog.map((item) => item.id));
	return [...catalog, ...owned.filter((item) => !catalogIds.has(item.id))]
		.map((item) => ({...item, owned: ownedIds.has(item.id)}))
		.filter((item) => item.owned || item.availability !== 'owned');
}

export function isCosmeticLocked(item: CosmeticItem, isPremium: boolean): boolean {
	return !item.owned && item.availability === 'premium' && !isPremium;
}

class Cosmetics {
	items: ReadonlyArray<CosmeticItem> = [];
	profileEffectId: string | null = null;
	private generation = 0;
	ready = false;
	failed = false;

	constructor() {
		makeAutoObservable<Cosmetics, 'generation'>(this, {generation: false}, {autoBind: true});
	}

	itemsOfType(type: CosmeticType): Array<CosmeticItem> {
		return this.items.filter((item) => item.type === type);
	}

	getItem(itemId: string | null): CosmeticItem | null {
		return itemId ? (this.items.find((item) => item.id === itemId) ?? null) : null;
	}

	// The frame, ultra decoration and nameplate are read off the current user, which USER_UPDATE keeps current in every session.
	equippedId(type: CosmeticType): string | null {
		const user = Users.currentUser;
		switch (type) {
			case 'avatar_decoration':
				return user?.avatarDecoration?.item_id ?? null;
			case 'avatar_ultra':
				return user?.avatarUltra?.item_id ?? null;
			case 'nameplate':
				return user?.nameplate?.item_id ?? null;
			case 'profile_effect':
				return this.profileEffectId;
		}
	}

	reset(): void {
		this.generation++;
		this.items = [];
		this.profileEffectId = null;
		this.ready = false;
		this.failed = false;
	}

	async load(): Promise<void> {
		if (AccountScopedWork.isSuspended) return;
		const generation = this.generation;
		this.failed = false;
		try {
			const [catalog, mine] = await Promise.all([
				CosmeticCommands.fetchCatalog(),
				CosmeticCommands.fetchUserCosmetics(),
			]);
			runInAction(() => {
				if (generation !== this.generation) return;
				this.items = mergeCosmeticItems(catalog, mine.owned);
				this.profileEffectId = mine.equipped.profile_effect_id;
				this.ready = true;
			});
		} catch {
			runInAction(() => {
				if (generation !== this.generation) return;
				this.failed = true;
			});
		}
	}

	// Sends only the changed slots: every save fans the user change out to all of their communities.
	async equip(selection: CosmeticSelection): Promise<void> {
		if (AccountScopedWork.isSuspended) return;
		const generation = this.generation;
		const body: CosmeticCommands.EquipCosmeticsBody = {};
		for (const [type, itemId] of Object.entries(selection) as Array<[CosmeticType, string | null]>) {
			body[EQUIP_FIELDS[type]] = itemId;
		}
		const equipped = await CosmeticCommands.equip(body);
		if (generation !== this.generation) return;
		if (selection.profile_effect !== undefined) {
			// The effect lives on the profile, which no gateway event updates.
			runInAction(() => {
				if (generation !== this.generation) return;
				this.profileEffectId = equipped.profile_effect_id;
			});
			UserProfileCommands.clearCurrentUserProfiles();
		}
	}
}

const cosmetics = new Cosmetics();
ResettableStates.register(cosmetics, cosmetics.reset);
AccountScopedWork.registerCancellation(() => cosmetics.reset());

export default cosmetics;
