// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstanceHTTPTarget} from '@app/features/platform/transport/InstanceHTTP';
import {Input} from '@app/features/ui/components/form/FormInput';
import styles from '@app/features/user/components/modals/FluxerTagChangeModal.module.css';
import {
	type UsernameSelectionAvailability,
	useUsernameSelectionAvailability,
} from '@app/features/user/hooks/useUsernameSelectionAvailability';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {type Ref, useEffect} from 'react';

interface UsernamePickerProps {
	value: string;
	onChange: (value: string) => void;
	target?: InstanceHTTPTarget;
	onAvailabilityChange?: (availability: UsernameSelectionAvailability) => void;
	inputRef?: Ref<HTMLInputElement>;
	error?: string;
	id?: string;
	disabled?: boolean;
}

export function UsernamePicker({
	value,
	onChange,
	target,
	onAvailabilityChange,
	inputRef,
	error,
	id,
	disabled,
}: UsernamePickerProps) {
	const {i18n} = useLingui();
	const availability = useUsernameSelectionAvailability(value, {target});
	useEffect(() => {
		onAvailabilityChange?.(availability);
	}, [
		availability.state,
		availability.reason,
		availability.available_at,
		availability.taken,
		availability.username,
		onAvailabilityChange,
	]);
	const reason = availability.reason?.replace(/^USERNAME_/, '');
	const notice =
		availability.state === 'available'
			? i18n._(msg`This name is available ✓`)
			: availability.state === 'taken'
				? i18n._(msg`This name is taken.`)
				: availability.state === 'error'
					? i18n._(msg`Availability could not be checked. Please try again.`)
					: availability.state === 'checking'
						? i18n._(msg`Checking availability…`)
						: availability.state === 'unavailable'
							? reason === 'TIER_FOR_SALE' || reason === 'FOR_SALE' || reason === 'REQUIRES_ENTITLEMENT'
								? i18n._(msg`This name can be purchased.`)
								: i18n._(msg`This name cannot be used.`)
							: i18n._(msg`Use at least 4 characters. Letters, numbers, and _ are allowed.`);
	return (
		<div className={styles.fluxerTagContainer} data-flx="user.username-picker">
			<Input
				id={id}
				ref={inputRef}
				name="username"
				label={i18n._(msg`Username`)}
				value={value.replace(/^(\s*)@/, '$1')}
				onChange={(event) => onChange(event.target.value.replace(/^(\s*)@/, '$1'))}
				type="text"
				autoComplete="username"
				autoCapitalize="none"
				autoCorrect="off"
				spellCheck={false}
				leftElement={<span aria-hidden="true">@</span>}
				placeholder={i18n._(msg`yourname`)}
				required
				disabled={disabled}
				error={error}
			/>
			<div className={styles.validationBox} role="status" aria-live="polite">
				{notice}
				{availability.available_at && (
					<>
						{' '}
						<time dateTime={availability.available_at}>
							{new Date(availability.available_at).toLocaleString(i18n.locale)}
						</time>
					</>
				)}
			</div>
		</div>
	);
}
