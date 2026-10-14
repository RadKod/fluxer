// SPDX-License-Identifier: AGPL-3.0-or-later

import {formatPerkValue} from '@app/features/app/components/dialogs/components/FeatureComparisonTable';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import {PremiumFaq} from '@app/features/premium/components/PremiumFaq';
import {PremiumHalo} from '@app/features/premium/components/PremiumHalo';
import {PremiumStatusCard} from '@app/features/premium/components/PremiumStatusCard';
import styles from '@app/features/premium/components/pages/PremiumPage.module.css';
import {usePremiumTrial} from '@app/features/premium/hooks/usePremiumTrial';
import {ShopRedeemField} from '@app/features/shop/components/ShopRedeemField';
import {BUY_PREMIUM_DESCRIPTOR, ONE_TIME_PAYMENT_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import Users from '@app/features/user/state/Users';
import heroArtUrl from '@app/media/images/premium/plus/plus-ana.webp';
import heroArtSmallUrl from '@app/media/images/premium/plus/plus-ana-1200.webp';
import {isNumericTierPerk, LIMIT_TIER_PERKS} from '@fluxer/constants/src/LimitTierPerks';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CrownIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useId, useState} from 'react';

// The premium page's look, one component per section; PremiumPage owns the tabs, the scroll and where buttons lead.

const HERO_TITLE_DESCRIPTOR = msg({
	message: 'Make your profile shine and your limits lift',
	comment: 'Headline at the top of the Plus page. Sentence case.',
});
const HERO_LEAD_DESCRIPTOR = msg({
	message:
		'The {premiumProductName} badge, an animated avatar and the decorations included with {premiumProductName}. On top of that, {fileSize} uploads, {videoQuality} video and emoji everywhere.',
	comment:
		'Line under the Plus page headline. {fileSize} is the Plus upload limit (for example "500 MB"), {videoQuality} the best video quality (for example "4K/60fps"). Preserve the placeholders.',
});
const TRY_FREE_FOR_DAYS_DESCRIPTOR = msg({
	message: '{days, plural, one {Try free for # day} other {Try free for # days}}',
	comment: 'Button in the Plus page hero that starts the free trial. {days} is the trial length.',
});
const FAQ_TITLE_DESCRIPTOR = msg({
	message: 'Frequently asked questions',
	comment: 'Heading of the questions section at the bottom of the Plus page.',
});

// The best stream quality premium unlocks; a resolution and frame rate token, not translated.
const PREMIUM_VIDEO_QUALITY = '4K/60fps';
const FILE_SIZE_PERK = LIMIT_TIER_PERKS.find((perk) => perk.id === 'max_attachment_file_size');

interface PremiumHeroSectionProps {
	sectionRef: React.Ref<HTMLElement>;
	// The buy buttons or the member's status box; the floating capsule hides while they show.
	actionsRef: React.Ref<HTMLDivElement>;
	// Leads to the plans; null when there is nothing to buy.
	onBuy: (() => void) | null;
}

export const PremiumHero = observer(({sectionRef, actionsRef, onBuy}: PremiumHeroSectionProps) => {
	const {i18n} = useLingui();
	const titleId = useId();
	const trial = usePremiumTrial();
	const [hovering, setHovering] = useState(false);
	const [focused, setFocused] = useState(false);
	// The lights and the buy halo move only while the hero is hovered or focused, and never where Fluxer
	// holds motion.
	const animated = useShouldAnimate({kind: 'avatar', isHovering: hovering, isFocused: focused});
	const isPremium = Users.currentUser?.isPremium() ?? false;
	const fileSize =
		FILE_SIZE_PERK && isNumericTierPerk(FILE_SIZE_PERK)
			? formatPerkValue(i18n, FILE_SIZE_PERK, FILE_SIZE_PERK.stockValue, true)
			: '';
	return (
		<section
			ref={sectionRef}
			className={styles.hero}
			aria-labelledby={titleId}
			data-section="home"
			data-animated={animated}
			onMouseEnter={() => setHovering(true)}
			onMouseLeave={() => setHovering(false)}
			onFocus={() => setFocused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
			data-flx="premium.premium-page.hero"
		>
			{/* The Plus art across the top of the page, fading into it; the perk cards stand over its lower part. */}
			<div className={styles.heroArt} aria-hidden="true" data-flx="premium.premium-page.hero-art">
				<img
					className={styles.heroArtImage}
					src={heroArtUrl}
					srcSet={`${heroArtSmallUrl} 1200w, ${heroArtUrl} 2400w`}
					sizes="100vw"
					alt=""
					fetchPriority="high"
					decoding="async"
					draggable={false}
					data-flx="premium.premium-page.hero-art-image"
				/>
			</div>
			<div className={styles.heroText} data-flx="premium.premium-page.hero-text">
				<h1 id={titleId} className={styles.heroTitle} data-flx="premium.premium-page.title">
					{i18n._(HERO_TITLE_DESCRIPTOR)}
				</h1>
				<p className={styles.heroLead} data-flx="premium.premium-page.lead">
					{i18n._(HERO_LEAD_DESCRIPTOR, {
						premiumProductName: PREMIUM_PRODUCT_NAME,
						fileSize,
						videoQuality: PREMIUM_VIDEO_QUALITY,
					})}
				</p>
			</div>
			<div ref={actionsRef} className={styles.heroActions} data-flx="premium.premium-page.hero-actions">
				<PremiumStatusCard
					onAddTime={onBuy}
					buttonClassName={styles.heroButton}
					data-flx="premium.premium-page.status-card"
				/>
				{!isPremium && (onBuy || trial) && (
					<div className={styles.heroCtas} data-flx="premium.premium-page.hero-ctas">
						{onBuy && (
							<PremiumHalo
								size="large"
								animated={animated}
								className={styles.heroHalo}
								data-flx="premium.premium-page.hero-halo"
							>
								<Button
									className={styles.heroButton}
									leftIcon={<CrownIcon weight="fill" aria-hidden="true" data-flx="premium.premium-page.buy-icon" />}
									onClick={onBuy}
									data-flx="premium.premium-page.button.buy"
								>
									{i18n._(BUY_PREMIUM_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
								</Button>
							</PremiumHalo>
						)}
						{trial && (
							<Button
								variant="secondary"
								className={styles.heroButton}
								onClick={() => void trial.start()}
								submitting={trial.claiming}
								disabled={trial.claiming}
								data-flx="premium.premium-page.button.try-free"
							>
								{i18n._(TRY_FREE_FOR_DAYS_DESCRIPTOR, {days: trial.days})}
							</Button>
						)}
					</div>
				)}
				{!isPremium && onBuy && (
					<p className={styles.heroFine} data-flx="premium.premium-page.one-time">
						{i18n._(ONE_TIME_PAYMENT_DESCRIPTOR)}
					</p>
				)}
			</div>
		</section>
	);
});

interface PremiumQuestionsProps {
	// The code field's id, which the bar's "Redeem a code" jumps to; null where codes are off.
	codeInputId: string | null;
}

export const PremiumQuestions = observer(({codeInputId}: PremiumQuestionsProps) => {
	const {i18n} = useLingui();
	return (
		<>
			<h2 className={styles.sectionTitle} data-flx="premium.premium-page.faq-title">
				{i18n._(FAQ_TITLE_DESCRIPTOR)}
			</h2>
			<div
				className={clsx(styles.questions, codeInputId && styles.questionsWithCode)}
				data-flx="premium.premium-page.questions"
			>
				{codeInputId && (
					<ShopRedeemField
						variant="card"
						inputId={codeInputId}
						labelHidden={true}
						data-flx="premium.premium-page.code-card"
					/>
				)}
				<PremiumFaq data-flx="premium.premium-page.faq" />
			</div>
		</>
	);
});
