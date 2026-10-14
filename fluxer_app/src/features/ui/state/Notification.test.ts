// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const push = vi.hoisted(() => ({
	registerPushSubscription: vi.fn(async () => null),
	unregisterAllPushSubscriptions: vi.fn(async () => {}),
}));
vi.mock('@app/features/platform/push/PushSubscriptionService', () => push);
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
// Only permission, persistence and push paths run here; the message and relationship stores are not reached.
vi.mock('@app/app/Routes', () => ({Routes: {}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {}}));
vi.mock('@app/features/auth/state/Accounts', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/forum/utils/ForumNotificationUtils', () => ({
	formatNewPostNotificationSuffix: vi.fn(),
	resolveNewPostNotificationLevel: vi.fn(),
}));
vi.mock('@app/features/guild/state/GuildMatureContentAgree', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/messaging/models/MessagingMessage', () => ({Message: class {}}));
vi.mock('@app/features/messaging/utils/MessageUtils', () => ({}));
vi.mock('@app/features/navigation/state/Navigation', () => ({default: {}}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn()}));
vi.mock('@app/features/notification/utils/MessageNotificationPreview', () => ({buildMessageNotificationBody: vi.fn()}));
vi.mock('@app/features/notification/utils/NotificationIconURL', () => ({getNotificationIconURL: vi.fn()}));
vi.mock('@app/features/notification/utils/SoundUtils', () => ({SoundType: {}}));
vi.mock('@app/features/presence/state/LocalPresence', () => ({default: {}}));
vi.mock('@app/features/relationship/state/FriendsTab', () => ({default: {}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {}}));
vi.mock('@app/features/relationship/utils/RelationshipMessageDescriptors', () => ({FRIEND_ADDED_DESCRIPTOR: {}}));
vi.mock('@app/features/streamer_mode/state/StreamerMode', () => ({default: {}}));
vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: vi.fn()}));
vi.mock('@app/features/ui/state/Modal', () => ({default: {}}));
vi.mock('@app/features/ui/state/Sound', () => ({default: {}}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {}}));
vi.mock('@app/features/user/state/Users', () => ({default: {}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({}));

const STORAGE_KEY = 'Notification';
const OLD_DEFAULT_STORED = JSON.stringify({
	browserNotificationsEnabled: false,
	unreadMessageBadgeEnabled: true,
	ttsNotificationMode: 2,
	__mps__: {version: 1},
});

function setBrowserPermission(permission: NotificationPermission): void {
	vi.stubGlobal('Notification', {permission, requestPermission: vi.fn(async () => permission)});
}

function readStored(): Record<string, unknown> {
	return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
}

let stopCurrentPersistence: (() => void) | undefined;

async function loadNotification() {
	stopCurrentPersistence?.();
	vi.resetModules();
	const notification = (await import('@app/features/ui/state/Notification')).default;
	const {awaitHydration, stopPersistent} = await import('@app/features/platform/utils/MobXPersistence');
	await awaitHydration(STORAGE_KEY);
	stopCurrentPersistence = () => stopPersistent(STORAGE_KEY, notification);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return notification;
}

function flushPersistedWrites(): void {
	window.dispatchEvent(new Event('pagehide'));
}

describe('Notification desktop notifications default', () => {
	beforeEach(() => {
		window.localStorage.clear();
		push.registerPushSubscription.mockClear();
	});

	afterEach(() => {
		stopCurrentPersistence?.();
		stopCurrentPersistence = undefined;
		window.localStorage.clear();
		vi.unstubAllGlobals();
		delete (window as {electron?: unknown}).electron;
		delete (window.navigator as {standalone?: unknown}).standalone;
	});

	it('turns desktop notifications on for a fresh install', async () => {
		setBrowserPermission('granted');

		const notification = await loadNotification();

		expect(notification.getBrowserNotificationsEnabled()).toBe(true);
	});

	it('turns them on in the desktop app without a browser prompt', async () => {
		(window as {electron?: unknown}).electron = {platform: 'win32', onNotificationClick: vi.fn()};

		const notification = await loadNotification();

		expect(notification.getBrowserNotificationsEnabled()).toBe(true);
	});

	it('waits for the permission prompt while the browser permission is still default', async () => {
		setBrowserPermission('default');

		const notification = await loadNotification();

		expect(notification.getBrowserNotificationsEnabled()).toBe(false);
		setBrowserPermission('granted');
		notification.handleNotificationPermissionGranted();
		expect(notification.getBrowserNotificationsEnabled()).toBe(true);
	});

	it('moves an off saved by the old default to on once', async () => {
		(window as {electron?: unknown}).electron = {platform: 'win32', onNotificationClick: vi.fn()};
		window.localStorage.setItem(STORAGE_KEY, OLD_DEFAULT_STORED);

		const notification = await loadNotification();

		expect(notification.getBrowserNotificationsEnabled()).toBe(true);
		expect(readStored().browserNotificationsDefaultOnMigratedV1).toBe(true);
	});

	it('keeps notifications off when the user turns them off after the one-time move', async () => {
		setBrowserPermission('granted');
		window.localStorage.setItem(STORAGE_KEY, OLD_DEFAULT_STORED);
		const first = await loadNotification();
		expect(first.getBrowserNotificationsEnabled()).toBe(true);

		first.handleNotificationPermissionDenied();
		flushPersistedWrites();
		const second = await loadNotification();

		expect(second.getBrowserNotificationsEnabled()).toBe(false);
	});

	it('keeps the migration flag with the value when storage was reset mid-session', async () => {
		setBrowserPermission('granted');
		window.localStorage.setItem(STORAGE_KEY, OLD_DEFAULT_STORED);
		const first = await loadNotification();

		window.localStorage.clear();
		first.handleNotificationPermissionDenied();
		flushPersistedWrites();

		expect(readStored()).toMatchObject({
			browserNotificationsEnabled: false,
			browserNotificationsDefaultOnMigratedV1: true,
		});
		const second = await loadNotification();
		expect(second.getBrowserNotificationsEnabled()).toBe(false);
	});

	it('does not write on when the browser has blocked notifications', async () => {
		setBrowserPermission('denied');
		window.localStorage.setItem(STORAGE_KEY, OLD_DEFAULT_STORED);

		const notification = await loadNotification();

		// Read before the delayed persist write that follows refreshPermission, so this is what the move stored.
		expect(readStored()).toMatchObject({
			browserNotificationsEnabled: false,
			browserNotificationsDefaultOnMigratedV1: true,
		});
		expect(notification.getBrowserNotificationsEnabled()).toBe(false);
	});

	it('registers the installed-app push subscription only once permission is granted', async () => {
		(window.navigator as {standalone?: unknown}).standalone = true;
		setBrowserPermission('default');
		const notification = await loadNotification();
		expect(push.registerPushSubscription).not.toHaveBeenCalled();

		setBrowserPermission('granted');
		notification.handleNotificationPermissionGranted();
		expect(push.registerPushSubscription).toHaveBeenCalledTimes(1);
	});
});
