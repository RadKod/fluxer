// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import {showVoiceMemberModerationFailedModal} from '@app/features/app/components/alerts/VoiceMemberModerationFailedModal';
import {moveVoiceParticipantToChannel} from '@app/features/app/components/layout/dnd/VoiceParticipantDrop';
import {DragItemType} from '@app/features/app/components/layout/types/DndTypes';
import Channels from '@app/features/channel/state/Channels';
import * as GuildMemberCommands from '@app/features/member/commands/GuildMemberCommands';
import Permission from '@app/features/permissions/state/Permission';
import * as PermissionUtils from '@app/features/permissions/utils/PermissionUtils';
import Users from '@app/features/user/state/Users';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {parse} from '@babel/parser';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {transformSync} from 'esbuild';
import {beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/app/components/alerts/VoiceMemberModerationFailedModal', () => ({
	showVoiceMemberModerationFailedModal: vi.fn(),
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: vi.fn()}}));
vi.mock('@app/features/member/commands/GuildMemberCommands', () => ({update: vi.fn()}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: vi.fn()}}));
vi.mock('@app/features/permissions/utils/PermissionUtils', () => ({can: vi.fn()}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: vi.fn()}}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: {connectToVoiceChannel: vi.fn()}}));

interface DropSpec {
	accept: string | Array<string>;
	canDrop: (item: object) => boolean;
	drop: (item: object, monitor: {canDrop: () => boolean}) => unknown;
	collect: (monitor: {isOver: () => boolean; canDrop: () => boolean}) => Record<string, boolean>;
}

// Build the production useDrop spec of a component without mounting it and its DnD providers.
function dropSpec(path: string, scope: Record<string, unknown>): DropSpec {
	const source = readFileSync(new URL(path, import.meta.url), 'utf8');
	const ast = parse(source, {sourceType: 'module', plugins: ['typescript', 'jsx']});
	let factory = '';
	function visit(node: unknown): void {
		if (factory || !node || typeof node !== 'object') return;
		const value = node as {
			type?: string;
			callee?: {name?: string};
			arguments?: Array<{start: number; end: number}>;
		};
		if (value.type === 'CallExpression' && value.callee?.name === 'useDrop' && value.arguments?.[0]) {
			factory = source.slice(value.arguments[0].start, value.arguments[0].end);
			return;
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	}
	visit(ast.program);
	if (!factory) throw new Error(`useDrop spec not found in ${path}`);
	const names = Object.keys(scope);
	return new Function(...names, transformSync(`return (${factory})();`, {loader: 'ts'}).code)(
		...Object.values(scope),
	) as DropSpec;
}

const shared = {
	DragItemType,
	guild: {id: 'guild'},
	channel: {id: 'target'},
	moveVoiceParticipantToChannel,
	Channels,
	PermissionUtils,
};

const surfaces: Array<[string, () => DropSpec]> = [
	[
		'channel row',
		() =>
			dropSpec('../ChannelItem.tsx', {
				...shared,
				channelIsVoice: true,
				dropTargetData: {},
				dropTargetRef: {current: null},
				canChannelDropOnTarget: () => true,
				selectChannelReorderResolution: () => ({indicator: null, intent: null}),
				setDropIndicator: vi.fn(),
				onChannelDrop: vi.fn(),
			}),
	],
	['participant list', () => dropSpec('../VoiceParticipantsList.tsx', shared)],
];

const participant = {
	type: DragItemType.VOICE_PARTICIPANT,
	id: 'member',
	userId: 'member',
	currentChannelId: 'source',
};
const monitor = {canDrop: () => true};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(Permission.can).mockImplementation((permission) => permission === Permissions.MOVE_MEMBERS);
	vi.mocked(Users.getCurrentUser).mockReturnValue({id: 'mover'} as ReturnType<typeof Users.getCurrentUser>);
	vi.mocked(GuildMemberCommands.update).mockResolvedValue({} as never);
	vi.mocked(Channels.getChannel).mockReturnValue({id: 'target', toJSON: () => ({id: 'target'})} as never);
	vi.mocked(PermissionUtils.can).mockImplementation((permission) => permission !== Permissions.CONNECT);
});

test('the participant list accepts only voice participant drags', () => {
	expect([dropSpec('../VoiceParticipantsList.tsx', shared).accept].flat()).toEqual([DragItemType.VOICE_PARTICIPANT]);
});

test('the participant list of the member current channel is not a drop target and does not light up', () => {
	const list = dropSpec('../VoiceParticipantsList.tsx', shared);
	expect(list.canDrop({...participant, currentChannelId: 'target'})).toBe(false);
	expect(list.canDrop(participant)).toBe(true);
	expect(list.collect({isOver: () => true, canDrop: () => false})).toEqual({isOver: true, canDrop: false});
});

describe.each(surfaces)('voice participant dropped on the %s', (_name, spec) => {
	test('moving a member who lacks CONNECT on the destination still sends the move to the server', () => {
		spec().drop(participant, monitor);
		expect(GuildMemberCommands.update).toHaveBeenCalledWith('guild', 'member', {channel_id: 'target'});
		expect(PermissionUtils.can).not.toHaveBeenCalledWith(Permissions.CONNECT, expect.anything(), expect.anything());
	});

	test('a mover allowed MOVE_MEMBERS on the guild but denied it on the destination channel sends nothing', () => {
		vi.mocked(Permission.can).mockImplementation(
			(permission, context) =>
				permission === Permissions.MOVE_MEMBERS &&
				(context as {channelId?: string} | undefined)?.channelId !== 'target',
		);
		spec().drop(participant, monitor);
		expect(GuildMemberCommands.update).not.toHaveBeenCalled();
	});

	test('a mover without MOVE_MEMBERS sends nothing', () => {
		vi.mocked(Permission.can).mockReturnValue(false);
		spec().drop(participant, monitor);
		expect(GuildMemberCommands.update).not.toHaveBeenCalled();
	});

	test('a drop on the member current channel is a no-op', () => {
		spec().drop({...participant, currentChannelId: 'target'}, monitor);
		expect(GuildMemberCommands.update).not.toHaveBeenCalled();
		expect(MediaEngine.connectToVoiceChannel).not.toHaveBeenCalled();
	});

	test('dragging yourself with CONNECT but without MOVE_MEMBERS switches your own connection', () => {
		vi.mocked(Permission.can).mockImplementation(
			(permission, context) =>
				permission === Permissions.CONNECT && (context as {channelId?: string} | undefined)?.channelId === 'target',
		);
		spec().drop({...participant, id: 'mover', userId: 'mover'}, monitor);
		expect(MediaEngine.connectToVoiceChannel).toHaveBeenCalledWith('guild', 'target');
		expect(GuildMemberCommands.update).not.toHaveBeenCalled();
	});

	test('dragging yourself without CONNECT on the destination does nothing', () => {
		spec().drop({...participant, id: 'mover', userId: 'mover'}, monitor);
		expect(MediaEngine.connectToVoiceChannel).not.toHaveBeenCalled();
		expect(GuildMemberCommands.update).not.toHaveBeenCalled();
	});

	test('a rejected move shows the voice moderation failure modal', async () => {
		const error = new Error('rejected');
		vi.mocked(GuildMemberCommands.update).mockRejectedValue(error);
		spec().drop(participant, monitor);
		await vi.waitFor(() =>
			expect(showVoiceMemberModerationFailedModal).toHaveBeenCalledWith(
				error,
				expect.objectContaining({message: 'Move to…'}),
			),
		);
	});
});
