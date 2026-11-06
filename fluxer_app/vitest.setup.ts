// SPDX-License-Identifier: AGPL-3.0-or-later

import {vi} from 'vitest';

interface TestLockManager {
	request<Result>(name: string, operation: () => Promise<Result>): Promise<Result>;
}

function createTestLockManager(): TestLockManager {
	const tails = new Map<string, Promise<void>>();
	return {
		request<Result>(name: string, operation: () => Promise<Result>): Promise<Result> {
			const result = (tails.get(name) ?? Promise.resolve()).then(operation);
			const tail = result.then(
				() => undefined,
				() => undefined,
			);
			tails.set(name, tail);
			void tail.then(() => {
				if (tails.get(name) === tail) {
					tails.delete(name);
				}
			});
			return result;
		},
	};
}

if (typeof window !== 'undefined' && window.localStorage === undefined && typeof Storage === 'function') {
	Object.defineProperty(window, 'localStorage', {value: new Storage(), configurable: true, writable: true});
}

if (typeof navigator !== 'undefined' && navigator.locks == null) {
	Object.defineProperty(navigator, 'locks', {value: createTestLockManager(), configurable: true, writable: true});
}

// The Lingui macros are compiled away by the app build; under vitest they would need babel-plugin-macros. Tests that
// care about the text mock them themselves; everything else gets this runtime stand-in.
vi.mock('@lingui/core/macro', () => {
	const format = (message: string, values: Record<string, unknown> = {}): string =>
		message.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
	const fromTemplate = (strings: TemplateStringsArray, args: Array<unknown>): string =>
		strings.reduce((text, part, index) => text + part + (index < args.length ? String(args[index]) : ''), '');
	const msg = (descriptor: unknown, ...args: Array<unknown>) =>
		Array.isArray(descriptor)
			? {message: fromTemplate(descriptor as unknown as TemplateStringsArray, args)}
			: descriptor;
	return {
		msg,
		defineMessage: msg,
		t: (descriptor: unknown, ...args: Array<unknown>) => {
			if (Array.isArray(descriptor)) return fromTemplate(descriptor as unknown as TemplateStringsArray, args);
			const {message, id} = descriptor as {message?: string; id?: string};
			return format(message ?? id ?? '');
		},
		ph: (value: Record<string, unknown>) => Object.values(value)[0],
		plural: (value: number, forms: Record<string, string>) =>
			(forms[`=${value}`] ?? (value === 1 ? forms.one : undefined) ?? forms.other ?? '').replace('#', String(value)),
	};
});
vi.mock('@lingui/react/macro', async () => {
	const format = (message: string, values: Record<string, unknown> = {}): string =>
		message.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
	const translate = (descriptor: unknown, values?: Record<string, unknown>): string => {
		if (typeof descriptor === 'string') return format(descriptor, values);
		const {message, id} = descriptor as {message?: string; id?: string};
		return format(message ?? id ?? '', values);
	};
	const i18n = {locale: 'en-US', _: translate, t: translate};
	return {
		Trans: ({children, message, id}: {children?: unknown; message?: string; id?: string}) =>
			children ?? message ?? id ?? null,
		Plural: ({value, one, other, ...rest}: {value: number; one?: string; other?: string} & Record<string, unknown>) =>
			String((rest[`_${value}`] as string | undefined) ?? (value === 1 ? one : other) ?? '').replace(
				'#',
				String(value),
			),
		useLingui: () => ({i18n, _: translate, t: translate}),
	};
});
