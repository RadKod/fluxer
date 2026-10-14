// SPDX-License-Identifier: AGPL-3.0-or-later

import type {APICachePurgeConfig} from '@app/api/config/APIConfig';
import type {CachePurgeAdapter, CachePurgeOutcome} from '@app/api/infrastructure/CachePurgeAdapter';
import {CachePurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {Logger} from '@app/api/Logger';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import * as FetchUtils from '@app/api/utils/FetchUtils';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const TRAILING_SLASHES_PATTERN = /\/+$/u;
// Bunny limits purges per account, so every worker replica draws on this one bucket.
const BUDGET_KEY = 'cache_purge:bunny_budget';
// Mirrors the origin's CDN-Tag mapping: an attachment is tagged by its ids, so all spellings of its name share a tag.
const ATTACHMENT_TAG_PATTERN = /^((?:.+\/)?attachments\/\d+\/\d+)\/[^/]+$/u;

// Queued prefixes carry a decoded path, while a client requests a non-ASCII file name percent-encoded.
// Bunny's purge docs do not say which spelling its cache key uses, so such a prefix is purged under both.
function purgeSpellings(prefix: string): Array<string> {
	const pathStart = prefix.indexOf('/');
	if (pathStart === -1) {
		return [prefix];
	}
	const encodedPath = prefix.slice(pathStart).split('/').map(encodeURIComponent).join('/');
	const encoded = `${prefix.slice(0, pathStart)}${encodedPath}`;
	return encoded === prefix ? [prefix] : [encoded, prefix];
}

// The origin tags each response with its decoded path, minus the extension and, for attachments, the file name.
function purgeTag(prefix: string): string {
	const path = prefix.slice(prefix.indexOf('/') + 1);
	return ATTACHMENT_TAG_PATTERN.exec(path)?.[1] ?? path;
}

interface PurgeGroup {
	prefixes: Array<string>;
	targets: Array<string>;
}

interface BudgetFit {
	groups: Array<PurgeGroup>;
	deferred: Array<string>;
	cost: number;
}

// In queue order, so priority prefixes get the budget first; a group whose spellings do not all fit waits whole.
function fitBudget(groups: ReadonlyArray<PurgeGroup>, budget: number): BudgetFit {
	const fit: BudgetFit = {groups: [], deferred: [], cost: 0};
	for (const group of groups) {
		if (fit.cost + group.targets.length <= budget) {
			fit.cost += group.targets.length;
			fit.groups.push(group);
		} else {
			fit.deferred.push(...group.prefixes);
		}
	}
	return fit;
}

export function createBunnyCachePurgeAdapter(config: APICachePurgeConfig): CachePurgeAdapter {
	const {apiBase, apiKey, timeoutMs, concurrency, mode, pullZoneId, ratePerMinute, burst} = config.bunny;
	const base = apiBase.replace(TRAILING_SLASHES_PATTERN, '');
	const refillIntervalMs = Math.ceil(60_000 / ratePerMinute);

	async function send(url: string, body: string | null): Promise<CachePurgeOutcome> {
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: body === null ? {AccessKey: apiKey} : {AccessKey: apiKey, 'Content-Type': 'application/json'},
				body,
				redirect: 'manual',
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			return {kind: 'failed', status: null, error};
		}
		FetchUtils.discardResponseBody(response.body, response.status);
		if (response.ok) {
			return {kind: 'purged'};
		}
		if (response.status === 400) {
			return {kind: 'rejected', status: response.status};
		}
		return {kind: 'failed', status: response.status, error: null};
	}

	function purgeTarget(target: string): Promise<CachePurgeOutcome> {
		if (mode === 'tag') {
			return send(`${base}/pullzone/${pullZoneId}/purgeCache`, JSON.stringify({CacheTag: target}));
		}
		return send(`${base}/purge?url=${encodeURIComponent(`https://${target}*`)}&async=true`, null);
	}

	function groupPrefixes(prefixes: ReadonlyArray<string>): Array<PurgeGroup> {
		if (mode === 'prefix') {
			return prefixes.map((prefix) => ({prefixes: [prefix], targets: purgeSpellings(prefix)}));
		}
		return [...Map.groupBy(prefixes, purgeTag)].map(([tag, grouped]) => ({prefixes: grouped, targets: [tag]}));
	}

	// Reads the shared budget without taking from it, refilled the way the take script refills it, so a run takes only
	// the tokens whole groups can use. The take stays atomic: a stale read only plans more or fewer groups.
	async function readBudget(kvClient: IKVProvider): Promise<number> {
		const stored = await kvClient.get(BUDGET_KEY);
		if (stored === null) {
			return burst;
		}
		const {tokens, lastRefill} = JSON.parse(stored) as {tokens: number; lastRefill: number};
		return Math.min(burst, tokens + Math.max(0, Math.floor((Date.now() - lastRefill) / refillIntervalMs)));
	}

	return {
		async purge(prefixes: ReadonlyArray<string>): Promise<CachePurgeOutcome> {
			const {kvClient} = getWorkerDependencies();
			const planned = fitBudget(groupPrefixes(prefixes), await readBudget(kvClient));
			const taken =
				planned.cost === 0 ? 0 : await kvClient.tryConsumeTokens(BUDGET_KEY, planned.cost, burst, 1, refillIntervalMs);
			// A replica that spent the budget between the read and the take leaves less; what no longer fits waits too.
			// TEMPORARY: that race can still strand one token of a two-spelling prefix; a KV refund script closes it.
			const sent = fitBudget(planned.groups, taken);
			const targets = sent.groups.flatMap((group) => group.targets);
			const deferred = [...sent.deferred, ...planned.deferred];
			if (deferred.length > 0) {
				// Only the unsent prefixes go back: failing the batch would resend purges Bunny already counted,
				// and a backlog larger than Bunny's burst would then never drain.
				await new CachePurgeQueue(kvClient).requeue(deferred);
				Logger.warn(
					{mode, sent: targets.length, deferred: deferred.length},
					'Bunny purge budget is spent, deferred cache prefixes to a later run',
				);
			}
			const outcomes = await mapWithConcurrency(targets, concurrency, purgeTarget);
			// A failure outranks a rejection: setting the batch aside would drop prefixes Bunny never purged,
			// while requeueing only repeats purges that are harmless to run twice.
			return (
				outcomes.find((outcome) => outcome.kind === 'failed') ??
				outcomes.find((outcome) => outcome.kind === 'rejected') ?? {kind: 'purged'}
			);
		},
	};
}
