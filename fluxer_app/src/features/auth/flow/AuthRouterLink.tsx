// SPDX-License-Identifier: AGPL-3.0-or-later

import {Link as RouterLink, useNavigate} from '@app/features/platform/components/router/RouterReact';
import {Button} from '@app/features/ui/button/Button';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import type {ReactNode} from 'react';

interface AuthRouterLinkProps {
	ringOffset?: number;
	children?: ReactNode;
	className?: string;
	to: string;
	search?: Record<string, string>;
	asButton?: boolean;
}

export function AuthRouterLink({
	ringOffset = -2,
	children,
	className,
	to,
	search,
	asButton = false,
}: AuthRouterLinkProps) {
	const navigate = useNavigate();
	if (asButton) {
		return (
			<Button
				type="button"
				variant="secondary"
				fitContainer
				className={className}
				onClick={() => void navigate({to, search})}
				data-flx="auth.flow.auth-router-link.button.register"
			>
				{children}
			</Button>
		);
	}
	return (
		<FocusRing offset={ringOffset} data-flx="auth.flow.auth-router-link.focus-ring">
			<RouterLink
				tabIndex={0}
				className={className}
				to={to}
				search={search}
				data-flx="auth.flow.auth-router-link.router-link"
			>
				{children}
			</RouterLink>
		</FocusRing>
	);
}
