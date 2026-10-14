// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';

import {HttpError} from '@app/features/platform/types/EndpointError';
import * as GuildRosterCommands from '@app/features/roster/commands/GuildRosterCommands';
import type {
	GuildRosterEventCreateRequest,
	GuildRosterEventUpdateRequest,
} from '@fluxer/schema/src/domains/roster/GuildRosterRequestSchemas';
import type {
	GuildRosterEventListResponse,
	GuildRosterEventResponse,
} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';
import {i18n, type MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {makeAutoObservable, runInAction} from 'mobx';

const LOAD_FAILED = msg({
	message: 'Could not load event bot settings.',
	comment: 'Fallback error when loading event bot settings fails without a server message.',
});
const UPDATE_FAILED = msg({
	message: 'Could not update event bot settings. Please try again.',
	comment: 'Fallback error when saving event bot settings fails without a server message.',
});

function errorMessage(error: unknown, fallback: MessageDescriptor): string {
	if (
		error instanceof HttpError &&
		typeof error.body === 'object' &&
		error.body !== null &&
		'message' in error.body &&
		typeof error.body.message === 'string'
	) {
		return error.body.message;
	}
	return i18n._(fallback);
}

// Only the open community is retained; its event list is capped by the API at ten.
class GuildRosterEvents {
	guildId: string | null = null;
	data: GuildRosterEventListResponse | null = null;
	loading = false;
	saving = false;
	error: string | null = null;
	private revision = 0;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	close(): void {
		this.revision++;
		this.guildId = null;
		this.data = null;
		this.error = null;
		this.loading = false;
		this.saving = false;
	}

	async open(guildId: string): Promise<void> {
		if (AccountScopedWork.isSuspended) return;
		this.close();
		this.guildId = guildId;
		this.loading = true;
		const revision = this.revision;
		try {
			const data = await GuildRosterCommands.fetchGuildRosterEvents(guildId);
			runInAction(() => {
				if (this.revision === revision) this.data = data;
			});
		} catch (error) {
			runInAction(() => {
				if (this.revision === revision) this.error = errorMessage(error, LOAD_FAILED);
			});
		} finally {
			runInAction(() => {
				if (this.revision === revision) this.loading = false;
			});
		}
	}

	create(data: (typeof GuildRosterEventCreateRequest)['_input']): Promise<boolean> {
		return this.mutate(async (guildId) => {
			const event = await GuildRosterCommands.createGuildRosterEvent(guildId, data);
			return (events) => [...events, event];
		});
	}

	update(eventId: string, data: (typeof GuildRosterEventUpdateRequest)['_input']): Promise<boolean> {
		return this.mutate(async (guildId) => {
			const event = await GuildRosterCommands.updateGuildRosterEvent(guildId, eventId, data);
			return (events) => events.map((entry) => (entry.id === eventId ? event : entry));
		});
	}

	remove(eventId: string): Promise<boolean> {
		return this.mutate(async (guildId) => {
			await GuildRosterCommands.deleteGuildRosterEvent(guildId, eventId);
			return (events) => events.filter((entry) => entry.id !== eventId);
		});
	}

	private async mutate(
		action: (guildId: string) => Promise<(events: Array<GuildRosterEventResponse>) => Array<GuildRosterEventResponse>>,
	): Promise<boolean> {
		if (!this.guildId || !this.data?.feature_enabled || !this.data.bot || this.saving) return false;
		const revision = this.revision;
		this.saving = true;
		this.error = null;
		try {
			const apply = await action(this.guildId);
			if (this.revision !== revision) return false;
			runInAction(() => {
				if (this.data) this.data.events = apply(this.data.events);
			});
			return true;
		} catch (error) {
			runInAction(() => {
				if (this.revision === revision) this.error = errorMessage(error, UPDATE_FAILED);
			});
			return false;
		} finally {
			runInAction(() => {
				if (this.revision === revision) this.saving = false;
			});
		}
	}
}

const guildRosterEvents = new GuildRosterEvents();
ResettableStates.register(guildRosterEvents, guildRosterEvents.close);
AccountScopedWork.registerCancellation(() => guildRosterEvents.close());

export default guildRosterEvents;
