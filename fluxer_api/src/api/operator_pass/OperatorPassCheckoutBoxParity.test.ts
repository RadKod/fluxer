// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONTENT_I18N_LOCALE_MESSAGES} from '@app/api/content_i18n/ContentI18nLocales';
import {CONTENT_I18N_MESSAGES} from '@app/api/content_i18n/ContentI18nMessages';
import MessageFormat from '@messageformat/core';
import {describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_LOCALES = path.resolve(THIS_DIR, '../../../../fluxer_app/src/features/i18n/locales');

const BOX_KEYS = [
	'billing.operator_pass_delivery_waiver',
	'billing.operator_pass_delivery_waiver_multiple',
	'billing.operator_pass_delivery_country_v5',
	'billing.operator_pass_delivery_country_multiple_v5',
	'billing.operator_pass_delivery_business',
	'billing.operator_pass_delivery_business_multiple',
] as const;

const VISIONARY_BOX_KEY = 'billing.operator_pass_visionary_terms_box';
const VISIONARY_BOX_APP_SOURCE =
	"I accept the <0>{OPERATOR_PASS_NAME} terms</0>. This pass is part of your Visionary, so it can't be passed on.";

// Reads msgid/msgstr pairs, wrapped across lines or not (lingui may wrap long entries).
function readPoCatalog(locale: string): Map<string, string> {
	const lines = fs.readFileSync(path.join(APP_LOCALES, locale, 'messages.po'), 'utf8').split('\n');
	const entries = new Map<string, string>();
	let field: 'msgid' | 'msgstr' | null = null;
	let msgid = '';
	let msgstr = '';
	const flush = () => {
		if (field === 'msgstr') entries.set(msgid, msgstr);
		field = null;
		msgid = '';
		msgstr = '';
	};
	for (const line of lines) {
		const start = /^(msgid|msgstr) (".*")$/.exec(line);
		if (start) {
			if (start[1] === 'msgid') flush();
			field = start[1] as 'msgid' | 'msgstr';
			if (field === 'msgid') msgid = JSON.parse(start[2]!) as string;
			else msgstr = JSON.parse(start[2]!) as string;
		} else if (field !== null && line.startsWith('"')) {
			const part = JSON.parse(line) as string;
			if (field === 'msgid') msgid += part;
			else msgstr += part;
		} else if (field === 'msgstr') {
			flush();
		}
	}
	flush();
	return entries;
}

const catalogs = new Map<string, Map<string, string>>();

function appTranslation(locale: string, source: string): string | null {
	let catalog = catalogs.get(locale);
	if (!catalog) {
		catalog = readPoCatalog(locale);
		catalogs.set(locale, catalog);
	}
	return catalog.get(source) ?? null;
}

describe('Operator Pass checkout boxes', () => {
	it.each(Object.keys(CONTENT_I18N_LOCALE_MESSAGES))('%s records the same box text that the app shows', (locale) => {
		const messages = CONTENT_I18N_LOCALE_MESSAGES[locale as keyof typeof CONTENT_I18N_LOCALE_MESSAGES];
		const format = new MessageFormat(locale, {strictPluralKeys: false});
		for (const key of BOX_KEYS) {
			const shown = appTranslation(locale, CONTENT_I18N_MESSAGES[key]);
			const recorded = messages[key];
			expect(shown, key).not.toBeNull();
			expect(recorded, key).toBeDefined();
			for (const days of [1, 7]) {
				expect(format.compile(shown ?? '')({days}), key).toBe(format.compile(recorded ?? '')({days}));
			}
		}
	});

	it.each(Object.keys(CONTENT_I18N_LOCALE_MESSAGES))(
		'%s records the Visionary box text that the app shows',
		(locale) => {
			const messages = CONTENT_I18N_LOCALE_MESSAGES[locale as keyof typeof CONTENT_I18N_LOCALE_MESSAGES];
			const shown = appTranslation(locale, VISIONARY_BOX_APP_SOURCE);
			expect(shown).not.toBeNull();
			const plain = (shown ?? '').replace(/<\/?\d+>/g, '').replaceAll('{OPERATOR_PASS_NAME}', 'Operator Pass');
			expect(messages[VISIONARY_BOX_KEY]).toBe(plain);
		},
	);
});
