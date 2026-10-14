// SPDX-License-Identifier: AGPL-3.0-or-later

export interface RegistrationEventRecord {
	userId: string;
	email: string | null;
	emailDomain: string | null;
	ip: string;
	locale: string | null;
	createdAt: Date;
}

export interface IRegistrationEventsRepository {
	recordEvent(event: RegistrationEventRecord): Promise<void>;
	listByIp(ip: string, sinceTime: Date, limit: number): Promise<ReadonlyArray<RegistrationEventRecord>>;
	listBySubnet(subnet: string, sinceTime: Date, limit: number): Promise<ReadonlyArray<RegistrationEventRecord>>;
	listByPlusAddressBase(
		plusAddressBase: string,
		sinceTime: Date,
		limit: number,
	): Promise<ReadonlyArray<RegistrationEventRecord>>;
	listByEmailDomain(
		emailDomain: string,
		sinceTime: Date,
		limit: number,
	): Promise<ReadonlyArray<RegistrationEventRecord>>;
}
