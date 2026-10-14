// SPDX-License-Identifier: AGPL-3.0-or-later

// Secrets that ride in request paths: gift codes (/gifts/<code>, /test/gifts/<code>), shop code lookups
// (/shop/codes/<code>) and Payriff callback tokens (/payriff/callback/<order_id>/<token>). Matched anywhere and in
// any case, so a mistyped or unrouted path that still carries the secret is masked too (kapı şart 11). Every log line
// that carries a request path goes through here: the request log, the error log and the response validation log.
const MASKS: ReadonlyArray<[RegExp, string]> = [
	[/(\/gifts\/)[^/]+/giu, '$1:code'],
	[/(\/shop\/codes\/)[^/]+/giu, '$1:code'],
	[/(\/payriff\/callback\/[^/]+\/)[^/]+/giu, '$1:token'],
];

export function redactRequestLogPath(path: string): string {
	return MASKS.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), path);
}
