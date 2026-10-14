// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({
	planned: new Map<string, string>(),
	cameras: true,
	showRoomCameras: true,
	showMyOwnCamera: true,
}));

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({user, decorationSurface}: {user: {id: string}; decorationSurface: string}) =>
		createElement('div', {'data-avatar': user.id, 'data-decoration': decorationSurface}),
}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	PreloadableUserPopout: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/action_menu/VoiceParticipantContextMenu', () => ({VoiceParticipantContextMenu: () => null}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, games: true, cameras: env.cameras}),
}));
vi.mock('@app/features/voice_scene/state/VoiceSceneSettings', () => ({
	default: {
		get showRoomCameras() {
			return env.showRoomCameras;
		},
	},
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({
	default: {getShowMyOwnCamera: () => env.showMyOwnCamera},
}));
vi.mock('@app/features/voice_scene/video/RoomCameraStore', () => ({
	default: {qualityOf: (identity: string) => env.planned.get(identity) ?? null},
}));
const publication = (sid: string) => ({trackSid: sid});
const remote = {identity: 'user_7_conn-7', getTrackPublication: () => publication('TR_cam_7')};
const local = {identity: 'user_1_conn-1', getTrackPublication: () => publication('TR_cam_1')};
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		channelId: '500',
		room: {
			localParticipant: local,
			getParticipantByIdentity: (identity: string) => (identity === remote.identity ? remote : undefined),
		},
	},
}));
vi.mock('@livekit/components-react', () => ({
	VideoTrack: ({
		trackRef,
		manageSubscription,
		...props
	}: {
		trackRef: {participant: {identity: string}; source: string};
		manageSubscription: boolean;
		className?: string;
	}) =>
		createElement('video', {
			...props,
			'data-video': trackRef.participant.identity,
			'data-source': trackRef.source,
			'data-managed': String(manageSubscription),
		}),
}));

const {VoiceSceneAvatar} = await import('@app/features/voice_scene/components/VoiceSceneAvatar');

function entry(
	userId: string,
	connectionId: string,
	extra: Partial<{isLocal: boolean; hasCamera: boolean; speaking: boolean}>,
) {
	return {
		user: {id: userId, username: `u${userId}`},
		userId,
		connectionId,
		speaking: false,
		hasCamera: true,
		hasScreenShare: false,
		isLocal: false,
		selfMute: false,
		selfDeaf: false,
		...extra,
	};
}

const REMOTE = entry('7', 'conn-7', {});
const ME = entry('1', 'conn-1', {isLocal: true});

let root: Root;
let host: HTMLDivElement;

function render(person: ReturnType<typeof entry>, cameraCard?: 'room' | 'seat'): void {
	act(() =>
		root.render(
			createElement(VoiceSceneAvatar, {entry: person as never, guildId: '9', channelId: '500', size: 40, cameraCard}),
		),
	);
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	Object.assign(env, {planned: new Map(), cameras: true, showRoomCameras: true, showMyOwnCamera: true});
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('VoiceSceneAvatar camera', () => {
	it('a shown table camera fills the whole accessible rectangular profile trigger and speaking ring', () => {
		env.planned.set('user_7_conn-7', 'medium');
		render({...REMOTE, speaking: true}, 'seat');
		const button = host.querySelector('button');
		expect(button?.getAttribute('data-camera-card')).toBe('seat');
		expect(button?.getAttribute('aria-label')).toBe('View profile for u7');
		expect(button?.getAttribute('data-speaking')).toBe('true');
		expect(button?.querySelector('video')?.getAttribute('data-embed-media')).toBe('');
	});

	it('camera off or not shown keeps the circular avatar even when a table requests a card', () => {
		render(REMOTE, 'room');
		expect(host.querySelector('button')?.hasAttribute('data-camera-card')).toBe(false);
		env.planned.set('user_7_conn-7', 'low');
		render({...REMOTE, hasCamera: false}, 'seat');
		expect(host.querySelector('button')?.hasAttribute('data-camera-card')).toBe(false);
	});

	it('a planned camera renders <video> inside the disc instead of the picture', () => {
		render(REMOTE);
		expect(host.querySelector('video')).toBeNull();
		env.planned.set('user_7_conn-7', 'low');
		render({...REMOTE});
		const video = host.querySelector('button video');
		expect(video?.getAttribute('data-video')).toBe('user_7_conn-7');
		expect(video?.getAttribute('data-source')).toBe('camera');
		// The room owns the subscription: the element never subscribes on its own.
		expect(video?.getAttribute('data-managed')).toBe('false');
	});

	it('decorations and the speaking ring stay', () => {
		env.planned.set('user_7_conn-7', 'medium');
		render({...REMOTE, speaking: true});
		const button = host.querySelector('button');
		expect(button?.getAttribute('data-speaking')).toBe('true');
		expect(button?.querySelector('[data-avatar="7"]')?.getAttribute('data-decoration')).toBe('voice');
		expect(button?.querySelector('video')).not.toBeNull();
	});

	it('own camera only as a local preview, per getShowMyOwnCamera', () => {
		render(ME);
		const video = host.querySelector('video');
		expect(video?.getAttribute('data-video')).toBe('user_1_conn-1');
		env.showMyOwnCamera = false;
		render({...ME});
		expect(host.querySelector('video')).toBeNull();
	});

	it('room cameras off (switch or setting) → pictures only, even my own', () => {
		env.planned.set('user_7_conn-7', 'low');
		env.cameras = false;
		render(ME);
		expect(host.querySelector('video')).toBeNull();
		env.cameras = true;
		env.showRoomCameras = false;
		render({...ME});
		expect(host.querySelector('video')).toBeNull();
	});
});
