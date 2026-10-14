// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {useLocation} from '@app/features/platform/components/router/RouterReact';
import styles from '@app/features/premium/components/pages/PremiumCallbackPage.module.css';
import {
	CONFIRMING_PAYMENT_DESCRIPTOR,
	PAYMENT_RETURN_PENDING_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Spinner} from '@app/features/ui/components/Spinner';
import {Trans, useLingui} from '@lingui/react/macro';
import {CheckCircleIcon, XCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

// Micup: the shop's Payriff return. The server sends the browser here with a status and
// nothing else; the page needs no session, since a desktop buyer pays in a browser that may not be signed in.
const PAYRIFF_RETURN_STATUSES = new Set(['success', 'cancel', 'pending']);

const PremiumCallbackPage = observer(() => {
	const {i18n} = useLingui();
	const location = useLocation();
	const queryParams = new URLSearchParams(location.search);
	const status = queryParams.get('status');
	const isPayriffReturn =
		RuntimeConfig.isSelfHosted() && RuntimeConfig.giftCodesEnabled && PAYRIFF_RETURN_STATUSES.has(status ?? '');
	const leavesForApp = RuntimeConfig.isSelfHosted() && !isPayriffReturn;
	useEffect(() => {
		if (leavesForApp) {
			window.location.replace('/');
		}
	}, [leavesForApp]);

	if (leavesForApp) {
		return null;
	}
	const isPayriffPending = isPayriffReturn && status === 'pending';
	const isSuccess = status === 'success';
	const isCancel = status === 'cancel';
	const isClosedBillingPortal = status === 'closed-billing-portal';
	return (
		<div className={styles.container} data-flx="premium.premium-callback-page.container">
			{isSuccess && (
				<>
					<CheckCircleIcon
						className={styles.successIcon}
						weight="fill"
						data-flx="premium.premium-callback-page.success-icon"
					/>
					<div className={styles.content} data-flx="premium.premium-callback-page.content">
						<h1 className={styles.title} data-flx="premium.premium-callback-page.title">
							<Trans>Payment successful</Trans>
						</h1>
						<p className={styles.description} data-flx="premium.premium-callback-page.description">
							<Trans>Your payment was successful. You can now close this tab and return to the app.</Trans>
						</p>
					</div>
				</>
			)}
			{isCancel && (
				<>
					<XCircleIcon className={styles.errorIcon} weight="fill" data-flx="premium.premium-callback-page.error-icon" />
					<div className={styles.content} data-flx="premium.premium-callback-page.content--2">
						<h1 className={styles.title} data-flx="premium.premium-callback-page.title--2">
							<Trans>Payment canceled</Trans>
						</h1>
						<p className={styles.description} data-flx="premium.premium-callback-page.description--2">
							<Trans>Your payment was canceled. You can now close this tab and return to the app.</Trans>
						</p>
					</div>
				</>
			)}
			{isClosedBillingPortal && (
				<>
					<CheckCircleIcon
						className={styles.successIcon}
						weight="fill"
						data-flx="premium.premium-callback-page.success-icon--2"
					/>
					<div className={styles.content} data-flx="premium.premium-callback-page.content--3">
						<h1 className={styles.title} data-flx="premium.premium-callback-page.title--3">
							<Trans>All done</Trans>
						</h1>
						<p className={styles.description} data-flx="premium.premium-callback-page.description--3">
							<Trans>You can now close this tab and return to the app.</Trans>
						</p>
					</div>
				</>
			)}
			{isPayriffPending && (
				<>
					<Spinner size="large" data-flx="premium.premium-callback-page.payriff-pending-spinner" />
					<div className={styles.content} data-flx="premium.premium-callback-page.payriff-pending-content">
						<h1 className={styles.title} data-flx="premium.premium-callback-page.payriff-pending-title">
							{i18n._(CONFIRMING_PAYMENT_DESCRIPTOR)}
						</h1>
						<p className={styles.description} data-flx="premium.premium-callback-page.payriff-pending-description">
							{i18n._(PAYMENT_RETURN_PENDING_DESCRIPTOR)}
						</p>
					</div>
				</>
			)}
			{!isSuccess && !isCancel && !isClosedBillingPortal && !isPayriffPending && (
				<div className={styles.content} data-flx="premium.premium-callback-page.content--9">
					<h1 className={styles.title} data-flx="premium.premium-callback-page.title--9">
						<Trans>Invalid status</Trans>
					</h1>
					<p className={styles.description} data-flx="premium.premium-callback-page.description--9">
						<Trans>An invalid status was provided. You can now close this tab and return to the app.</Trans>
					</p>
				</div>
			)}
		</div>
	);
});

export default PremiumCallbackPage;
