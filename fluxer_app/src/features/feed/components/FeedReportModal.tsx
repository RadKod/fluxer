// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {CANCEL_DESCRIPTOR, CONTINUE_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {
	getReportCategoryForReason,
	type IARRuleCategoryId,
	type IARRuleReasonId,
} from '@app/features/moderation/components/report_modal/IARFlowUtils';
import styles from '@app/features/moderation/components/report_modal/IARModal.module.css';
import {
	getIARCategoryTitle,
	getIARChildSafetyRoutingNote,
	getIARModalDescription,
	getIARReasonTitle,
	getIARRuleCategoryOptions,
	getIARRuleReasonOptions,
	getIARSpecialSafetyNote,
	getIARSuccessCopy,
} from '@app/features/moderation/components/report_modal/IARModalCopy';
import type {IARStep} from '@app/features/moderation/components/report_modal/IARModalTypes';
import {canSubmitReport, showReportRestrictionDialog} from '@app/features/moderation/utils/ReportVerificationGate';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import {SteppedCarousel} from '@app/features/ui/stepped_carousel/SteppedCarousel';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

const BACK_DESCRIPTOR = msg({
	message: 'Back',
	comment: 'Footer button in the IAR modal that returns to the previous step.',
});
const SEND_REPORT_DESCRIPTOR = msg({
	message: 'Send report',
	comment: 'Footer submit button in the IAR modal. Sends the report to the safety team.',
});
const DONE_DESCRIPTOR = msg({
	message: 'Done',
	comment: 'Footer button in the IAR modal on the final / success screen. Closes the modal.',
});
const COULDN_T_SEND_DESCRIPTOR = msg({
	message: "Couldn't send it. Try again.",
	comment: 'Error toast in the IAR modal when the report submission fails. Keep tone plain and short.',
});

const logger = new Logger('FeedReportModal');
const STEP_ORDER: ReadonlyArray<IARStep> = ['category', 'reason', 'success'];

interface FeedReportModalProps {
	title: string;
	onSubmit: (category: string) => Promise<void>;
}

// The in-app report flow (IAR) for a feed post or comment: the same rule categories, reasons, account gate and copy
// as a message report, sent to POST /reports/feed-post or /reports/feed-comment with the message category mapping.
export const FeedReportModal = observer(({title, onSubmit}: FeedReportModalProps) => {
	const {i18n} = useLingui();
	const [step, setStep] = useState<IARStep>('category');
	const [category, setCategory] = useState<IARRuleCategoryId | null>(null);
	const [reason, setReason] = useState<IARRuleReasonId | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const handleContinue = () => {
		if (!canSubmitReport()) {
			showReportRestrictionDialog();
			return;
		}
		setReason(null);
		setStep('reason');
	};
	const handleSubmit = async () => {
		if (reason === null) return;
		if (!canSubmitReport()) {
			showReportRestrictionDialog();
			return;
		}
		setSubmitting(true);
		try {
			await onSubmit(getReportCategoryForReason('message', reason));
			setStep('success');
		} catch (error) {
			logger.error('Failed to submit feed report:', error);
			ToastCommands.error(i18n._(COULDN_T_SEND_DESCRIPTOR));
		} finally {
			setSubmitting(false);
		}
	};
	const handleBack = () => {
		if (step === 'reason') {
			setReason(null);
			setStep('category');
			return;
		}
		ModalCommands.pop();
	};
	const childSafetyNote = getIARChildSafetyRoutingNote(i18n, 'message', reason);
	const safetyNote = step === 'reason' ? getIARSpecialSafetyNote(i18n, reason) : null;
	const successCopy = getIARSuccessCopy(i18n);
	const renderStep = () => {
		switch (step) {
			case 'category':
				return (
					<div className={styles.step} data-flx="feed.feed-report-modal.category-step">
						<h2 className={styles.stepTitle} data-flx="feed.feed-report-modal.category-step-title">
							{getIARCategoryTitle(i18n)}
						</h2>
						<RadioGroup<IARRuleCategoryId>
							options={getIARRuleCategoryOptions(i18n)}
							value={category}
							onChange={setCategory}
							aria-label={getIARCategoryTitle(i18n)}
							data-flx="feed.feed-report-modal.radio-group.set-category"
						/>
					</div>
				);
			case 'reason':
				return (
					<div className={styles.step} data-flx="feed.feed-report-modal.reason-step">
						<h2 className={styles.stepTitle} data-flx="feed.feed-report-modal.reason-step-title">
							{getIARReasonTitle(i18n)}
						</h2>
						<RadioGroup<IARRuleReasonId>
							options={getIARRuleReasonOptions(i18n, 'message', category)}
							value={reason}
							onChange={setReason}
							aria-label={getIARReasonTitle(i18n)}
							data-flx="feed.feed-report-modal.radio-group.set-reason"
						/>
						{childSafetyNote !== null && (
							<div className={styles.inlineNote} data-flx="feed.feed-report-modal.child-safety-note">
								{childSafetyNote}
							</div>
						)}
						{safetyNote !== null && (
							<div className={styles.inlineNote} data-flx="feed.feed-report-modal.safety-note">
								{safetyNote}
							</div>
						)}
					</div>
				);
			case 'success':
				return (
					<div className={styles.step} data-flx="feed.feed-report-modal.success-step">
						<h2 className={styles.stepTitle} data-flx="feed.feed-report-modal.success-step-title">
							{successCopy.title}
						</h2>
						<p className={styles.stepBody} data-flx="feed.feed-report-modal.success-step-body">
							{successCopy.body}
						</p>
					</div>
				);
		}
	};
	return (
		<Modal.Root size="small" centered data-flx="feed.feed-report-modal.modal-root">
			<Modal.Header title={title} data-flx="feed.feed-report-modal.modal-header" />
			<Modal.Content data-flx="feed.feed-report-modal.modal-content">
				<Modal.ContentLayout data-flx="feed.feed-report-modal.modal-content-layout">
					<Modal.ScreenReaderLabel
						text={getIARModalDescription(i18n)}
						data-flx="feed.feed-report-modal.modal-screen-reader-label"
					/>
					<SteppedCarousel step={step} steps={STEP_ORDER} data-flx="feed.feed-report-modal.stepped-carousel">
						{renderStep()}
					</SteppedCarousel>
				</Modal.ContentLayout>
			</Modal.Content>
			<Modal.Footer data-flx="feed.feed-report-modal.modal-footer">
				{step !== 'success' && (
					<Button
						variant="secondary"
						onClick={handleBack}
						disabled={submitting}
						data-flx="feed.feed-report-modal.button.back"
					>
						{i18n._(step === 'category' ? CANCEL_DESCRIPTOR : BACK_DESCRIPTOR)}
					</Button>
				)}
				{step === 'category' && (
					<Button
						onClick={handleContinue}
						disabled={category === null}
						data-flx="feed.feed-report-modal.button.continue"
					>
						{i18n._(CONTINUE_DESCRIPTOR)}
					</Button>
				)}
				{step === 'reason' && (
					<Button
						onClick={handleSubmit}
						disabled={reason === null || submitting}
						submitting={submitting}
						data-flx="feed.feed-report-modal.button.submit"
					>
						{i18n._(SEND_REPORT_DESCRIPTOR)}
					</Button>
				)}
				{step === 'success' && (
					<Button onClick={() => ModalCommands.pop()} data-flx="feed.feed-report-modal.button.done">
						{i18n._(DONE_DESCRIPTOR)}
					</Button>
				)}
			</Modal.Footer>
		</Modal.Root>
	);
});
