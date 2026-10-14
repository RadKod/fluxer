// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

export interface RegistrationEventByIpRow {
	ip: string;
	created_at: Date;
	user_id: UserID;
	email: string | null;
	email_domain: string | null;
	locale: string | null;
}

export const REGISTRATION_EVENT_BY_IP_COLUMNS = [
	'ip',
	'created_at',
	'user_id',
	'email',
	'email_domain',
	'locale',
] as const satisfies ReadonlyArray<keyof RegistrationEventByIpRow>;

export interface RegistrationEventBySubnetRow {
	subnet: string;
	created_at: Date;
	user_id: UserID;
	ip: string;
	email: string | null;
	email_domain: string | null;
	locale: string | null;
}

export const REGISTRATION_EVENT_BY_SUBNET_COLUMNS = [
	'subnet',
	'created_at',
	'user_id',
	'ip',
	'email',
	'email_domain',
	'locale',
] as const satisfies ReadonlyArray<keyof RegistrationEventBySubnetRow>;

export interface RegistrationEventByEmailDomainRow {
	email_domain: string;
	created_at: Date;
	user_id: UserID;
	ip: string;
	email: string | null;
	locale: string | null;
}

export const REGISTRATION_EVENT_BY_EMAIL_DOMAIN_COLUMNS = [
	'email_domain',
	'created_at',
	'user_id',
	'ip',
	'email',
	'locale',
] as const satisfies ReadonlyArray<keyof RegistrationEventByEmailDomainRow>;

export interface RegistrationEventByPlusAddressBaseRow {
	plus_address_base: string;
	created_at: Date;
	user_id: UserID;
	ip: string;
	email: string | null;
	locale: string | null;
}

export const REGISTRATION_EVENT_BY_PLUS_ADDRESS_BASE_COLUMNS = [
	'plus_address_base',
	'created_at',
	'user_id',
	'ip',
	'email',
	'locale',
] as const satisfies ReadonlyArray<keyof RegistrationEventByPlusAddressBaseRow>;
