// SPDX-License-Identifier: AGPL-3.0-or-later

import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import type {RadioOption} from '@app/features/ui/radio_group/RadioGroup';
import type {ReportMessageRequest} from '@fluxer/schema/src/domains/report/ReportSchemas';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

// Micup: upstream replaced the client-side report modal with server-driven report flows, which have no feed target.
// Feed posts and comments keep the message-report rule picker; this is its message-context subset.

export type FeedReportStep = 'category' | 'reason' | 'success';
export type FeedReportCategoryId =
	| 'targeted_harm'
	| 'safety_minors'
	| 'privacy_identity'
	| 'deception'
	| 'illegal_other';
export type FeedReportReasonId =
	| 'harassment'
	| 'hate'
	| 'violence'
	| 'mature_content'
	| 'child_safety'
	| 'harmful_misinformation'
	| 'illegal_activity'
	| 'spam_scams'
	| 'malware'
	| 'privacy'
	| 'impersonation'
	| 'self_harm'
	| 'other';

type FeedReportRadioOption<T> = RadioOption<T> & {name: string; desc?: string};

const REASONS_BY_CATEGORY: Record<FeedReportCategoryId, ReadonlyArray<FeedReportReasonId>> = {
	targeted_harm: ['harassment', 'hate', 'violence', 'self_harm'],
	safety_minors: ['child_safety', 'mature_content'],
	privacy_identity: ['privacy', 'impersonation'],
	deception: ['spam_scams', 'malware', 'harmful_misinformation'],
	illegal_other: ['illegal_activity', 'other'],
};

const REPORT_CATEGORY_BY_REASON: Record<FeedReportReasonId, ReportMessageRequest['category']> = {
	harassment: 'harassment',
	hate: 'hate_speech',
	violence: 'violent_content',
	mature_content: 'nsfw_violation',
	child_safety: 'child_safety',
	harmful_misinformation: 'other',
	illegal_activity: 'illegal_activity',
	spam_scams: 'spam',
	malware: 'malicious_links',
	privacy: 'doxxing',
	impersonation: 'impersonation',
	self_harm: 'self_harm',
	other: 'other',
};

const WHICH_AREA_DESCRIPTOR = msg({
	message: 'What kind of rule was broken?',
	comment: 'IAR modal: category-step title for the platform-report path. User picks a broad area before drilling in.',
});
const WHICH_RULE_DESCRIPTOR = msg({
	message: 'Which rule was broken?',
	comment: 'IAR modal: reason-step title for the platform-report path after a category has been picked.',
});
const CATEGORY_TARGETED_HARM_LABEL_DESCRIPTOR = msg({
	message: 'Threats, harassment, or harm',
	comment:
		'IAR modal: rule-category label grouping harassment, hate, violence, terrorism, raids, and self-harm content.',
});
const CATEGORY_TARGETED_HARM_DESC_DESCRIPTOR = msg({
	message: 'Bullying, threats, hate, violence, raids, or content that pushes self-harm.',
	comment: 'IAR modal: rule-category description for the targeted-harm group.',
});
const CATEGORY_SAFETY_MINORS_LABEL_DESCRIPTOR = msg({
	message: 'Child safety or mature content',
	comment: 'IAR modal: rule-category label grouping child-safety and mature-content reports.',
});
const CATEGORY_SAFETY_MINORS_DESC_DESCRIPTOR = msg({
	message: 'Minors at risk, mature content in the wrong place, or unwanted conduct.',
	comment: 'IAR modal: rule-category description for the child-safety / mature-content group.',
});
const CATEGORY_PRIVACY_IDENTITY_LABEL_DESCRIPTOR = msg({
	message: 'Privacy or impersonation',
	comment: 'IAR modal: rule-category label grouping privacy violations and impersonation.',
});
const CATEGORY_PRIVACY_IDENTITY_DESC_DESCRIPTOR = msg({
	message: 'Doxxing, stalking, pretending to be someone, or an inappropriate profile.',
	comment: 'IAR modal: rule-category description for the privacy / impersonation group.',
});
const CATEGORY_DECEPTION_LABEL_DESCRIPTOR = msg({
	message: 'Scams, malware, or misinformation',
	comment: 'IAR modal: rule-category label grouping spam/scams, malware, and harmful misinformation.',
});
const CATEGORY_DECEPTION_DESC_DESCRIPTOR = msg({
	message: 'Phishing, fraud, malicious links, or false claims likely to cause real-world harm.',
	comment: 'IAR modal: rule-category description for the scams / malware / misinformation group.',
});
const CATEGORY_ILLEGAL_OTHER_LABEL_DESCRIPTOR = msg({
	message: 'Illegal activity or something else',
	comment: 'IAR modal: rule-category label grouping illegal activity and the catch-all "Other" option.',
});
const CATEGORY_ILLEGAL_OTHER_DESC_DESCRIPTOR = msg({
	message: "Illegal sales, criminal facilitation, or a clear rule violation that doesn't fit above.",
	comment: 'IAR modal: rule-category description for the illegal / other group.',
});
const CHILD_SAFETY_MESSAGE_USER_DESCRIPTOR = msg({
	message: 'Child safety or exploitation of minors',
	comment: 'IAR modal: child-safety rule label (message and guild reports).',
});
const USE_CHILD_SAFETY_INSTEAD_DESCRIPTOR = msg({
	message: 'If a minor is involved, use "{childSafetyReasonName}" instead.',
	comment: 'IAR modal: inline routing hint shown under reasons that overlap with child safety.',
});
const REPORT_SENT_TITLE_DESCRIPTOR = msg({
	message: 'Report sent',
	comment: 'IAR modal: title on the success step shown after a platform report is submitted.',
});
const REPORT_SENT_BODY_DESCRIPTOR = msg({
	message: "Our safety team is reviewing it. We'll send you a DM and email once we've reached a verdict.",
	comment:
		'IAR modal: body copy on the success step shown after a platform report is submitted. Reassures the user about follow-up.',
});
const HARASSMENT_OR_THREATS_DESCRIPTOR = msg({
	message: 'Harassment or threats',
	comment: 'IAR modal: rule label.',
});
const HARASSMENT_MESSAGE_DESC_DESCRIPTOR = msg({
	message: 'Bullying, repeated unwanted contact, stalking, or targeted abuse.',
	comment: 'IAR modal: rule description for a message report.',
});
const HATE_SPEECH_DESCRIPTOR = msg({
	message: 'Hate speech',
	comment: 'IAR modal: rule label.',
});
const HATE_MESSAGE_DESC_DESCRIPTOR = msg({
	message: 'Slurs, dehumanizing language, or attacks on protected groups.',
	comment: 'IAR modal: rule description.',
});
const VIOLENCE_LABEL_DESCRIPTOR = msg({
	message: 'Violence or violent threats',
	comment: 'IAR modal: rule label.',
});
const VIOLENCE_DESC_DESCRIPTOR = msg({
	message: 'Credible threats, graphic violence, or glorification of violence.',
	comment: 'IAR modal: rule description.',
});
const MATURE_CONTENT_LABEL_DESCRIPTOR = msg({
	message: 'Mature content or harassment',
	comment: 'IAR modal: rule label.',
});
const MATURE_CONTENT_MESSAGE_DESC_DESCRIPTOR = msg({
	message: 'Unwanted conduct or mature content in the wrong place.',
	comment: 'IAR modal: rule description.',
});
const CHILD_SAFETY_MESSAGE_DESC_DESCRIPTOR = msg({
	message: 'Grooming or child-exploitation content.',
	comment: 'IAR modal: rule description.',
});
const HARMFUL_MISINFO_LABEL_DESCRIPTOR = msg({
	message: 'Harmful misinformation',
	comment: 'IAR modal: rule label.',
});
const HARMFUL_MISINFO_DESC_DESCRIPTOR = msg({
	message: 'False claims likely to cause real-world harm.',
	comment: 'IAR modal: rule description.',
});
const SPAM_LABEL_DESCRIPTOR = msg({
	message: 'Spam, scams, or phishing',
	comment: 'IAR modal: rule label.',
});
const SPAM_MESSAGE_DESC_DESCRIPTOR = msg({
	message: 'Mass spam, fraud, fake giveaways, or account abuse.',
	comment: 'IAR modal: rule description.',
});
const MALWARE_LABEL_DESCRIPTOR = msg({
	message: 'Malware or dangerous links',
	comment: 'IAR modal: rule label.',
});
const MALWARE_DESC_DESCRIPTOR = msg({
	message: 'Malware, credential theft, or harmful files.',
	comment: 'IAR modal: rule description.',
});
const PRIVACY_LABEL_DESCRIPTOR = msg({
	message: 'Privacy violation',
	comment: 'IAR modal: rule label.',
});
const PRIVACY_DESC_DESCRIPTOR = msg({
	message: 'Doxxing, exposed private info, or stalking.',
	comment: 'IAR modal: rule description.',
});
const IMPERSONATION_MESSAGE_LABEL_DESCRIPTOR = msg({
	message: 'Impersonation or deceptive media',
	comment: 'IAR modal: rule label.',
});
const IMPERSONATION_MESSAGE_DESC_DESCRIPTOR = msg({
	message: 'Pretending to be someone else, including deceptive AI-generated content.',
	comment: 'IAR modal: rule description.',
});
const ILLEGAL_LABEL_DESCRIPTOR = msg({
	message: 'Illegal activity',
	comment: 'IAR modal: rule label.',
});
const ILLEGAL_DESC_DESCRIPTOR = msg({
	message: 'Illegal sales, criminal facilitation, or unlawful activity.',
	comment: 'IAR modal: rule description.',
});
const SELF_HARM_LABEL_DESCRIPTOR = msg({
	message: 'Self-harm or suicide',
	comment: 'IAR modal: rule label.',
});
const SELF_HARM_MESSAGE_DESC_DESCRIPTOR = msg({
	message: 'Promotion or instructions encouraging self-harm or eating disorders.',
	comment: 'IAR modal: rule description.',
});
const OTHER_LABEL_DESCRIPTOR = msg({
	message: 'Another clear rule violation',
	comment: 'IAR modal: rule label.',
});
const OTHER_DESC_DESCRIPTOR = msg({
	message: "Use only if it clearly breaks {productName}'s rules and doesn't fit above.",
	comment: 'IAR modal: rule description.',
});
const CSAM_SAFETY_NOTE_DESCRIPTOR = msg({
	message: "If this involves CSAM or exploitation of a minor, send the report now and don't reshare the material.",
	comment: 'IAR modal: inline safety note shown for child-safety reports.',
});
const SELF_HARM_SAFETY_NOTE_DESCRIPTOR = msg({
	message: 'If someone may be in immediate danger, contact local emergency services if you can do so safely.',
	comment: 'IAR modal: inline safety note for self-harm reports.',
});
const VIOLENCE_SAFETY_NOTE_DESCRIPTOR = msg({
	message: 'If this is a credible imminent threat, contact local emergency services too.',
	comment: 'IAR modal: inline safety note for violence reports.',
});
const MODAL_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Report a rule violation, or find tools to manage contact and preferences.',
	comment: 'IAR modal: screen-reader description for the whole modal.',
});

export function getFeedReportCategory(reason: FeedReportReasonId): ReportMessageRequest['category'] {
	return REPORT_CATEGORY_BY_REASON[reason];
}

export function getFeedReportModalDescription(i18n: I18n): string {
	return i18n._(MODAL_DESCRIPTION_DESCRIPTOR);
}

export function getFeedReportCategoryTitle(i18n: I18n): string {
	return i18n._(WHICH_AREA_DESCRIPTOR);
}

export function getFeedReportReasonTitle(i18n: I18n): string {
	return i18n._(WHICH_RULE_DESCRIPTOR);
}

export function getFeedReportCategoryOptions(i18n: I18n): Array<FeedReportRadioOption<FeedReportCategoryId>> {
	return [
		{
			value: 'targeted_harm',
			name: i18n._(CATEGORY_TARGETED_HARM_LABEL_DESCRIPTOR),
			desc: i18n._(CATEGORY_TARGETED_HARM_DESC_DESCRIPTOR),
		},
		{
			value: 'safety_minors',
			name: i18n._(CATEGORY_SAFETY_MINORS_LABEL_DESCRIPTOR),
			desc: i18n._(CATEGORY_SAFETY_MINORS_DESC_DESCRIPTOR),
		},
		{
			value: 'privacy_identity',
			name: i18n._(CATEGORY_PRIVACY_IDENTITY_LABEL_DESCRIPTOR),
			desc: i18n._(CATEGORY_PRIVACY_IDENTITY_DESC_DESCRIPTOR),
		},
		{
			value: 'deception',
			name: i18n._(CATEGORY_DECEPTION_LABEL_DESCRIPTOR),
			desc: i18n._(CATEGORY_DECEPTION_DESC_DESCRIPTOR),
		},
		{
			value: 'illegal_other',
			name: i18n._(CATEGORY_ILLEGAL_OTHER_LABEL_DESCRIPTOR),
			desc: i18n._(CATEGORY_ILLEGAL_OTHER_DESC_DESCRIPTOR),
		},
	];
}

export function getFeedReportReasonOptions(
	i18n: I18n,
	category: FeedReportCategoryId | null,
): Array<FeedReportRadioOption<FeedReportReasonId>> {
	const all: Array<FeedReportRadioOption<FeedReportReasonId>> = [
		{
			value: 'harassment',
			name: i18n._(HARASSMENT_OR_THREATS_DESCRIPTOR),
			desc: i18n._(HARASSMENT_MESSAGE_DESC_DESCRIPTOR),
		},
		{value: 'hate', name: i18n._(HATE_SPEECH_DESCRIPTOR), desc: i18n._(HATE_MESSAGE_DESC_DESCRIPTOR)},
		{value: 'violence', name: i18n._(VIOLENCE_LABEL_DESCRIPTOR), desc: i18n._(VIOLENCE_DESC_DESCRIPTOR)},
		{
			value: 'mature_content',
			name: i18n._(MATURE_CONTENT_LABEL_DESCRIPTOR),
			desc: i18n._(MATURE_CONTENT_MESSAGE_DESC_DESCRIPTOR),
		},
		{
			value: 'child_safety',
			name: i18n._(CHILD_SAFETY_MESSAGE_USER_DESCRIPTOR),
			desc: i18n._(CHILD_SAFETY_MESSAGE_DESC_DESCRIPTOR),
		},
		{
			value: 'harmful_misinformation',
			name: i18n._(HARMFUL_MISINFO_LABEL_DESCRIPTOR),
			desc: i18n._(HARMFUL_MISINFO_DESC_DESCRIPTOR),
		},
		{value: 'spam_scams', name: i18n._(SPAM_LABEL_DESCRIPTOR), desc: i18n._(SPAM_MESSAGE_DESC_DESCRIPTOR)},
		{value: 'malware', name: i18n._(MALWARE_LABEL_DESCRIPTOR), desc: i18n._(MALWARE_DESC_DESCRIPTOR)},
		{value: 'privacy', name: i18n._(PRIVACY_LABEL_DESCRIPTOR), desc: i18n._(PRIVACY_DESC_DESCRIPTOR)},
		{
			value: 'impersonation',
			name: i18n._(IMPERSONATION_MESSAGE_LABEL_DESCRIPTOR),
			desc: i18n._(IMPERSONATION_MESSAGE_DESC_DESCRIPTOR),
		},
		{value: 'illegal_activity', name: i18n._(ILLEGAL_LABEL_DESCRIPTOR), desc: i18n._(ILLEGAL_DESC_DESCRIPTOR)},
		{value: 'self_harm', name: i18n._(SELF_HARM_LABEL_DESCRIPTOR), desc: i18n._(SELF_HARM_MESSAGE_DESC_DESCRIPTOR)},
		{
			value: 'other',
			name: i18n._(OTHER_LABEL_DESCRIPTOR),
			desc: i18n._(OTHER_DESC_DESCRIPTOR, {productName: PRODUCT_NAME}),
		},
	];
	if (category === null) return all;
	const allowed = REASONS_BY_CATEGORY[category];
	return all.filter((option) => allowed.includes(option.value));
}

export function getFeedReportChildSafetyNote(i18n: I18n, reason: FeedReportReasonId | null): string | null {
	switch (reason) {
		case 'illegal_activity':
		case 'mature_content':
		case 'other':
			return i18n._(USE_CHILD_SAFETY_INSTEAD_DESCRIPTOR, {
				childSafetyReasonName: i18n._(CHILD_SAFETY_MESSAGE_USER_DESCRIPTOR),
			});
		default:
			return null;
	}
}

export function getFeedReportSafetyNote(i18n: I18n, reason: FeedReportReasonId | null): string | null {
	switch (reason) {
		case 'child_safety':
			return i18n._(CSAM_SAFETY_NOTE_DESCRIPTOR);
		case 'self_harm':
			return i18n._(SELF_HARM_SAFETY_NOTE_DESCRIPTOR);
		case 'violence':
			return i18n._(VIOLENCE_SAFETY_NOTE_DESCRIPTOR);
		default:
			return null;
	}
}

export function getFeedReportSuccessCopy(i18n: I18n): {title: string; body: string} {
	return {
		title: i18n._(REPORT_SENT_TITLE_DESCRIPTOR),
		body: i18n._(REPORT_SENT_BODY_DESCRIPTOR),
	};
}
