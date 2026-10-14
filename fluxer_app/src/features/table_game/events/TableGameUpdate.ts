// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import TableGames from '@app/features/table_game/state/TableGames';
import type {TableGameUpdateEvent} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Sent only to the table's players and live spectators; each one gets its own view (own rack or none).
export function handleTableGameUpdate(data: TableGameUpdateEvent, _context: GatewayHandlerContext): void {
	TableGames.handleView(data.channel_id, data.view, 'event');
}
