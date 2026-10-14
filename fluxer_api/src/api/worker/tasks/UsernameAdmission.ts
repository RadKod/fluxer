// SPDX-License-Identifier: AGPL-3.0-or-later
import {performance} from 'node:perf_hooks';
import {Logger} from '@app/api/Logger';
import type {UsernamePolicySnapshot} from '@app/api/user/username/UsernamePolicyService';

export interface UsernameScriptExecutor {
	evalScript?: (command: string, script: string, keyCount: number, ...args: Array<string | number>) => Promise<unknown>;
	isClustered?: () => boolean;
}

// Micup: cumulative reservations fence revision changes and process restarts within the same server second.
export const USERNAME_ADMISSION_SCRIPT = `
local time = redis.call('TIME')
local second = tonumber(time[1])
local ttl = math.max(1, math.floor((1000000 - tonumber(time[2])) / 1000))
local revision = tonumber(ARGV[1])
local budget = tonumber(ARGV[2])
local latest = tonumber(redis.call('GET', 'uadm:revision') or '0')
if revision < latest then return {0, second, ttl} end
if revision > latest then redis.call('SET', 'uadm:revision', revision) end
local key = 'uadm:' .. ARGV[1] .. ':' .. time[1]
local totalKey = 'uadm:total:' .. time[1]
local total = tonumber(redis.call('GET', totalKey) or '0')
local previousBudget = tonumber(redis.call('GET', 'uadm:budget:' .. time[1]) or budget)
budget = math.min(budget, previousBudget)
redis.call('SET', 'uadm:budget:' .. time[1], budget, 'PX', ttl + 1000)
local remaining = math.max(0, budget - total)
local grant = math.min(10, remaining)
if grant > 0 then
  redis.call('INCRBY', key, grant)
  redis.call('PEXPIRE', key, ttl + 1000)
  redis.call('INCRBY', totalKey, grant)
  redis.call('PEXPIRE', totalKey, ttl + 1000)
end
return {grant, second, ttl}
`;

type AdmissionSnapshot = Pick<UsernamePolicySnapshot, 'policyRevision' | 'admission'>;
export class UsernameAdmission {
	private lease: {revision: number; budget: number; remaining: number; until: number; refill: boolean} | null = null;
	private pending: Promise<void> = Promise.resolve();
	constructor(
		private readonly kv: UsernameScriptExecutor,
		private readonly now: () => number = performance.now.bind(performance),
	) {}
	admit(snapshot: AdmissionSnapshot): Promise<boolean> {
		const result = this.pending.then(() => this.consume(snapshot));
		this.pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	private async consume({policyRevision: revision, admission}: AdmissionSnapshot): Promise<boolean> {
		const budget = admission.globalPerSecond;
		if (
			admission.paused ||
			!Number.isSafeInteger(revision) ||
			revision < 0 ||
			!Number.isSafeInteger(budget) ||
			budget <= 0
		) {
			this.lease = null;
			return false;
		}
		// Micup: TEMPORARY single Valkey node; add a same-slot server-time provider before enabling clustered admission.
		if (!this.kv.evalScript || this.kv.isClustered?.()) {
			this.lease = null;
			return false;
		}
		if (this.lease?.revision === revision && this.lease.budget === budget && this.now() < this.lease.until) {
			if (this.lease.remaining > 0) {
				this.lease.remaining--;
				return true;
			}
			if (!this.lease.refill) return false;
		}
		this.lease = null;
		const started = this.now();
		try {
			const reply = await this.kv.evalScript(
				'usernameAdmission',
				USERNAME_ADMISSION_SCRIPT,
				1,
				'uadm:revision',
				revision,
				budget,
			);
			if (!Array.isArray(reply) || reply.length !== 3) return false;
			const [grant, second, ttl] = reply;
			if (
				!Number.isSafeInteger(grant) ||
				grant < 0 ||
				grant > Math.min(10, budget) ||
				!Number.isSafeInteger(second) ||
				second < 0 ||
				!Number.isSafeInteger(ttl) ||
				ttl < 1 ||
				ttl > 1000
			)
				return false;
			// Micup: subtract the whole request RTT, so even a late response cannot extend a server-second lease.
			const until = started + ttl;
			if (this.now() >= until || this.now() < started) return false;
			this.lease = {revision, budget, remaining: Math.max(0, grant - 1), until, refill: grant === 10 && budget > 10};
			return grant > 0;
		} catch (error) {
			Logger.warn({error}, 'Username admission Valkey is unavailable');
			return false;
		}
	}
}
