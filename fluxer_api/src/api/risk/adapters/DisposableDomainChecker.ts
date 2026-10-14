// SPDX-License-Identifier: AGPL-3.0-or-later

import type {IAdminRepository} from '@app/api/admin/IAdminRepository';

interface DisposableDomainCheckerContext {
	adminRepository: Pick<IAdminRepository, 'isEmailDomainSuspicious' | 'isEmailDomainDisposable'>;
}

export function createDisposableDomainChecker(ctx: DisposableDomainCheckerContext) {
	return async function checkDomainDisposable(args: {
		domain: string;
	}): Promise<{domain: string; isDisposable: boolean}> {
		const domain = args.domain.toLowerCase().trim();
		const [suspicious, disposable] = await Promise.all([
			ctx.adminRepository.isEmailDomainSuspicious(domain),
			ctx.adminRepository.isEmailDomainDisposable(domain),
		]);
		return {
			domain,
			isDisposable: suspicious || disposable,
		};
	};
}
