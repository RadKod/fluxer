// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createChannelID, createUserID, type UserID} from '@app/api/BrandedTypes';
import {MICUPBOT_COMMAND_NAMES, MICUPBOT_LIMITS, MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ChannelUpdateRequest} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import {GuildBanCreateRequest, GuildMemberUpdateRequest} from '@fluxer/schema/src/domains/guild/GuildRequestSchemas';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {z} from 'zod';

export type MicupBotCommandName = (typeof MICUPBOT_COMMAND_NAMES)[number];

export function commandUsage(name: string): string {
	const line = MICUPBOT_TEXT.helpLines.find((line) => line.startsWith(`\`#${name}`));
	return MICUPBOT_TEXT.usage(line?.split('`')[1] ?? '#help');
}

export class MicupBotCommandUsageError extends Error {
	constructor(name: string) {
		super(commandUsage(name));
	}
}

export function commandInput<T>(schema: z.ZodType<T>, input: unknown, name: string): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new MicupBotCommandUsageError(name);
	return parsed.data;
}

export interface ParsedMicupBotCommand {
	name: MicupBotCommandName;
	userId?: UserID;
	channelId?: ChannelID;
	role?: string;
	duration?: number;
	reason?: string;
	nick?: string | null;
	seconds?: number;
	count?: number;
}

export function parseMicupBotCommand(content: string): ParsedMicupBotCommand {
	const [word, ...args] = content.trim().split(/\s+/);
	const name = word.slice(1).toLowerCase();
	if (!word.startsWith('#') || !MICUPBOT_COMMAND_NAMES.some((command) => command === name)) {
		throw new MicupBotCommandUsageError('help');
	}
	const command: ParsedMicupBotCommand = {name: name as MicupBotCommandName};
	const fail = (): never => {
		throw new MicupBotCommandUsageError(name);
	};
	const id = (value: string | undefined, mention: RegExp): bigint => {
		if (!value) return fail();
		return commandInput(SnowflakeType, value.match(mention)?.[1] ?? value, name);
	};
	const user = () => createUserID(id(args.shift(), /^<@!?(\d+)>$/));
	const channel = () => createChannelID(id(args.shift(), /^<#(\d+)>$/));
	const reason = (required = false) => {
		const text = args.splice(0).join(' ');
		if (required && !text) fail();
		command.reason = commandInput(GuildBanCreateRequest, {reason: text || undefined}, name).reason ?? undefined;
	};
	const duration = () => {
		const value = args.shift() ?? '';
		if (value === '0' && name === 'ban') return 0;
		const match = /^(\d+)(s|sn|m|dk|h|sa|d|g)$/i.exec(value);
		if (!match) return fail();
		const units: Record<string, number> = {s: 1, sn: 1, m: 60, dk: 60, h: 3600, sa: 3600, d: 86400, g: 86400};
		const seconds = Number(match[1]) * units[match[2].toLowerCase()];
		if (!Number.isSafeInteger(seconds) || seconds <= 0) return fail();
		return seconds;
	};
	switch (command.name) {
		case 'ban':
			command.userId = user();
			if (args[0] === '0' || /^\d+[a-z]+$/i.test(args[0] ?? '')) command.duration = duration();
			reason();
			commandInput(GuildBanCreateRequest, {reason: command.reason, ban_duration_seconds: command.duration}, name);
			break;
		case 'kick':
		case 'warn':
			command.userId = user();
			reason(command.name === 'warn');
			break;
		case 'mute':
		case 'timeout':
			command.userId = user();
			command.duration = duration();
			if (command.duration > MICUPBOT_LIMITS.muteMaxSeconds) fail();
			reason();
			break;
		case 'unban':
		case 'unmute':
		case 'warnings':
			command.userId = user();
			break;
		case 'user':
		case 'avatar':
		case 'rank':
			if (args.length) command.userId = user();
			break;
		case 'clear': {
			const count = args.shift() ?? '';
			if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 100) fail();
			command.count = Number(count);
			if (args.length) command.userId = user();
			break;
		}
		case 'lock':
		case 'unlock':
			if (args.length) command.channelId = channel();
			break;
		case 'slowmode': {
			const value = args.shift()?.toLowerCase() ?? '';
			if (!['kapat', 'off', '0'].includes(value) && !/^\d+$/.test(value)) fail();
			command.seconds = ['kapat', 'off', '0'].includes(value) ? 0 : Number(value);
			commandInput(ChannelUpdateRequest, {type: ChannelTypes.GUILD_TEXT, rate_limit_per_user: command.seconds}, name);
			if (args.length) command.channelId = channel();
			break;
		}
		case 'role':
			command.userId = user();
			command.role = args.splice(0).join(' ');
			if (!command.role) fail();
			break;
		case 'nick':
			command.userId = user();
			command.nick = commandInput(GuildMemberUpdateRequest, {nick: args.splice(0).join(' ') || null}, name).nick;
			break;
		case 'move':
			command.userId = user();
			command.channelId = channel();
			break;
	}
	if (args.length) fail();
	return command;
}
