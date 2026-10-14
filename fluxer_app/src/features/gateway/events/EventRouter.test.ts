// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';

// Every handler module pulls in stores and lingui macros that vitest cannot load, so each import of the router is
// replaced by stubs of the names it takes.
const routerSource = readFileSync(new URL('./EventRouter.ts', import.meta.url), 'utf8');
for (const [, names, path] of routerSource.matchAll(/^import \{([^}]+)\} from '([^']+)';/gm)) {
	const stubs = Object.fromEntries(names.split(',').map((name) => [name.trim(), () => {}]));
	vi.doMock(path, () => stubs);
}

const {createHandlerRegistry} = await import('@app/features/gateway/events/EventRouter');
const {handleFollowCreate} = await import('@app/features/follow/events/FollowCreate');
const {handleFollowDelete} = await import('@app/features/follow/events/FollowDelete');
const {handleFeedNotificationCreate} = await import('@app/features/feed/events/FeedNotificationCreate');
const {handleFeedNotificationAck} = await import('@app/features/feed/events/FeedNotificationAck');
const {handleTableGameUpdate} = await import('@app/features/table_game/events/TableGameUpdate');

describe('gateway event router', () => {
	it('routes the follow and feed events to their handlers', () => {
		const registry = createHandlerRegistry();
		expect(registry.get('FOLLOW_CREATE')).toBe(handleFollowCreate);
		expect(registry.get('FOLLOW_DELETE')).toBe(handleFollowDelete);
		expect(registry.get('FEED_NOTIFICATION_CREATE')).toBe(handleFeedNotificationCreate);
		expect(registry.get('FEED_NOTIFICATION_ACK')).toBe(handleFeedNotificationAck);
	});

	it('TABLE_GAME_UPDATE routes to handleTableGameUpdate', () => {
		expect(createHandlerRegistry().get('TABLE_GAME_UPDATE')).toBe(handleTableGameUpdate);
	});
});
