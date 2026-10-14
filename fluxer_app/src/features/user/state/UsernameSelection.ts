// SPDX-License-Identifier: AGPL-3.0-or-later

import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {makeAutoObservable} from 'mobx';

export class UsernameSelectionState {
	accountKey: string | null = null;
	requiredAccountKey: string | null = null;
	requiredIdentityVersion: string | null = null;
	promptAccountKey: string | null = null;
	readingAccountKey: string | null = null;
	promptAttemptKey: string | null = null;
	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	bindAccount(accountKey: string | null): void {
		if (accountKey === this.accountKey) return;
		this.reset();
		this.accountKey = accountKey;
	}

	requireSelection(accountKey: string | null, identityVersion = '0'): void {
		if (accountKey === null || accountKey !== this.accountKey) return;
		this.requiredAccountKey = accountKey;
		this.requiredIdentityVersion = identityVersion;
		this.readingAccountKey = null;
		this.promptAccountKey = null;
	}

	observeIdentity(accountKey: string | null, state: string | undefined, identityVersion: string): void {
		if (
			accountKey === this.requiredAccountKey &&
			state === 'selected' &&
			this.requiredIdentityVersion !== null &&
			BigInt(identityVersion) > BigInt(this.requiredIdentityVersion)
		)
			this.finishSelection(accountKey!);
	}

	showPrompt(accountKey: string): void {
		if (accountKey === this.accountKey) this.promptAccountKey = accountKey;
	}

	dismissPrompt(accountKey: string): void {
		if (accountKey === this.accountKey) this.promptAccountKey = null;
	}

	readAllowed(accountKey: string): void {
		if (accountKey === this.accountKey) this.readingAccountKey = accountKey;
	}

	finishSelection(accountKey: string): void {
		if (accountKey !== this.accountKey) return;
		this.requiredAccountKey = null;
		this.requiredIdentityVersion = null;
		this.promptAccountKey = null;
		this.readingAccountKey = null;
	}

	reset(): void {
		this.accountKey = null;
		this.requiredAccountKey = null;
		this.requiredIdentityVersion = null;
		this.promptAccountKey = null;
		this.readingAccountKey = null;
		this.promptAttemptKey = null;
	}
}

const UsernameSelection = new UsernameSelectionState();
AccountScopedWork.registerCancellation(UsernameSelection.reset);
export default UsernameSelection;
