// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ApplicationCommandOptionTypes,
	ApplicationCommandTypes,
	MAX_APPLICATION_COMMAND_BYTES,
	MAX_APPLICATION_COMMAND_CHOICE_NAME_LENGTH,
	MAX_APPLICATION_COMMAND_CHOICE_STRING_LENGTH,
	MAX_APPLICATION_COMMAND_CHOICES,
	MAX_APPLICATION_COMMAND_DESCRIPTION_LENGTH,
	MAX_APPLICATION_COMMAND_NAME_LENGTH,
	MAX_APPLICATION_COMMAND_OPTIONS,
	MAX_APPLICATION_COMMAND_SET_BYTES,
	MAX_APPLICATION_COMMAND_STRING_LENGTH,
	MAX_APPLICATION_COMMANDS_PER_SCOPE,
} from '@fluxer/constants/src/ApplicationCommandConstants';
import {ALL_PERMISSIONS} from '@fluxer/constants/src/ChannelConstants';
import {SnowflakeStringType, UnsignedInt64StringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

function codePointString(min: number, max: number) {
	return z.string().refine((value) => {
		const length = Array.from(value).length;
		return length >= min && length <= max;
	}, `Expected ${min}–${max} Unicode code points`);
}

export const ApplicationCommandName = z
	.string()
	.normalize('NFC')
	.pipe(
		codePointString(1, MAX_APPLICATION_COMMAND_NAME_LENGTH).refine(
			(value) => /^[\p{L}\p{N}_-]+$/u.test(value) && value === value.toLowerCase(),
			'Expected lowercase letters, numbers, hyphens or underscores',
		),
	);

// Wire IDs remain strings and share the storage primitive's signed 64-bit snowflake range.
export const ApplicationCommandSnowflake = SnowflakeStringType.max(19).pipe(
	z.string().refine((value) => value !== '0' && BigInt(value) <= 9223372036854775807n, 'Invalid snowflake'),
);
export const ApplicationCommandInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const ApplicationCommandNumber = z.number().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const ApplicationCommandStringValue = codePointString(0, MAX_APPLICATION_COMMAND_STRING_LENGTH);

const Description = codePointString(1, MAX_APPLICATION_COMMAND_DESCRIPTION_LENGTH);
const ChoiceName = codePointString(1, MAX_APPLICATION_COMMAND_CHOICE_NAME_LENGTH);
const OptionFields = {name: ApplicationCommandName, description: Description, required: z.boolean()};

function choices<T extends z.ZodType>(value: T) {
	return z
		.array(z.strictObject({name: ChoiceName, value}))
		.max(MAX_APPLICATION_COMMAND_CHOICES)
		.optional();
}

export const ApplicationCommandOption = z.discriminatedUnion('type', [
	z.strictObject({
		...OptionFields,
		type: z.literal(ApplicationCommandOptionTypes.STRING),
		choices: choices(codePointString(0, MAX_APPLICATION_COMMAND_CHOICE_STRING_LENGTH)),
	}),
	z.strictObject({
		...OptionFields,
		type: z.literal(ApplicationCommandOptionTypes.INTEGER),
		choices: choices(ApplicationCommandInteger),
	}),
	z.strictObject({...OptionFields, type: z.literal(ApplicationCommandOptionTypes.BOOLEAN)}),
	z.strictObject({...OptionFields, type: z.literal(ApplicationCommandOptionTypes.USER)}),
	z.strictObject({...OptionFields, type: z.literal(ApplicationCommandOptionTypes.CHANNEL)}),
	z.strictObject({...OptionFields, type: z.literal(ApplicationCommandOptionTypes.ROLE)}),
	z.strictObject({
		...OptionFields,
		type: z.literal(ApplicationCommandOptionTypes.NUMBER),
		choices: choices(ApplicationCommandNumber),
	}),
]);
export type ApplicationCommandOption = z.infer<typeof ApplicationCommandOption>;

const Options = z
	.array(ApplicationCommandOption)
	.max(MAX_APPLICATION_COMMAND_OPTIONS)
	.superRefine((options, ctx) => {
		const names = new Set<string>();
		let optionalSeen = false;
		for (const [index, option] of options.entries()) {
			if (names.has(option.name))
				ctx.addIssue({code: 'custom', path: [index, 'name'], message: 'Duplicate option name'});
			names.add(option.name);
			if (option.required && optionalSeen)
				ctx.addIssue({
					code: 'custom',
					path: [index, 'required'],
					message: 'Required options must precede optional options',
				});
			if (!option.required) optionalSeen = true;
		}
	});

const DefaultMemberPermissions = z
	.string()
	.max(20)
	.regex(/^(0|[1-9][0-9]*)$/)
	.pipe(UnsignedInt64StringType)
	.pipe(z.string().refine((value) => (BigInt(value) & ~ALL_PERMISSIONS) === 0n, 'Unsupported permission bits'))
	.nullable();

const CommandFields = {
	type: z.literal(ApplicationCommandTypes.CHAT_INPUT).default(ApplicationCommandTypes.CHAT_INPUT),
	name: ApplicationCommandName,
	description: Description,
	options: Options.default([]),
	default_member_permissions: DefaultMemberPermissions.default(null),
	dm_permission: z.boolean().default(false),
};

// These bounds apply to normalized JSON; controllers must also bound the raw HTTP body before parsing it.
function commandWithinByteLimit(command: unknown): boolean {
	return new TextEncoder().encode(JSON.stringify(command)).byteLength <= MAX_APPLICATION_COMMAND_BYTES;
}

// Reserve worst-case guild metadata even for global commands; appending fields replaces one brace with a comma.
const MAX_COMMAND_SERVER_FIELDS_BYTES =
	new TextEncoder().encode(
		JSON.stringify({
			id: '9223372036854775807',
			application_id: '9223372036854775807',
			version: '9223372036854775807',
			guild_id: '9223372036854775807',
		}),
	).byteLength - 1;

function commandRequestWithinByteLimit(command: unknown): boolean {
	return (
		new TextEncoder().encode(JSON.stringify(command)).byteLength + MAX_COMMAND_SERVER_FIELDS_BYTES <=
		MAX_APPLICATION_COMMAND_BYTES
	);
}

export const ApplicationCommandRequest = z
	.strictObject(CommandFields)
	.refine(commandRequestWithinByteLimit, 'Command exceeds UTF-8 byte limit');
export type ApplicationCommandRequest = z.infer<typeof ApplicationCommandRequest>;

export const GuildApplicationCommandRequest = z
	.strictObject({...CommandFields, dm_permission: z.literal(false).default(false)})
	.refine(commandRequestWithinByteLimit, 'Command exceeds UTF-8 byte limit');
export type GuildApplicationCommandRequest = z.infer<typeof GuildApplicationCommandRequest>;

function commandSet<T extends z.ZodType<{name: string}>>(command: T) {
	return z
		.array(command)
		.max(MAX_APPLICATION_COMMANDS_PER_SCOPE)
		.refine((commands) => new Set(commands.map(({name}) => name)).size === commands.length, 'Duplicate command name')
		.refine(
			(commands) =>
				new TextEncoder().encode(JSON.stringify(commands)).byteLength +
					commands.length * MAX_COMMAND_SERVER_FIELDS_BYTES <=
				MAX_APPLICATION_COMMAND_SET_BYTES,
			'Command set exceeds UTF-8 byte limit',
		);
}

export const ApplicationCommandBulkOverwriteRequest = commandSet(ApplicationCommandRequest);
export type ApplicationCommandBulkOverwriteRequest = z.infer<typeof ApplicationCommandBulkOverwriteRequest>;
export const GuildApplicationCommandBulkOverwriteRequest = commandSet(GuildApplicationCommandRequest);
export type GuildApplicationCommandBulkOverwriteRequest = z.infer<typeof GuildApplicationCommandBulkOverwriteRequest>;

export const ApplicationCommandResponse = z
	.strictObject({
		...CommandFields,
		id: ApplicationCommandSnowflake,
		application_id: ApplicationCommandSnowflake,
		version: ApplicationCommandSnowflake,
		guild_id: ApplicationCommandSnowflake.optional(),
	})
	.refine((command) => command.guild_id === undefined || !command.dm_permission, 'Guild commands cannot permit DM use')
	.refine(commandWithinByteLimit, 'Command exceeds UTF-8 byte limit');
export type ApplicationCommandResponse = z.infer<typeof ApplicationCommandResponse>;

export const ApplicationCommandsUpdateEvent = z.strictObject({
	application_id: ApplicationCommandSnowflake,
	scope_id: ApplicationCommandSnowflake,
	version: ApplicationCommandSnowflake,
});
export type ApplicationCommandsUpdateEvent = z.infer<typeof ApplicationCommandsUpdateEvent>;
