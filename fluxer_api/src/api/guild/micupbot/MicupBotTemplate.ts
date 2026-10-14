// SPDX-License-Identifier: AGPL-3.0-or-later

export interface MicupBotTemplateVars {
	userId: string | bigint;
	userName: string;
	guildName: string;
	memberCount?: number;
	level?: number;
}
function escapeName(value: string): string {
	return value.replace(/@(?=everyone|here)/g, '@\u200b').replace(/[*_~|`>@<\\[\]()]/g, '\\$&');
}
export function renderMicupBotTemplate(template: string, vars: MicupBotTemplateVars): string {
	const values: Record<string, string> = {
		user: `<@${vars.userId}>`,
		'user.name': escapeName(vars.userName),
		'user.id': String(vars.userId),
		server: escapeName(vars.guildName),
		'server.members': vars.memberCount === undefined ? '' : String(vars.memberCount),
		level: vars.level === undefined ? '' : String(vars.level),
	};
	return template
		.replace(/\{([^{}]+)\}/g, (original, key: string) => (Object.hasOwn(values, key) ? values[key] : original))
		.slice(0, 2000);
}
