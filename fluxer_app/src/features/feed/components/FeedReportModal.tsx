// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import styles from '@app/features/feed/components/FeedReportModal.module.css';
import {
	type FeedReportCategoryId,
	type FeedReportReasonId,
	type FeedReportStep,
	getFeedReportCategory,
	getFeedReportCategoryOptions,
	getFeedReportCategoryTitle,
	getFeedReportChildSafetyNote,
	getFeedReportModalDescription,
	getFeedReportReasonOptions,
	getFeedReportReasonTitle,
	getFeedReportSafetyNote,
	getFeedReportSuccessCopy,
} from '@app/features/feed/utils/FeedReportCopy';
import {CANCEL_DESCRIPTOR, CONTINUE_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
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
const STEP_ORDER: ReadonlyArray<FeedReportStep> = ['category', 'reason', 'success'];

interface FeedReportModalProps {
	title: string;
	onSubmit: (category: string) => Promise<void>;
}

// The in-app report flow (IAR) for a feed post or comment: the same rule categories, reasons, account gate and copy
// as a message report, sent to POST /reports/feed-post or /reports/feed-comment with the message category mapping.
export const FeedReportModal = observer(({title, onSubmit}: FeedReportModalProps) => {
	const {i18n} = useLingui();
	const [step, setStep] = useState<FeedReportStep>('category');
	const [category, setCategory] = useState<FeedReportCategoryId | null>(null);
	const [reason, setReason] = useState<FeedReportReasonId | null>(null);
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
			await onSubmit(getFeedReportCategory(reason));
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
	const childSafetyNote = getFeedReportChildSafetyNote(i18n, reason);
	const safetyNote = step === 'reason' ? getFeedReportSafetyNote(i18n, reason) : null;
	const successCopy = getFeedReportSuccessCopy(i18n);
	const renderStep = () => {
		switch (step) {
			case 'category':
				return (
					<div className={styles.step} data-flx="feed.feed-report-modal.category-step">
						<h2 className={styles.stepTitle} data-flx="feed.feed-report-modal.category-step-title">
							{getFeedReportCategoryTitle(i18n)}
						</h2>
						<RadioGroup<FeedReportCategoryId>
							options={getFeedReportCategoryOptions(i18n)}
							value={category}
							onChange={setCategory}
							aria-label={getFeedReportCategoryTitle(i18n)}
							data-flx="feed.feed-report-modal.radio-group.set-category"
						/>
					</div>
				);
			case 'reason':
				return (
					<div className={styles.step} data-flx="feed.feed-report-modal.reason-step">
						<h2 className={styles.stepTitle} data-flx="feed.feed-report-modal.reason-step-title">
							{getFeedReportReasonTitle(i18n)}
						</h2>
						<RadioGroup<FeedReportReasonId>
							options={getFeedReportReasonOptions(i18n, category)}
							value={reason}
							onChange={setReason}
							aria-label={getFeedReportReasonTitle(i18n)}
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
						text={getFeedReportModalDescription(i18n)}
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
