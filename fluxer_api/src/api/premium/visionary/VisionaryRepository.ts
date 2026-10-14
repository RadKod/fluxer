// SPDX-License-Identifier: AGPL-3.0-or-later

import {deleteOneOrMany, executeConditional, fetchMany, fetchOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {VisionarySlotRow} from '@app/api/database/types/PaymentTypes';
import {VisionarySlots} from '@app/api/Tables';

type SlotPatch = Partial<Pick<VisionarySlotRow, 'user_id' | 'order_id' | 'held_until'>>;

const LIST_SLOTS_CQL = VisionarySlots.selectCql();
const FETCH_SLOT_CQL = VisionarySlots.selectCql({where: VisionarySlots.where.eq('slot_index'), limit: 1});

// Micup's writer for upstream's visionary_slots table: every write that hands a number out is a CAS on version, so a
// number never goes to two orders or two accounts. Upstream's unconditional writers are not used.
// held_until is a pending order's hold end; on a row with an owner it is when an admin took the number back.
export class VisionaryRepository {
	// TEMPORARY: whole-table read per hold and delivery (one row per slot, a few hundred bytes each); KV next-free
	// cursor + shop_orders.visionary_slot when total > 10 000 or order creation > 5/s.
	async listSlots(): Promise<Array<VisionarySlotRow>> {
		const rows = await fetchMany<VisionarySlotRow>(LIST_SLOTS_CQL, {});
		return rows.sort((a, b) => a.slot_index - b.slot_index);
	}

	async findSlot(slotIndex: number): Promise<VisionarySlotRow | null> {
		return fetchOne<VisionarySlotRow>(FETCH_SLOT_CQL, {slot_index: slotIndex});
	}

	// false for a lost race or a row without version (opened by upstream code; Micup never hands those out).
	async claim(slot: VisionarySlotRow, patch: SlotPatch): Promise<boolean> {
		if (slot.version == null) {
			return false;
		}
		const set: Parameters<typeof VisionarySlots.conditionalPatchByPk>[1] = {version: Db.set(slot.version + 1)};
		if (patch.user_id !== undefined) set.user_id = patch.user_id === null ? Db.clear() : Db.set(patch.user_id);
		if (patch.order_id !== undefined) set.order_id = patch.order_id === null ? Db.clear() : Db.set(patch.order_id);
		if (patch.held_until !== undefined) {
			set.held_until = patch.held_until === null ? Db.clear() : Db.set(patch.held_until);
		}
		return executeConditional(
			VisionarySlots.conditionalPatchByPk({slot_index: slot.slot_index}, set, {version: slot.version}),
		);
	}

	async insertSlot(row: VisionarySlotRow): Promise<boolean> {
		return executeConditional(VisionarySlots.insertIfNotExists(row));
	}

	// Conditional on the version read, so a slot claimed after the caller checked it is never dropped.
	async deleteSlot(slot: VisionarySlotRow): Promise<boolean> {
		if (slot.version == null) {
			await deleteOneOrMany(VisionarySlots.deleteByPk({slot_index: slot.slot_index}));
			return true;
		}
		return executeConditional(
			VisionarySlots.conditionalDeleteByPk({slot_index: slot.slot_index}, {version: slot.version}),
		);
	}
}
