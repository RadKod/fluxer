// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import * as GiftCommands from '@app/features/gift/commands/GiftCommands';
import {findKey} from '@app/features/gift/utils/GiftCodeUtils';
import styles from '@app/features/shop/components/ShopRedeemField.module.css';
import {
	PASTE_A_CODE_OR_GIFT_LINK_DESCRIPTOR,
	REDEEM_A_CODE_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {Form} from '@app/features/ui/components/form/Form';
import {Input} from '@app/features/ui/components/form/FormInput';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {TicketIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useId} from 'react';
import {useForm} from 'react-hook-form';

const REDEEM_DESCRIPTOR = msg({
	message: 'Redeem',
	comment: 'Button of the code field on the shop page; opens what the pasted code gives.',
});
const GOT_A_CODE_DESCRIPTOR = msg({
	message: 'Got a code?',
	comment: 'Heading of the code card at the bottom of the Plus page.',
});
const CODE_CARD_BODY_DESCRIPTOR = msg({
	message: 'Enter a code that carries Plus time or a decoration.',
	comment: 'Line under the heading of the code card on the Plus page.',
});
const CODE_CARD_HINT_DESCRIPTOR = msg({
	message: 'Each code works once. If you already have the decoration, the code is not used up.',
	comment:
		'Small print under the code field on the Plus page. A decoration code is refused, and stays unused, when the account already owns that decoration.',
});
const NOT_A_KEY_DESCRIPTOR = msg({
	message: 'Paste a key code or a gift link from this site.',
	comment:
		'Error under the code field of the shop and Plus pages when the pasted text is neither a gift code nor a gift link of this instance.',
});

interface FormInputs {
	code: string;
}

interface ShopRedeemFieldProps {
	// 'card' at the bottom of the Plus page (heading, line, hint), 'bar' at the bottom of the shop.
	variant?: 'card' | 'bar';
	// The input's id, for ShopRedeemJumpButton; a generated one when nothing jumps here.
	inputId?: string;
	// Keeps the "Redeem a code" label for screen readers only.
	labelHidden?: boolean;
}

// A Plus key and an item code take the same road: Fluxer's gift dialog shows what the code gives, then claims it.
// Text that is neither a key nor a gift link of this site never reaches the API.
export const ShopRedeemField = observer(function ShopRedeemField({
	variant = 'bar',
	inputId,
	labelHidden = false,
}: ShopRedeemFieldProps) {
	const {i18n} = useLingui();
	const generatedId = useId();
	const id = inputId ?? generatedId;
	const form = useForm<FormInputs>({defaultValues: {code: ''}});
	const empty = form.watch('code').trim() === '';
	const handleSubmit = (data: FormInputs) => {
		const code = findKey(data.code);
		if (!code) {
			form.setError('code', {type: 'validate', message: i18n._(NOT_A_KEY_DESCRIPTOR)});
			return;
		}
		form.reset();
		void GiftCommands.openAcceptModal(code);
	};
	const card = variant === 'card';
	return (
		<div className={clsx(styles.field, card ? styles.card : styles.bar)} data-flx="shop.shop-redeem-field.field">
			{card && (
				<>
					<h3 className={styles.heading} data-flx="shop.shop-redeem-field.heading">
						<TicketIcon className={styles.icon} aria-hidden="true" data-flx="shop.shop-redeem-field.heading-icon" />
						{i18n._(GOT_A_CODE_DESCRIPTOR)}
					</h3>
					<p className={styles.body} data-flx="shop.shop-redeem-field.body">
						{i18n._(CODE_CARD_BODY_DESCRIPTOR)}
					</p>
				</>
			)}
			<Form form={form} onSubmit={handleSubmit} data-flx="shop.shop-redeem-field.form.submit">
				<div className={styles.row} data-flx="shop.shop-redeem-field.row">
					<label
						htmlFor={id}
						className={clsx(styles.label, labelHidden && styles.srOnly)}
						data-flx="shop.shop-redeem-field.label"
					>
						{!card && (
							<TicketIcon className={styles.icon} aria-hidden="true" data-flx="shop.shop-redeem-field.label-icon" />
						)}
						<span data-flx="shop.shop-redeem-field.label-text">{i18n._(REDEEM_A_CODE_DESCRIPTOR)}</span>
					</label>
					<div className={styles.input} data-flx="shop.shop-redeem-field.input-wrapper">
						<Input
							{...form.register('code')}
							id={id}
							placeholder={i18n._(PASTE_A_CODE_OR_GIFT_LINK_DESCRIPTOR)}
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							maxLength={200}
							type="text"
							error={form.formState.errors.code?.message}
							data-flx="shop.shop-redeem-field.input.text"
						/>
					</div>
					<Button
						type="submit"
						fitContent
						className={styles.submit}
						disabled={empty}
						data-flx="shop.shop-redeem-field.button.submit"
					>
						{i18n._(REDEEM_DESCRIPTOR)}
					</Button>
				</div>
			</Form>
			{card && (
				<p className={styles.hint} data-flx="shop.shop-redeem-field.hint">
					{i18n._(CODE_CARD_HINT_DESCRIPTOR)}
				</p>
			)}
		</div>
	);
});

interface ShopRedeemJumpButtonProps {
	// The ShopRedeemField's inputId.
	inputId: string;
}

// The bar's "Redeem a code" on the Plus and shop pages: brings the page's own code field into view and focuses it.
export const ShopRedeemJumpButton = observer(function ShopRedeemJumpButton({inputId}: ShopRedeemJumpButtonProps) {
	const {i18n} = useLingui();
	const handleClick = () => {
		const input = document.getElementById(inputId);
		if (!input) return;
		input.scrollIntoView({block: 'center', behavior: Accessibility.useSmoothScrolling ? 'smooth' : 'auto'});
		input.focus({preventScroll: true});
	};
	return (
		<Button
			small={true}
			fitContent={true}
			variant="secondary"
			leftIcon={<TicketIcon aria-hidden="true" data-flx="shop.shop-redeem-jump-button.icon" />}
			onClick={handleClick}
			data-flx="shop.shop-redeem-jump-button.button.click"
		>
			{i18n._(REDEEM_A_CODE_DESCRIPTOR)}
		</Button>
	);
});
