// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import styles from '@app/features/premium/components/PremiumFaq.module.css';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';

const RENEWS_QUESTION_DESCRIPTOR = msg({
	message: 'Does it renew on its own?',
	comment: 'Question in the FAQ at the bottom of the Plus page.',
});
const RENEWS_ANSWER_DESCRIPTOR = msg({
	message:
		'No. You pay for a package once, and {premiumProductName} turns off by itself when the time runs out. To keep it, buy another package with Add time; the new time is added on top of what you have left.',
	comment:
		'Answer in the Plus page FAQ. "Add time" is the name of the button on the Plus page. Preserve {premiumProductName}.',
});
const DECORATIONS_QUESTION_DESCRIPTOR = msg({
	message: 'What happens to my decorations when {premiumProductName} ends?',
	comment: 'Question in the FAQ at the bottom of the Plus page. Preserve {premiumProductName}.',
});
const DECORATIONS_ANSWER_DESCRIPTOR = msg({
	message:
		'Decorations included with {premiumProductName} come off and cannot be worn until you have {premiumProductName} again. Decorations you bought in the shop stay yours.',
	comment: 'Answer in the Plus page FAQ. Preserve {premiumProductName}.',
});
const GIFT_QUESTION_DESCRIPTOR = msg({
	message: 'Can I give {premiumProductName} to someone else?',
	comment: 'Question in the FAQ at the bottom of the Plus page. Preserve {premiumProductName}.',
});
const GIFT_ANSWER_DESCRIPTOR = msg({
	message: 'Not right now. You can buy {premiumProductName} only for your own account.',
	comment: 'Answer in the Plus page FAQ. Preserve {premiumProductName}.',
});

const ITEMS = [
	[RENEWS_QUESTION_DESCRIPTOR, RENEWS_ANSWER_DESCRIPTOR],
	// sanalyer: no currency question; prices are Turkish lira and charged as shown.
	[DECORATIONS_QUESTION_DESCRIPTOR, DECORATIONS_ANSWER_DESCRIPTOR],
	[GIFT_QUESTION_DESCRIPTOR, GIFT_ANSWER_DESCRIPTOR],
] as const;

// Micup: the premium page's questions, as native <details>; the first one opens with the page.
export function PremiumFaq() {
	const {i18n} = useLingui();
	const values = {premiumProductName: PREMIUM_PRODUCT_NAME};
	return (
		<div className={styles.faq} data-flx="premium.premium-faq.faq">
			{ITEMS.map(([question, answer], index) => (
				<details
					key={index}
					open={index === 0 || undefined}
					className={styles.item}
					data-flx="premium.premium-faq.item"
				>
					<summary className={styles.question} data-flx="premium.premium-faq.question">
						{i18n._(question, values)}
					</summary>
					<p className={styles.answer} data-flx="premium.premium-faq.answer">
						{i18n._(answer, values)}
					</p>
				</details>
			))}
		</div>
	);
}
