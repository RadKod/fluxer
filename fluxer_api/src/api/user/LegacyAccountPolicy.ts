// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {
	type AccountPolicyContactCapability,
	createAccountPolicyContactContext,
	createAccountPolicyEvaluatorFromConfig,
	type IAccountPolicyEvaluator,
	isAccountPolicyConfigMissing,
} from '@app/api/risk/AccountPolicyEvaluator';

let cachedPolicy: unknown;
let cachedEvaluator: IAccountPolicyEvaluator | null = null;

export function accountPolicyContactHasCapability(
	email: string | null | undefined,
	capability: AccountPolicyContactCapability,
): boolean {
	const rawPolicy = Config.risk.accountPolicyDsl;
	if (cachedEvaluator === null || cachedPolicy !== rawPolicy) {
		if (
			isAccountPolicyConfigMissing(rawPolicy) &&
			Config.nodeEnv !== 'development' &&
			!Config.dev.testModeEnabled &&
			!Config.instance.selfHosted
		) {
			throw new Error('FLUXER_ACCOUNT_POLICY_DSL is required in hosted production');
		}
		const evaluator = createAccountPolicyEvaluatorFromConfig(rawPolicy);
		cachedPolicy = rawPolicy;
		cachedEvaluator = evaluator;
	}
	return cachedEvaluator.evaluateContact(createAccountPolicyContactContext(email)).hasCapability(capability);
}
