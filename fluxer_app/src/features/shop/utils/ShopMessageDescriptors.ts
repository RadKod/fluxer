// SPDX-License-Identifier: AGPL-3.0-or-later

import {msg} from '@lingui/core/macro';

// Every new shop and Plus sales text, once. Shop components import from here and never
// write the same text a second time. The labels ("Owned", "Equip", "Equipped", "Included in Plus") keep their
// Turkish wording exactly.

export const SHOP_DESCRIPTOR = msg({
	message: 'Shop',
	comment: 'Direct messages list entry and page title for the shop where profile decorations and Plus are bought.',
});
export const ITEM_SALES_PAUSED_NOTICE_DESCRIPTOR = msg({
	message: 'Sales are paused right now. Items you own can still be equipped.',
	comment: 'Notice on the shop page while item sales are switched off.',
});
export const REDEEM_A_CODE_DESCRIPTOR = msg({
	message: 'Redeem a code',
	comment:
		'Heading of the code field on the shop page, and the button at the top of the Plus and shop pages that opens the code dialog.',
});
export const PASTE_A_CODE_OR_GIFT_LINK_DESCRIPTOR = msg({
	message: 'Paste a code or gift link',
	comment: 'Placeholder of the code field on the shop page.',
});
export const NOTHING_ON_SALE_DESCRIPTOR = msg({
	message: 'Nothing on sale right now',
	comment: 'Title of the empty shop page when no item is on sale.',
});
export const NEW_ITEMS_SHOW_UP_HERE_DESCRIPTOR = msg({
	message: 'New items show up here when they go on sale.',
	comment: 'Description of the empty shop page when no item is on sale.',
});
export const OWNED_DESCRIPTOR = msg({
	message: 'Owned',
	context: 'shop-item',
	comment: 'Chip on a shop card and in the item dialog for an item the user already has.',
});
export const INCLUDED_IN_PREMIUM_DESCRIPTOR = msg({
	message: 'Included in Plus',
	comment: 'Chip and price line of a shop item that every Plus member can wear.',
});
export const EQUIP_DESCRIPTOR = msg({
	message: 'Equip',
	comment: 'Button on a shop item the user has but does not wear.',
});
export const EQUIPPED_BUTTON_DESCRIPTOR = msg({
	message: 'Equipped',
	context: 'shop-button',
	comment: 'Disabled button on a shop item the user wears.',
});
export const EQUIP_ITEM_DESCRIPTOR = msg({
	message: 'Equip {name}',
	comment: 'Accessible label of the equip button on a shop card. {name} is the item name.',
});
export const BUY_ITEM_DESCRIPTOR = msg({
	message: 'Buy {name}',
	comment: 'Accessible label of the buy button on a shop card, and title of the buy dialog. {name} is the item name.',
});
export const NOT_ON_SALE_DESCRIPTOR = msg({
	message: 'Not on sale',
	comment: 'Price line of a shop item while item sales are switched off.',
});
export const PREMIUM_PRICE_DESCRIPTOR = msg({
	message: 'Plus: {price}',
	comment: 'Price line with what a Plus member pays for a shop item. {price} is a price in Turkish lira.',
});
export const WAS_PRICE_DESCRIPTOR = msg({
	message: 'Was {price}',
	comment:
		'Hidden text for screen readers before a struck-through old price in the shop. {price} is a formatted price.',
});
export const DISCOUNT_PERCENT_DESCRIPTOR = msg({
	message: 'Discount {percent}',
	comment:
		'Hidden text for screen readers before a sale badge in the shop. {percent} is a formatted discount like -20%.',
});
export const DAYS_HOURS_LEFT_DESCRIPTOR = msg({
	message: '{days}d {hours}h left',
	comment: 'Sale countdown in the shop when a day or more is left. d is days, h is hours.',
});
export const HOURS_MINUTES_LEFT_DESCRIPTOR = msg({
	message: '{hours}h {minutes}m left',
	comment: 'Sale countdown in the shop when an hour or more is left. h is hours, m is minutes.',
});
export const MINUTES_LEFT_DESCRIPTOR = msg({
	message: '{minutes}m left',
	comment: 'Sale countdown in the shop when less than an hour is left. m is minutes.',
});
export const LESS_THAN_A_MINUTE_LEFT_DESCRIPTOR = msg({
	message: 'Less than a minute left',
	comment: 'Sale countdown in the shop in the last minute.',
});
export const SALE_ENDS_DESCRIPTOR = msg({
	message: 'Sale ends {date}',
	comment: 'Accessible label of the sale countdown in the shop. {date} is the date and time the sale ends.',
});
export const PROFILE_CARD_DESCRIPTOR = msg({
	message: 'Profile card',
	comment: 'Label of the profile card preview in the shop item dialog.',
});
export const PREVIEW_TAKES_THE_PLACE_DESCRIPTOR = msg({
	message: 'The preview takes the place of the {type} you wear.',
	comment:
		'Note in the shop item dialog when the user wears an item of the same type. {type} is a decoration type name such as Nameplate.',
});
export const PREVIEW_FIRST_MESSAGE_DESCRIPTOR = msg({
	message: 'Hey, look at my new look!',
	comment: 'First sample chat message in the shop item preview, written by the user.',
});
export const PREVIEW_SECOND_MESSAGE_DESCRIPTOR = msg({
	message: 'Nice, right?',
	comment: 'Second sample chat message in the shop item preview, written by the user.',
});
export const BUY_PREMIUM_DESCRIPTOR = msg({
	message: 'Buy {premiumProductName}',
	comment: 'Title of the buy dialog for a Plus package, and the button on the Plus page that opens the plans.',
});
export const PACKAGE_MONTHS_DESCRIPTOR = msg({
	message: '{months, plural, one {# month} other {# months}}',
	comment: 'Name of a Plus package in the package picker and on the package card.',
});
export const PRICE_DESCRIPTOR = msg({
	message: 'Price',
	comment: 'Row of the order summary in the buy dialog: the list price.',
});
export const SALE_PERCENT_DESCRIPTOR = msg({
	message: 'Sale ({percent})',
	comment: 'Row of the order summary in the buy dialog: the campaign discount. {percent} is a formatted discount.',
});
export const PREMIUM_DISCOUNT_PERCENT_DESCRIPTOR = msg({
	message: '{premiumProductName} discount ({percent})',
	comment: 'Row of the order summary in the buy dialog: the Plus member discount. {percent} is a formatted discount.',
});
export const TOTAL_DESCRIPTOR = msg({
	message: 'Total',
	comment: 'Row of the order summary in the buy dialog: what the user pays.',
});
export const ONE_TIME_PAYMENT_DESCRIPTOR = msg({
	message: 'One-time payment. It does not renew.',
	comment: 'Note under the Plus packages and in the Plus buy dialog.',
});
export const TIME_ADDED_ON_TOP_DESCRIPTOR = msg({
	message: 'Time is added on top of what you have left.',
	comment: 'Note for Plus members buying more Plus time.',
});
export const CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR = msg({
	message: 'Claim your account to buy.',
	comment: 'Tooltip on a disabled buy button for an account that is not claimed yet.',
});
export const VERIFY_EMAIL_TO_BUY_DESCRIPTOR = msg({
	message: 'Verify your email to buy.',
	comment: 'Tooltip on a disabled buy button for an account whose email is not verified.',
});
export const LOADING_PRICE_DESCRIPTOR = msg({
	message: 'Loading price',
	comment: 'Accessible label of the order summary while the buy dialog asks the server for the price.',
});
export const PRICE_CHANGED_DESCRIPTOR = msg({
	message: 'The price changed',
	comment: 'Title in the buy dialog when the order price differs from the price shown.',
});
export const CONTINUE_AT_NEW_PRICE_DESCRIPTOR = msg({
	message: 'Continue at the new price',
	comment: 'Button in the buy dialog after the price changed.',
});
export const FINISH_PAYING_IN_BROWSER_DESCRIPTOR = msg({
	message: 'Finish paying in your browser',
	comment: 'Title in the buy dialog while it waits for the payment.',
});
export const PAYMENT_PAGE_OPENED_DESCRIPTOR = msg({
	message: 'The payment page opened in a new tab. This window updates by itself once the payment is confirmed.',
	// sanalyer: no provider name; which payment provider (if any) runs is a server setting.
	comment: 'Body of the buy dialog while it waits for the payment.',
});
export const WAITING_FOR_PAYMENT_DESCRIPTOR = msg({
	message: 'Waiting for payment…',
	comment: 'Status line in the buy dialog while it waits for the payment.',
});
export const OPEN_PAYMENT_PAGE_DESCRIPTOR = msg({
	message: 'Open the payment page',
	comment: 'Main button in the buy dialog while it waits for the payment; opens the payment page again.',
});
export const ORDER_NUMBER_DESCRIPTOR = msg({
	message: 'Order {orderId}',
	comment: 'Order number in the buy dialog. {orderId} is a long number.',
});
export const PURCHASE_ADDED_ONCE_CONFIRMED_DESCRIPTOR = msg({
	message: 'Once the payment is confirmed, your purchase is added to your account.',
	comment: 'Toast when the user closes the buy dialog while it waits for the payment.',
});
export const EQUIPPED_SUCCESS_DESCRIPTOR = msg({
	message: 'Equipped',
	context: 'shop-success',
	comment: 'Title after a bought or redeemed item has been added and put on.',
});
export const NOW_ON_YOUR_PROFILE_DESCRIPTOR = msg({
	message: '{name} is now on your profile.',
	comment: 'Body after a bought or redeemed item has been added and put on. {name} is the item name.',
});
export const PREMIUM_ACTIVE_DESCRIPTOR = msg({
	message: '{premiumProductName} is active',
	comment: 'Title after buying Plus, and the Plus status line.',
});
export const UNTIL_DATE_DESCRIPTOR = msg({
	message: 'Until {date}',
	comment: 'Body after buying Plus. {date} is the date Plus ends.',
});
export const UNTIL_DATE_DAYS_LEFT_DESCRIPTOR = msg({
	message: 'Until {date}, {days, plural, one {# day} other {# days}} left',
	comment: 'Plus status line on the Plus page. {date} is the date Plus ends.',
});
export const PAYMENT_NOT_COMPLETED_DESCRIPTOR = msg({
	message: 'Payment not completed',
	comment: 'Title in the buy dialog when the payment failed.',
});
export const PAYMENT_NOT_APPROVED_DESCRIPTOR = msg({
	message: 'The payment was not approved. You can try again.',
	comment: 'Body in the buy dialog when the payment was declined, canceled or timed out.',
});
export const ORDER_MISMATCH_DESCRIPTOR = msg({
	message: 'Something is off with this order. If money was taken, contact support with the order number.',
	comment: 'Body in the buy dialog when the paid amount or currency does not match the order.',
});
export const PAYMENT_NOT_CONFIRMED_YET_DESCRIPTOR = msg({
	message: 'Payment not confirmed yet',
	comment: 'Title in the buy dialog when it stopped waiting for the payment.',
});
export const PAYMENT_TIMEOUT_DESCRIPTOR = msg({
	message: 'If you finished paying, your purchase shows up within a few minutes. You can close this window.',
	comment: 'Body in the buy dialog when it stopped waiting for the payment.',
});
export const CHECK_AGAIN_DESCRIPTOR = msg({
	message: 'Check again',
	comment: 'Button in the buy dialog that asks for the payment status again.',
});
export const SALES_PAUSED_DESCRIPTOR = msg({
	message: 'Sales are paused',
	comment: 'Title in the buy dialog when the server refused the order because sales are switched off.',
});
export const CANT_BE_BOUGHT_RIGHT_NOW_DESCRIPTOR = msg({
	message: "This can't be bought right now.",
	comment: 'Body in the buy dialog when the server refused the order because sales are switched off.',
});
export const TOO_MANY_ORDERS_DESCRIPTOR = msg({
	message: 'Too many orders right now',
	comment: 'Title in the buy dialog when the payment provider is busy.',
});
export const TRY_AGAIN_IN_A_FEW_SECONDS_DESCRIPTOR = msg({
	message: 'Try again in a few seconds.',
	comment: 'Body in the buy dialog when the payment provider is busy.',
});
// Existing text (RateLimitedConfirmModal), reused as it is.
export const RATE_LIMITED_WAIT_DESCRIPTOR = msg({
	message: "You're being rate limited. Wait {duration} before trying again.",
	comment:
		'Body in the buy dialog after the daily order limit. {duration} is a localized short duration such as "72 minutes".',
});
export const ALREADY_OWNED_DESCRIPTOR = msg({
	message: 'You already have this item.',
	comment: 'Buy dialog when the user got the item another way meanwhile.',
});
export const CODE_GIVES_ITEM_DESCRIPTOR = msg({
	message: 'This code gives you {name}.',
	comment: 'Gift dialog for a code that gives a decoration. {name} is the item name.',
});
export const ADDED_AND_EQUIPPED_DESCRIPTOR = msg({
	message: 'It is added to your collection and equipped.',
	comment: 'Gift dialog for a code that gives a decoration.',
});
export const REDEEM_AND_EQUIP_DESCRIPTOR = msg({
	message: 'Redeem and equip',
	comment: 'Button in the gift dialog for a code that gives a decoration.',
});
export const ALREADY_OWNED_CODE_KEPT_DESCRIPTOR = msg({
	message: 'You already have this item. The code was not used, so you can give it to someone else.',
	comment: 'Gift dialog for a decoration code when the user already has the item.',
});
export const ADD_TIME_DESCRIPTOR = msg({
	message: 'Add time',
	comment: 'Button on the Plus status line and on the packages for Plus members.',
});
export const PREMIUM_DECORATIONS_DESCRIPTOR = msg({
	message: 'Plus decorations',
	comment: 'Comparison table row on the Plus page: decorations every Plus member can wear.',
});
export const CHOOSE_A_PLAN_DESCRIPTOR = msg({
	message: 'Choose a plan',
	comment: 'Heading of the Plus packages.',
});
export const PREMIUM_SALES_PAUSED_DESCRIPTOR = msg({
	message: '{premiumProductName} sales are paused right now.',
	comment: 'Notice on the Plus page while Plus sales are switched off.',
});
export const REDEEM_KEY_BELOW_DESCRIPTOR = msg({
	message: 'If you have a key, you can redeem it below.',
	comment: 'Notice on the Plus page while Plus sales are switched off.',
});
export const CONFIRMING_PAYMENT_DESCRIPTOR = msg({
	message: 'Confirming your payment',
	comment: 'Title of the payment return page in the browser while the payment is being confirmed.',
});
export const PAYMENT_RETURN_PENDING_DESCRIPTOR = msg({
	message: 'You can close this tab and return to the app. Your purchase appears there once it is confirmed.',
	comment: 'Body of the payment return page in the browser while the payment is being confirmed.',
});

// Micup Visionary: lifetime Plus with a numbered badge, sold on the Plus page.
export const VISIONARY_NAME_DESCRIPTOR = msg({
	message: 'sanalyer Visionary',
	comment: 'Product name on the Visionary card and buy dialog. A product name: keep it as written.',
});
export const VISIONARY_REWARDS_DESCRIPTOR = msg({
	message: 'Lifetime {premiumProductName}, a numbered badge, the #0000 tag and a decoration only Visionaries have.',
	comment: 'What Visionary gives, on its card and in its buy dialog.',
});
export const SOLD_OUT_DESCRIPTOR = msg({
	message: 'Sold out',
	context: 'visionary',
	comment: 'Button on the Visionary card and buy dialog title when no spot is left.',
});
export const VISIONARY_SOLD_OUT_DESCRIPTOR = msg({
	message: 'The last Visionary spots are gone.',
	comment: 'Body of the Visionary buy dialog when no spot is left.',
});
export const LIFETIME_MEANS_DESCRIPTOR = msg({
	message: 'Lifetime means for as long as sanalyer runs.',
	comment: 'Note in the Visionary buy dialog, under the price.',
});
export const REMAINING_TIME_NOT_REFUNDED_DESCRIPTOR = msg({
	message: 'Your remaining {premiumProductName} time becomes part of the lifetime plan. It is not refunded.',
	comment: 'Note in the Visionary buy dialog for a user who still has Plus time.',
});
export const YOU_ARE_VISIONARY_NUMBER_DESCRIPTOR = msg({
	message: 'You are Visionary #{number}',
	comment: 'Title after buying Visionary. {number} is the numbered spot the user got.',
});
export const YOU_ARE_A_VISIONARY_DESCRIPTOR = msg({
	message: 'You are a Visionary',
	comment: 'Title after buying Visionary, before the number is known.',
});
export const VISIONARY_NUMBER_LIFETIME_DESCRIPTOR = msg({
	message: 'Visionary #{number} · Lifetime',
	comment: 'Plus status card of a Visionary. {number} is their numbered spot.',
});
export const BUNDLES_DESCRIPTOR = msg({
	message: 'Bundles',
	comment: 'Heading of the shop section with bundles: several profile decorations sold together for one price.',
});
export const BUNDLE_ITEM_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# item} other {# items}}',
	comment: 'Line on a shop bundle card: how many profile decorations the bundle gives.',
});
export const BUNDLE_INCLUDES_DESCRIPTOR = msg({
	message: 'Includes',
	comment: 'Heading of the list of profile decorations a shop bundle gives, in its buy dialog.',
});
export const BUNDLE_ITEM_OWNED_DESCRIPTOR = msg({
	message: 'You already own an item in this bundle',
	comment:
		'Shop bundle card price line, and title in its buy dialog, when the user has one of its items: the bundle cannot be bought.',
});
export const BUNDLE_ITEMS_YOURS_DESCRIPTOR = msg({
	message: 'The items in {name} are now yours.',
	comment: 'Body after a shop bundle is bought, above the list of its items. {name} is the bundle name.',
});
export const BUNDLE_CONTENTS_CHANGED_DESCRIPTOR = msg({
	message: "This bundle's contents changed",
	comment: 'Title in the bundle buy dialog when the order gives other items than the ones shown; the new list follows.',
});
export const BUNDLE_CARD_TITLE_DESCRIPTOR = msg({
	message: '{count}-piece {name}',
	comment:
		'Title of a shop bundle card, as in "3-piece Angel Wings". {count} is how many profile decorations the bundle gives; {name} is the bundle name.',
});
export const BUY_FOR_PRICE_DESCRIPTOR = msg({
	message: 'Buy for {price}',
	comment: 'Button on a shop card that opens the buy dialog. {price} is the price the user pays, in Turkish lira.',
});
export const BUY_COLLECTION_DESCRIPTOR = msg({
	message: 'Buy the collection',
	comment: 'Button at the top of the shop page that buys the featured set (its bundle) at once.',
});
export const BUY_ALL_IN_SET_DESCRIPTOR = msg({
	message: 'Buy all: {name}',
	comment: 'Button beside a set heading in the shop: buys the set bundle. {name} is the set (bundle) name.',
});
export const TAKE_ME_THERE_DESCRIPTOR = msg({
	message: 'Take me there',
	comment: 'Button on a shop set tile that opens the page of that set.',
});
export const BROWSE_ALL_DESCRIPTOR = msg({
	message: 'Browse all',
	comment: 'First step of the breadcrumb on a shop set page; goes back to the whole shop.',
});
export const SHOP_BREADCRUMB_DESCRIPTOR = msg({
	message: 'Shop breadcrumb',
	comment: 'Accessible name of the breadcrumb at the top of a shop set page.',
});
export const SAVE_VS_MONTHLY_DESCRIPTOR = msg({
	message: 'Save {percent} vs the monthly plan',
	comment:
		'Green line on a Plus package card: what a month of this package saves against the one month package. {percent} is a formatted percentage such as 16%. Not a campaign discount.',
});
