// SPDX-License-Identifier: AGPL-3.0-or-later

import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';

export const SHOP_CURRENCY_NOTE_DESCRIPTOR = msg({
	message:
		"Micup is an Azerbaijani company, so payments are collected in Azerbaijani manat (AZN). TL amounts are informational, based on the Central Bank of Azerbaijan's daily exchange rate.",
	comment:
		'Payment currency explanation on the shop, Micup Plus page, checkout and FAQ. Keep the company location explicit.',
});
export const SHOP_BANK_NOTE_DESCRIPTOR = msg({
	message:
		'The TL amount on your card statement may differ slightly: your bank converts AZN at its own exchange rate and may charge a foreign transaction fee.',
	comment:
		'Card statement disclaimer after the AZN payment explanation on the shop, Micup Plus page, checkout and FAQ.',
});

export function ShopCurrencyNote() {
	const {i18n} = useLingui();
	return (
		<span data-flx="shop.shop-currency-note.note">
			{i18n._(SHOP_CURRENCY_NOTE_DESCRIPTOR)} {i18n._(SHOP_BANK_NOTE_DESCRIPTOR)}
		</span>
	);
}
