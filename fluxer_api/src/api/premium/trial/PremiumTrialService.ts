// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHmac, randomUUID} from 'node:crypto';
import type {AdminRepository} from '@app/api/admin/AdminRepository';
import {Config} from '@app/api/Config';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import type {User} from '@app/api/models/User';
import type {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {type PremiumLedgerService, TRIAL_GRANT_KEY} from '@app/api/premium/ledger/PremiumLedgerService';
import type {PremiumTrialRepository} from '@app/api/premium/trial/PremiumTrialRepository';
import {createDisposableDomainChecker} from '@app/api/risk/adapters/DisposableDomainChecker';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {TrialAlreadyUsedError} from '@fluxer/errors/src/domains/payment/TrialAlreadyUsedError';
import {TrialNotEligibleError} from '@fluxer/errors/src/domains/payment/TrialNotEligibleError';
import {TrialUnavailableError} from '@fluxer/errors/src/domains/payment/TrialUnavailableError';
import type {PremiumTrialEligibilityResponse} from '@fluxer/schema/src/domains/premium/PremiumTrialSchemas';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

type IneligibleReason = 'not_eligible' | 'already_used';

interface PremiumTrialServiceDeps {
	repository: PremiumTrialRepository;
	ledgerService: Pick<PremiumLedgerService, 'grant'>;
	ledgerRepository: Pick<PremiumLedgerRepository, 'find'>;
	instanceConfigRepository: Pick<InstanceConfigRepository, 'getInstancePolicyConfig'>;
	adminRepository: Pick<AdminRepository, 'isEmailDomainSuspicious' | 'isEmailDomainDisposable'>;
	kvClient: IKVProvider;
}

const CLAIM_LOCK_TTL_SECONDS = 30;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function normalizeTrialEmail(email: string): string {
	const lower = email.trim().toLowerCase();
	const at = lower.lastIndexOf('@');
	let local = lower.slice(0, at);
	let domain = lower.slice(at + 1);
	const plus = local.indexOf('+');
	if (plus > 0) local = local.slice(0, plus);
	if (GMAIL_DOMAINS.has(domain)) {
		local = local.replaceAll('.', '');
		domain = 'gmail.com';
	}
	return `${local}@${domain}`;
}

// Keyed so a leaked table cannot be reversed with a list of addresses. Never rotate
// FLUXER_API_PREMIUM_TRIAL_EMAIL_HASH_KEY: every stored hash would stop matching and each address could claim again.
// If a rotation is ever forced, keep the old key and look up both hashes before claiming.
function hashTrialEmail(email: string): string {
	return createHmac('sha256', Config.premiumTrial.emailHashKey).update(normalizeTrialEmail(email)).digest('base64url');
}

export class PremiumTrialService {
	private readonly checkDomainDisposable: ReturnType<typeof createDisposableDomainChecker>;

	constructor(private readonly deps: PremiumTrialServiceDeps) {
		this.checkDomainDisposable = createDisposableDomainChecker({adminRepository: deps.adminRepository});
	}

	async getAvailableDays(): Promise<number> {
		if (!Config.instance.selfHosted || !Config.premiumTrial.emailHashKey) return 0;
		const policy = await this.deps.instanceConfigRepository.getInstancePolicyConfig();
		if (policy.premium_mode !== 'mirror') return 0;
		return policy.premium_trial_days;
	}

	async getEligibility(user: User): Promise<PremiumTrialEligibilityResponse> {
		const days = await this.getAvailableDays();
		if (days <= 0) return {eligible: false, days, reason: 'unavailable'};
		let reason = await this.findIneligibleReason(user);
		if (reason === null) {
			const claimed = await this.deps.repository.find(hashTrialEmail(user.email!));
			if (claimed && claimed.user_id !== user.id) reason = 'already_used';
		}
		return {eligible: reason === null, days, reason};
	}

	async claim(user: User, spendNetworkQuota: () => Promise<void>): Promise<void> {
		const days = await this.getAvailableDays();
		if (days <= 0) throw new TrialUnavailableError();
		const lockKey = `premium:trial:claim:${user.id}`;
		const lockToken = randomUUID();
		if (!(await this.deps.kvClient.acquireLock(lockKey, lockToken, CLAIM_LOCK_TTL_SECONDS))) {
			throw new TrialAlreadyUsedError();
		}
		try {
			const reason = await this.findIneligibleReason(user);
			if (reason === 'already_used') throw new TrialAlreadyUsedError();
			if (reason === 'not_eligible') throw new TrialNotEligibleError();
			const emailHash = hashTrialEmail(user.email!);
			if (!(await this.deps.repository.claim({email_hash: emailHash, user_id: user.id, created_at: new Date()}))) {
				// A row left by this user's own crashed claim is theirs to finish.
				const claimed = await this.deps.repository.find(emailHash);
				if (claimed?.user_id !== user.id) throw new TrialAlreadyUsedError();
			}
			// Spent only by a claim that passed every check above; a refused one keeps its address row for its retry.
			await spendNetworkQuota();
			const {newlyApplied} = await this.deps.ledgerService.grant({
				userId: user.id,
				grantKey: TRIAL_GRANT_KEY,
				duration: {unit: 'days', quantity: days},
				source: 'trial',
			});
			if (!newlyApplied) throw new TrialAlreadyUsedError();
		} finally {
			await this.deps.kvClient.releaseLock(lockKey, lockToken);
		}
	}

	private async findIneligibleReason(user: User): Promise<IneligibleReason | null> {
		if (user.isBot || user.isSystem || !user.email || !user.emailVerified || user.hasEverPurchased) {
			return 'not_eligible';
		}
		if ((await this.deps.ledgerRepository.find(user.id))?.trial_used_at) return 'already_used';
		if (checkIsPremium(user)) return 'not_eligible';
		const domain = user.email.slice(user.email.lastIndexOf('@') + 1);
		if ((await this.checkDomainDisposable({domain})).isDisposable) return 'not_eligible';
		return null;
	}
}
