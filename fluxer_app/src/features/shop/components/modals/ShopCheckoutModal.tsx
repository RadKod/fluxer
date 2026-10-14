// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import * as Modal from '@app/features/app/components/dialogs/Modal';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import type {CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import {COSMETIC_TYPE_LABELS} from '@app/features/cosmetics/utils/CosmeticLabels';
import {
	CANCEL_DESCRIPTOR,
	CLOSE_DESCRIPTOR,
	CONTINUE_DESCRIPTOR,
	MINUTES_DURATION_PLURAL_DESCRIPTOR,
	OKAY_DESCRIPTOR,
	TRY_AGAIN_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {ShopBundleDetailModal} from '@app/features/shop/components/modals/ShopBundleDetailModal';
import styles from '@app/features/shop/components/modals/ShopCheckoutModal.module.css';
import {ShopItemDetailModal} from '@app/features/shop/components/modals/ShopItemDetailModal';
import {PurchaseDisabledWrapper} from '@app/features/shop/components/PurchaseDisabledWrapper';
import {ShopEquippedSuccess} from '@app/features/shop/components/ShopEquippedSuccess';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {ShopPrice} from '@app/features/shop/components/ShopPrice';
import {type ShopCheckoutFlow, useShopCheckout} from '@app/features/shop/hooks/useShopCheckout';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import type {ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import {purchaseBlockOf} from '@app/features/shop/utils/ShopItemAction';
import {
	ALREADY_OWNED_DESCRIPTOR,
	BUNDLE_CONTENTS_CHANGED_DESCRIPTOR,
	BUNDLE_INCLUDES_DESCRIPTOR,
	BUNDLE_ITEM_OWNED_DESCRIPTOR,
	BUY_ITEM_DESCRIPTOR,
	BUY_PREMIUM_DESCRIPTOR,
	CANT_BE_BOUGHT_RIGHT_NOW_DESCRIPTOR,
	CHECK_AGAIN_DESCRIPTOR,
	CHOOSE_A_PLAN_DESCRIPTOR,
	CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR,
	CONTINUE_AT_NEW_PRICE_DESCRIPTOR,
	EQUIP_DESCRIPTOR,
	FINISH_PAYING_IN_BROWSER_DESCRIPTOR,
	LIFETIME_MEANS_DESCRIPTOR,
	LOADING_PRICE_DESCRIPTOR,
	ONE_TIME_PAYMENT_DESCRIPTOR,
	OPEN_PAYMENT_PAGE_DESCRIPTOR,
	ORDER_MISMATCH_DESCRIPTOR,
	ORDER_NUMBER_DESCRIPTOR,
	PACKAGE_MONTHS_DESCRIPTOR,
	PAYMENT_NOT_APPROVED_DESCRIPTOR,
	PAYMENT_NOT_COMPLETED_DESCRIPTOR,
	PAYMENT_NOT_CONFIRMED_YET_DESCRIPTOR,
	PAYMENT_PAGE_OPENED_DESCRIPTOR,
	PAYMENT_TIMEOUT_DESCRIPTOR,
	PREMIUM_DISCOUNT_PERCENT_DESCRIPTOR,
	PREMIUM_PRICE_DESCRIPTOR,
	PRICE_CHANGED_DESCRIPTOR,
	PRICE_DESCRIPTOR,
	RATE_LIMITED_WAIT_DESCRIPTOR,
	REMAINING_TIME_NOT_REFUNDED_DESCRIPTOR,
	SALE_PERCENT_DESCRIPTOR,
	SALES_PAUSED_DESCRIPTOR,
	SOLD_OUT_DESCRIPTOR,
	TIME_ADDED_ON_TOP_DESCRIPTOR,
	TOO_MANY_ORDERS_DESCRIPTOR,
	TOTAL_DESCRIPTOR,
	TRY_AGAIN_IN_A_FEW_SECONDS_DESCRIPTOR,
	VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
	VISIONARY_NAME_DESCRIPTOR,
	VISIONARY_REWARDS_DESCRIPTOR,
	VISIONARY_SOLD_OUT_DESCRIPTOR,
	WAITING_FOR_PAYMENT_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {campaignShown, formatDiscount, formatTry, percentOff} from '@app/features/shop/utils/ShopPriceFormat';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {CopyButton} from '@app/features/ui/components/CopyButton';
import {Spinner} from '@app/features/ui/components/Spinner';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import {isDesktop} from '@app/features/ui/utils/NativeUtils';
import {UserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import Users from '@app/features/user/state/Users';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopOrderResponse, ShopQuoteResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowSquareOutIcon, CrownIcon, StorefrontIcon, WarningIcon, XCircleIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {AnimatePresence, motion} from 'framer-motion';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useState} from 'react';

// fromItem: a premium-included item that led here; the dialog previews it instead of the crown.
export type ShopCheckoutTarget =
	| {kind: 'item'; sku: string}
	| {kind: 'premium'; months: 1 | 3 | 12; fromItem?: CosmeticItemResponse}
	| {kind: 'visionary'}
	| {kind: 'bundle'; sku: string};

interface ShopCheckoutModalProps {
	target: ShopCheckoutTarget;
}

// Existing texts, reused as they are.
const PURCHASE_DESCRIPTOR = msg({message: 'Purchase', comment: 'Buy button in the shop buy dialog.'});
const PROFILE_DECORATIONS_DESCRIPTOR = msg({
	message: 'Profile decorations',
	comment: 'Button after buying an item in the shop; opens the profile decorations settings.',
});
const LOCKED_DESCRIPTOR = msg({
	message: '{name} comes with {premiumProductName}.',
	comment: 'Shop buy dialog for Plus, opened from a Plus-only decoration. {name} is the decoration name.',
});
const COPY_DESCRIPTOR = msg({message: 'Copy', comment: 'Copies the order number in the shop buy dialog.'});
// sanalyer: the order is charged in Turkish lira, the same amount the shop shows; no second currency to explain.
const PAYMENT_PRICE_NOTE_DESCRIPTOR = msg({
	message: 'You will pay {price}.',
	comment:
		'Shown in the buy dialog before and while the payment page is open. {price} is the order total in Turkish lira.',
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

type PriceParts = Pick<
	ShopQuoteResponse,
	'base_try_minor' | 'campaign_percent' | 'premium_percent' | 'final_try_minor'
>;

// The campaign step rounds half up as the server does. Discount rows are differences between cumulative levels
// ending in the server's final amount, so the rows always add up to the total.
function saleTryMinor(price: PriceParts): number {
	if (price.premium_percent === 0) return price.final_try_minor;
	return percentOff(price.base_try_minor, price.campaign_percent);
}

// Takes focus when a new state appears.
const focusOnMount = (node: HTMLHeadingElement | null) => node?.focus();

// Rows from the server's numbers; `before` marks what differs from the price shown earlier (price_changed).
interface SummaryProps {
	price: PriceParts;
	before?: PriceParts;
}

const Summary = observer(({price, before}: SummaryProps) => {
	const {i18n} = useLingui();
	const percent = (value: number) => formatDiscount(value, i18n.locale);
	const rowsOf = (parts: PriceParts) => {
		const base = parts.base_try_minor;
		const sale = saleTryMinor(parts);
		const rows = [{key: 'price', label: i18n._(PRICE_DESCRIPTOR), amount: base}];
		if (parts.campaign_percent > 0) {
			const label = i18n._(SALE_PERCENT_DESCRIPTOR, {percent: percent(parts.campaign_percent)});
			rows.push({key: 'sale', label, amount: base - sale});
		}
		if (parts.premium_percent > 0) {
			const label = i18n._(PREMIUM_DISCOUNT_PERCENT_DESCRIPTOR, {
				premiumProductName: PREMIUM_PRODUCT_NAME,
				percent: percent(parts.premium_percent),
			});
			rows.push({key: 'premium', label, amount: sale - parts.final_try_minor});
		}
		rows.push({key: 'total', label: i18n._(TOTAL_DESCRIPTOR), amount: parts.final_try_minor});
		return rows;
	};
	const earlier = before ? new Map(rowsOf(before).map((row) => [row.key, row.amount])) : null;
	return (
		<dl className={styles.summary} aria-live="polite" data-flx="shop.shop-checkout-modal.summary">
			{rowsOf(price).map((row) => (
				<div
					key={row.key}
					className={clsx(
						styles.row,
						row.key === 'total' && styles.totalRow,
						earlier && earlier.get(row.key) !== row.amount && styles.changed,
					)}
					data-flx="shop.shop-checkout-modal.row"
				>
					<dt data-flx="shop.shop-checkout-modal.row-label">{row.label}</dt>
					<dd data-flx="shop.shop-checkout-modal.row-value">
						{(row.key === 'sale' || row.key === 'premium') && '−'}
						<ShopPrice tryMinor={row.amount} primaryOnly data-flx="shop.shop-checkout-modal.summary.shop-price" />
					</dd>
				</div>
			))}
		</dl>
	);
});

// The catalog may be older than a campaign's end; the server's quote below is the price.
const PackageOption = observer(({entry}: {entry: ShopPackageEntry}) => {
	const {i18n} = useLingui();
	const sale = campaignShown(entry.price, ShopCatalog.now());
	const tryMinor = sale ? entry.price.sale_try_minor : entry.price.base_try_minor;
	return (
		<div className={styles.package} data-flx="shop.shop-checkout-modal.package">
			<span className={styles.packageName} data-flx="shop.shop-checkout-modal.package-name">
				{i18n._(PACKAGE_MONTHS_DESCRIPTOR, {months: entry.months})}
			</span>
			<span className={styles.packagePrice} data-flx="shop.shop-checkout-modal.package-price">
				<span data-flx="shop.shop-checkout-modal.package-amount">
					<ShopPrice
						tryMinor={tryMinor}
						months={entry.months}
						data-flx="shop.shop-checkout-modal.package-option.shop-price"
					/>
				</span>
				{sale && (
					<span className={styles.badge} data-flx="shop.shop-checkout-modal.package-badge">
						{formatDiscount(entry.price.campaign_percent ?? 0, i18n.locale)}
					</span>
				)}
			</span>
		</div>
	);
});

const OrderNumber = ({orderId}: {orderId: string}) => {
	const {i18n} = useLingui();
	return (
		<div className={styles.order} data-flx="shop.shop-checkout-modal.order">
			<span className={styles.orderText} data-flx="shop.shop-checkout-modal.order-text">
				{i18n._(ORDER_NUMBER_DESCRIPTOR, {orderId})}
			</span>
			<CopyButton
				value={orderId}
				label={COPY_DESCRIPTOR}
				buttonClassName={styles.copyButton}
				iconClassName={styles.copyIcon}
				data-flx="shop.shop-checkout-modal.copy-button"
			/>
		</div>
	);
};

const PaymentPriceNote = ({order}: {order: ShopOrderResponse}) => {
	const {i18n} = useLingui();
	return (
		<p className={styles.note} data-flx="shop.shop-checkout-modal.payment-price-note">
			{i18n._(PAYMENT_PRICE_NOTE_DESCRIPTOR, {price: formatTry(order.final_try_minor, i18n.locale)})}
		</p>
	);
};

interface StatusViewProps {
	icon: React.ReactNode;
	title: string;
	body?: string | null;
	orderId?: string | null;
	children?: React.ReactNode;
}

const StatusView = ({icon, title, body, orderId, children}: StatusViewProps) => (
	<div className={styles.status} data-flx="shop.shop-checkout-modal.status">
		{icon}
		<h2
			ref={focusOnMount}
			tabIndex={-1}
			className={styles.statusTitle}
			data-flx="shop.shop-checkout-modal.status-title"
		>
			{title}
		</h2>
		{body && (
			<p className={styles.statusBody} data-flx="shop.shop-checkout-modal.status-body">
				{body}
			</p>
		)}
		{children}
		{orderId && <OrderNumber orderId={orderId} data-flx="shop.shop-checkout-modal.order-number" />}
	</div>
);

// What a bundle gives, in its order: the catalog's list, and the order's own once one is open.
const BundleContents = ({items}: {items: ReadonlyArray<CosmeticItemResponse>}) => {
	const {i18n} = useLingui();
	return (
		<div className={styles.bundleContents} data-flx="shop.shop-checkout-modal.bundle-contents">
			<h3 className={styles.bundleTitle} data-flx="shop.shop-checkout-modal.bundle-title">
				{i18n._(BUNDLE_INCLUDES_DESCRIPTOR)}
			</h3>
			<ul className={styles.bundleList} data-flx="shop.shop-checkout-modal.bundle-list">
				{items.map((item) => (
					<li key={item.id} className={styles.bundleItem} data-flx="shop.shop-checkout-modal.bundle-item">
						<span className={styles.bundleType} data-flx="shop.shop-checkout-modal.bundle-type">
							{i18n._(COSMETIC_TYPE_LABELS[item.type as CosmeticType])}
						</span>
						<span className={styles.bundleName} data-flx="shop.shop-checkout-modal.bundle-name">
							{item.name}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
};

const Visual = observer(({target, checkout}: {target: ShopCheckoutTarget; checkout: ShopCheckoutFlow}) => {
	const {i18n} = useLingui();
	if (target.kind === 'bundle') {
		return (
			checkout.bundle && (
				<div className={styles.visual} data-flx="shop.shop-checkout-modal.visual--bundle">
					<ShopItemStage items={checkout.bundle.items} size="grid" data-flx="shop.shop-checkout-modal.bundle-stage" />
					<BundleContents items={checkout.bundle.items} data-flx="shop.shop-checkout-modal.bundle-contents-part" />
				</div>
			)
		);
	}
	const stageItem = target.kind === 'premium' ? (target.fromItem ?? null) : checkout.item;
	if (stageItem) {
		return (
			<div className={styles.visual} data-flx="shop.shop-checkout-modal.visual">
				<ShopItemStage items={[stageItem]} size="grid" data-flx="shop.shop-checkout-modal.shop-item-stage" />
				{target.kind === 'premium' && (
					<p className={styles.locked} data-flx="shop.shop-checkout-modal.locked">
						{i18n._(LOCKED_DESCRIPTOR, {name: stageItem.name, premiumProductName: PREMIUM_PRODUCT_NAME})}
					</p>
				)}
			</div>
		);
	}
	return (
		<div className={styles.visual} data-flx="shop.shop-checkout-modal.visual--2">
			<div className={styles.crownBox} data-flx="shop.shop-checkout-modal.crown-box">
				<CrownIcon weight="fill" className={styles.crown} data-flx="shop.shop-checkout-modal.crown" />
				<span className={styles.crownName} data-flx="shop.shop-checkout-modal.crown-name">
					{target.kind === 'visionary' ? i18n._(VISIONARY_NAME_DESCRIPTOR) : PREMIUM_PRODUCT_NAME}
				</span>
			</div>
		</div>
	);
});

const SummaryView = observer(
	({
		target,
		checkout,
		months,
		onMonths,
	}: {
		target: ShopCheckoutTarget;
		checkout: ShopCheckoutFlow;
		months: 1 | 3 | 12;
		onMonths: (months: 1 | 3 | 12) => void;
	}) => {
		const {i18n} = useLingui();
		const quote = checkout.quote;
		const isPremiumMember = Users.currentUser?.isPremium() ?? false;
		const itemPremiumPrice =
			(target.kind === 'item' || target.kind === 'bundle') && quote?.premium_percent === 0
				? (ShopCatalog.entryForSku(target.sku)?.price?.premium_try_minor ?? null)
				: null;
		return (
			<div className={styles.layout} data-flx="shop.shop-checkout-modal.layout">
				<div className={styles.grid} data-flx="shop.shop-checkout-modal.grid">
					<Visual target={target} checkout={checkout} data-flx="shop.shop-checkout-modal.visual-part" />
					<div className={styles.details} data-flx="shop.shop-checkout-modal.details">
						{target.kind === 'premium' && (
							<RadioGroup
								aria-label={i18n._(CHOOSE_A_PLAN_DESCRIPTOR)}
								options={ShopCatalog.packageEntries.map((entry) => ({
									value: entry.months,
									name: i18n._(PACKAGE_MONTHS_DESCRIPTOR, {months: entry.months}),
								}))}
								value={months}
								disabled={checkout.state === 'creating'}
								onChange={onMonths}
								renderContent={(option) => {
									const entry = ShopCatalog.packageEntries.find((candidate) => candidate.months === option.value);
									return entry ? (
										<PackageOption entry={entry} data-flx="shop.shop-checkout-modal.package-option" />
									) : null;
								}}
								data-flx="shop.shop-checkout-modal.radio-group"
							/>
						)}
						{target.kind === 'visionary' && (
							<p className={styles.rewards} data-flx="shop.shop-checkout-modal.rewards">
								{i18n._(VISIONARY_REWARDS_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
							</p>
						)}
						{quote ? (
							<Summary price={quote} data-flx="shop.shop-checkout-modal.summary-part" />
						) : (
							<div
								className={styles.skeleton}
								role="status"
								aria-busy="true"
								aria-label={i18n._(LOADING_PRICE_DESCRIPTOR)}
								data-flx="shop.shop-checkout-modal.skeleton"
							>
								<span className={styles.skeletonLine} data-flx="shop.shop-checkout-modal.skeleton-line" />
								<span className={styles.skeletonLine} data-flx="shop.shop-checkout-modal.skeleton-line--2" />
								<span className={styles.skeletonTotal} data-flx="shop.shop-checkout-modal.skeleton-total" />
							</div>
						)}
						{target.kind === 'premium' && (
							<p className={styles.note} data-flx="shop.shop-checkout-modal.one-time-note">
								{i18n._(ONE_TIME_PAYMENT_DESCRIPTOR)}
							</p>
						)}
						{target.kind === 'premium' && isPremiumMember && (
							<p className={styles.note} data-flx="shop.shop-checkout-modal.time-added-note">
								{i18n._(TIME_ADDED_ON_TOP_DESCRIPTOR)}
							</p>
						)}
						{target.kind === 'visionary' && (
							<p className={styles.note} data-flx="shop.shop-checkout-modal.lifetime-note">
								{i18n._(LIFETIME_MEANS_DESCRIPTOR)}
							</p>
						)}
						{target.kind === 'visionary' && isPremiumMember && (
							<p className={styles.note} data-flx="shop.shop-checkout-modal.kept-time-note">
								{i18n._(REMAINING_TIME_NOT_REFUNDED_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
							</p>
						)}
						{itemPremiumPrice != null && (
							<p className={styles.premiumHint} data-flx="shop.shop-checkout-modal.premium-hint">
								<CrownIcon weight="fill" className={styles.hintCrown} data-flx="shop.shop-checkout-modal.hint-crown" />
								<span data-flx="shop.shop-checkout-modal.premium-hint-text">
									<ShopPrice
										tryMinor={itemPremiumPrice}
										label={PREMIUM_PRICE_DESCRIPTOR}
										primaryOnly
										data-flx="shop.shop-checkout-modal.summary-view.shop-price"
									/>
								</span>
							</p>
						)}
					</div>
				</div>
			</div>
		);
	},
);

// Web: a real link, which no pop-up blocker stops. Desktop: the system browser,
// as Fluxer opens Stripe; no deep link back.
const PaymentPageButton = ({checkout, label}: {checkout: ShopCheckoutFlow; label: string}) => {
	const url = checkout.order?.payment_url;
	// The server only hands out https payment pages; anything else never becomes a link.
	if (!url?.startsWith('https://')) return null;
	if (isDesktop()) {
		return (
			<Button onClick={() => checkout.openPaymentPage()} data-flx="shop.shop-checkout-modal.button.open-payment-page">
				{label}
			</Button>
		);
	}
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className={styles.paymentLink}
			data-flx="shop.shop-checkout-modal.payment-link"
		>
			{label}
		</a>
	);
};

export const ShopCheckoutModal = observer<ShopCheckoutModalProps>(({target}) => {
	const {i18n} = useLingui();
	const [months, setMonths] = useState<1 | 3 | 12>(target.kind === 'premium' ? target.months : 1);
	const checkout = useShopCheckout(target.kind === 'premium' ? {...target, months} : target);
	const reducedMotion = Accessibility.useReducedMotion;
	const purchaseBlock = purchaseBlockOf(Users.currentUser);
	const decorations = target.kind === 'item' || target.kind === 'bundle';
	const order = checkout.order;
	const close = () => ModalCommands.pop();
	// After success, close either preview without waiting for the owned-items cache to load.
	const closeAll = () => {
		ModalCommands.pop();
		ModalCommands.popByType(ShopItemDetailModal);
		ModalCommands.popByType(ShopBundleDetailModal);
	};
	const title = decorations
		? i18n._(BUY_ITEM_DESCRIPTOR, {name: (target.kind === 'item' ? checkout.item : checkout.bundle)?.name ?? ''})
		: target.kind === 'premium'
			? i18n._(BUY_PREMIUM_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})
			: i18n._(VISIONARY_NAME_DESCRIPTOR);
	const closeButton = (
		<Button variant="secondary" onClick={close} data-flx="shop.shop-checkout-modal.button.close">
			{i18n._(CLOSE_DESCRIPTOR)}
		</Button>
	);
	const dangerIcon = (
		<XCircleIcon
			weight="fill"
			className={clsx(styles.statusIcon, styles.danger)}
			data-flx="shop.shop-checkout-modal.x-circle-icon"
		/>
	);
	const warningIcon = (
		<WarningIcon weight="fill" className={styles.statusIcon} data-flx="shop.shop-checkout-modal.warning-icon" />
	);
	let view: string = checkout.state;
	let body: React.ReactNode;
	let footer: React.ReactNode;
	switch (checkout.state) {
		case 'quoting':
		case 'ready':
		case 'creating':
			view = 'summary';
			body = (
				<SummaryView
					target={target}
					checkout={checkout}
					months={months}
					onMonths={setMonths}
					data-flx="shop.shop-checkout-modal.summary-view"
				/>
			);
			footer = (
				<>
					<Button variant="secondary" onClick={close} data-flx="shop.shop-checkout-modal.button.cancel">
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
					<PurchaseDisabledWrapper
						disabled={purchaseBlock != null}
						tooltipText={i18n._(
							purchaseBlock === 'unclaimed' ? CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR : VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
						)}
						data-flx="shop.shop-checkout-modal.purchase-disabled-wrapper"
					>
						<Button
							onClick={() => void checkout.start()}
							submitting={checkout.state === 'creating'}
							disabled={checkout.state === 'quoting' || purchaseBlock != null}
							data-flx="shop.shop-checkout-modal.button.purchase"
						>
							{i18n._(PURCHASE_DESCRIPTOR)}
						</Button>
					</PurchaseDisabledWrapper>
				</>
			);
			break;
		case 'payment_ready':
			body = order && (
				<StatusView
					icon={<ArrowSquareOutIcon className={styles.statusIcon} data-flx="shop.shop-checkout-modal.ready-icon" />}
					title={i18n._(OPEN_PAYMENT_PAGE_DESCRIPTOR)}
					orderId={order.id}
					data-flx="shop.shop-checkout-modal.payment-ready"
				>
					<PaymentPriceNote order={order} />
				</StatusView>
			);
			footer = (
				<>
					<Button variant="secondary" onClick={close} data-flx="shop.shop-checkout-modal.button.ready-cancel">
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
					<Button onClick={() => checkout.openPaymentPage()} data-flx="shop.shop-checkout-modal.button.ready-continue">
						{i18n._(CONTINUE_DESCRIPTOR)}
					</Button>
				</>
			);
			break;
		case 'price_changed':
		case 'contents_changed': {
			const contentsChanged = checkout.state === 'contents_changed';
			body = (
				<div className={styles.priceChanged} data-flx="shop.shop-checkout-modal.price-changed">
					<h2
						ref={focusOnMount}
						tabIndex={-1}
						className={styles.statusTitle}
						data-flx="shop.shop-checkout-modal.price-changed-title"
					>
						{i18n._(contentsChanged ? BUNDLE_CONTENTS_CHANGED_DESCRIPTOR : PRICE_CHANGED_DESCRIPTOR)}
					</h2>
					{contentsChanged && checkout.bundle && (
						<BundleContents items={checkout.bundle.items} data-flx="shop.shop-checkout-modal.changed-contents" />
					)}
					{order && checkout.quote && (
						<Summary price={order} before={checkout.quote} data-flx="shop.shop-checkout-modal.new-summary" />
					)}
					{/* sanalyer: the summary's total is the amount charged; the note only stands in when there is none. */}
					{order && !checkout.quote && <PaymentPriceNote order={order} />}
				</div>
			);
			footer = (
				<>
					<Button variant="secondary" onClick={close} data-flx="shop.shop-checkout-modal.button.cancel--2">
						{i18n._(CANCEL_DESCRIPTOR)}
					</Button>
					<Button onClick={() => checkout.openPaymentPage()} data-flx="shop.shop-checkout-modal.button.continue">
						{i18n._(contentsChanged ? CONTINUE_DESCRIPTOR : CONTINUE_AT_NEW_PRICE_DESCRIPTOR)}
					</Button>
				</>
			);
			break;
		}
		case 'awaiting':
			body = (
				<StatusView
					icon={<ArrowSquareOutIcon className={styles.statusIcon} data-flx="shop.shop-checkout-modal.arrow-icon" />}
					title={i18n._(FINISH_PAYING_IN_BROWSER_DESCRIPTOR)}
					body={i18n._(PAYMENT_PAGE_OPENED_DESCRIPTOR)}
					orderId={order?.id}
					data-flx="shop.shop-checkout-modal.awaiting"
				>
					{order && <PaymentPriceNote order={order} />}
					<div className={styles.waiting} role="status" data-flx="shop.shop-checkout-modal.waiting">
						<Spinner size="small" data-flx="shop.shop-checkout-modal.spinner" />
						<span data-flx="shop.shop-checkout-modal.waiting-text">{i18n._(WAITING_FOR_PAYMENT_DESCRIPTOR)}</span>
					</div>
				</StatusView>
			);
			footer = (
				<>
					{closeButton}
					<PaymentPageButton
						checkout={checkout}
						label={i18n._(OPEN_PAYMENT_PAGE_DESCRIPTOR)}
						data-flx="shop.shop-checkout-modal.payment-page-button"
					/>
				</>
			);
			break;
		case 'approved':
			body = checkout.success && (
				<ShopEquippedSuccess result={checkout.success} data-flx="shop.shop-checkout-modal.shop-equipped-success" />
			);
			footer = (
				<>
					{decorations && (
						<Button
							variant="secondary"
							onClick={() => {
								closeAll();
								ModalCommands.push(
									modal(() => (
										<UserSettingsModal
											initialTab="profile_cosmetics"
											data-flx="shop.shop-checkout-modal.user-settings-modal"
										/>
									)),
								);
							}}
							data-flx="shop.shop-checkout-modal.button.profile-decorations"
						>
							{i18n._(PROFILE_DECORATIONS_DESCRIPTOR)}
						</Button>
					)}
					<Button onClick={closeAll} data-flx="shop.shop-checkout-modal.button.okay">
						{i18n._(OKAY_DESCRIPTOR)}
					</Button>
				</>
			);
			break;
		case 'failed':
		case 'failed_mismatch':
			body = (
				<StatusView
					icon={dangerIcon}
					title={i18n._(PAYMENT_NOT_COMPLETED_DESCRIPTOR)}
					body={i18n._(checkout.state === 'failed' ? PAYMENT_NOT_APPROVED_DESCRIPTOR : ORDER_MISMATCH_DESCRIPTOR)}
					orderId={order?.id}
					data-flx="shop.shop-checkout-modal.failed"
				/>
			);
			footer = (
				<>
					{closeButton}
					{checkout.state === 'failed' && (
						<Button onClick={() => checkout.retry()} data-flx="shop.shop-checkout-modal.button.retry">
							{i18n._(TRY_AGAIN_DESCRIPTOR)}
						</Button>
					)}
				</>
			);
			break;
		case 'timeout':
			body = (
				<StatusView
					icon={warningIcon}
					title={i18n._(PAYMENT_NOT_CONFIRMED_YET_DESCRIPTOR)}
					body={i18n._(PAYMENT_TIMEOUT_DESCRIPTOR)}
					orderId={order?.id}
					data-flx="shop.shop-checkout-modal.timeout"
				/>
			);
			footer = (
				<>
					{closeButton}
					<Button
						onClick={() => void checkout.checkAgain()}
						submitting={checkout.checking}
						data-flx="shop.shop-checkout-modal.button.check-again"
					>
						{i18n._(CHECK_AGAIN_DESCRIPTOR)}
					</Button>
				</>
			);
			break;
		case 'sales_closed':
		case 'sold_out':
			body = (
				<StatusView
					icon={<StorefrontIcon className={styles.statusIcon} data-flx="shop.shop-checkout-modal.storefront-icon" />}
					title={i18n._(checkout.state === 'sold_out' ? SOLD_OUT_DESCRIPTOR : SALES_PAUSED_DESCRIPTOR)}
					body={i18n._(
						checkout.state === 'sold_out' ? VISIONARY_SOLD_OUT_DESCRIPTOR : CANT_BE_BOUGHT_RIGHT_NOW_DESCRIPTOR,
					)}
					data-flx="shop.shop-checkout-modal.closed"
				/>
			);
			footer = closeButton;
			break;
		case 'busy':
			body = (
				<StatusView
					icon={warningIcon}
					title={i18n._(TOO_MANY_ORDERS_DESCRIPTOR)}
					body={
						checkout.failureMessage ??
						(checkout.waitMinutes === null
							? i18n._(TRY_AGAIN_IN_A_FEW_SECONDS_DESCRIPTOR)
							: i18n._(RATE_LIMITED_WAIT_DESCRIPTOR, {
									duration: i18n._(MINUTES_DURATION_PLURAL_DESCRIPTOR, {minutes: checkout.waitMinutes}),
								}))
					}
					data-flx="shop.shop-checkout-modal.busy"
				/>
			);
			footer = (
				<>
					{closeButton}
					<Button onClick={() => checkout.retry()} data-flx="shop.shop-checkout-modal.button.retry--2">
						{i18n._(TRY_AGAIN_DESCRIPTOR)}
					</Button>
				</>
			);
			break;
		case 'already_owned':
			body = (
				<StatusView
					icon={warningIcon}
					title={i18n._(target.kind === 'bundle' ? BUNDLE_ITEM_OWNED_DESCRIPTOR : ALREADY_OWNED_DESCRIPTOR)}
					data-flx="shop.shop-checkout-modal.already-owned"
				/>
			);
			// A bundle has nothing to equip: the server refuses it whole.
			footer = (
				<>
					{closeButton}
					{target.kind !== 'bundle' && (
						<Button
							onClick={() => void checkout.equip()}
							submitting={checkout.checking}
							data-flx="shop.shop-checkout-modal.button.equip"
						>
							{i18n._(EQUIP_DESCRIPTOR)}
						</Button>
					)}
				</>
			);
			break;
	}
	return (
		<Modal.Root size="medium" centered data-flx="shop.shop-checkout-modal.modal-root">
			<Modal.Header title={title} data-flx="shop.shop-checkout-modal.modal-header" />
			<Modal.Content data-flx="shop.shop-checkout-modal.content">
				<AnimatePresence mode="wait" initial={false} data-flx="shop.shop-checkout-modal.animate-presence">
					<motion.div
						key={view}
						initial={reducedMotion ? false : {opacity: 0, transform: 'translateY(4px)'}}
						animate={{
							opacity: 1,
							transform: 'translateY(0px)',
							transition: {duration: reducedMotion ? 0 : 0.18, ease: EASE_OUT},
						}}
						exit={reducedMotion ? {opacity: 1} : {opacity: 0, transition: {duration: 0.12, ease: EASE_OUT}}}
						data-flx="shop.shop-checkout-modal.view"
					>
						{body}
					</motion.div>
				</AnimatePresence>
			</Modal.Content>
			<Modal.Footer data-flx="shop.shop-checkout-modal.modal-footer">{footer}</Modal.Footer>
		</Modal.Root>
	);
});
