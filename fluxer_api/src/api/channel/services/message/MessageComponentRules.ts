// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {MessageActionRowData, MessageComponentData} from '@app/api/database/types/MessageTypes';
import {isOfficialComponentBot} from '@app/api/guild/OfficialBots';
import type {Message} from '@app/api/models/Message';
import {MESSAGE_COMPONENT_LIMITS, MessageComponentTypes} from '@fluxer/constants/src/MessageComponentConstants';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';

export function assertComponentsAuthor(userId: UserID): void {
	if (!isOfficialComponentBot(userId)) throw new MissingPermissionsError();
}

// Only server code writes buttons, so a bad row is a programmer error, not a 400. An empty list is refused too: the
// response leaves it out and clients keep the old row, so v1 bots disable buttons instead of removing them.
export function validateMessageComponents(rows: ReadonlyArray<MessageActionRowData>): void {
	const limits = MESSAGE_COMPONENT_LIMITS;
	if (rows.length === 0 || rows.length > limits.rows) throw new Error('invalid component row count');
	for (const row of rows) {
		const buttons = row.components ?? [];
		if (row.type !== MessageComponentTypes.ACTION_ROW || buttons.length === 0 || buttons.length > limits.buttonsPerRow)
			throw new Error('invalid component row');
		for (const b of buttons) {
			if (
				b.type !== MessageComponentTypes.BUTTON ||
				!b.custom_id ||
				b.custom_id.length > limits.customIdMax ||
				(b.label ?? '').length > limits.labelMax ||
				!b.style ||
				b.style < 1 ||
				b.style > 4
			)
				throw new Error('invalid button');
		}
	}
}

// sendMessage and editMessage call this first whenever server code passes buttons.
export function assertComponentsWritable(userId: UserID, rows: ReadonlyArray<MessageActionRowData>): void {
	assertComponentsAuthor(userId);
	validateMessageComponents(rows);
}

export function findClickableButton(message: Message, customId: string): MessageComponentData | null {
	if (message.webhookId) return null;
	for (const row of message.components)
		for (const b of row.components ?? []) if (b.custom_id === customId) return b.disabled ? null : b;
	return null;
}

export function disableAllComponents(rows: ReadonlyArray<MessageActionRowData>): Array<MessageActionRowData> {
	return rows.map((row) => ({...row, components: (row.components ?? []).map((b) => ({...b, disabled: true}))}));
}

export function button(p: {
	customId: string;
	label: string;
	style: number;
	emoji?: string;
	disabled?: boolean;
}): MessageComponentData {
	return {
		type: MessageComponentTypes.BUTTON,
		style: p.style,
		label: p.label,
		emoji_name: p.emoji ?? null,
		emoji_id: null,
		emoji_animated: null,
		custom_id: p.customId,
		disabled: p.disabled ?? false,
	};
}

export function actionRow(buttons: Array<MessageComponentData>): MessageActionRowData {
	return {type: MessageComponentTypes.ACTION_ROW, components: buttons};
}
