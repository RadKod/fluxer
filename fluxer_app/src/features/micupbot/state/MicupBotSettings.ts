// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Commands from '@app/features/micupbot/commands/MicupBotCommands';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {
	MicupBotAutomodUpdateRequest,
	MicupBotLevelRewardsUpdateRequest,
	MicupBotReactionRolePanelCreateRequest,
	MicupBotSettingsUpdateRequest,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import type * as Response from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
import {i18n, type MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {makeAutoObservable, runInAction} from 'mobx';

const LOAD_ERROR = msg({
	message: 'Failed to load',
	comment: 'Community bot settings, leaderboard or warnings could not be loaded.',
});
export function errorMessage(
	error: unknown,
	fallback: MessageDescriptor = msg({
		message: 'Could not update community bot settings. Please try again.',
		comment: 'Fallback for a community bot request that failed without an API message.',
	}),
): string {
	if (
		error instanceof HttpError &&
		typeof error.body === 'object' &&
		error.body !== null &&
		'message' in error.body &&
		typeof error.body.message === 'string'
	)
		return error.body.message;
	return i18n._(fallback);
}

// Retain only the open community; all collections are bounded by the API schemas.
class MicupBotSettings {
	guildId: string | null = null;
	data: Response.MicupBotSettingsResponse | null = null;
	automod: Response.MicupBotAutomodResponse | null = null;
	panels: Response.MicupBotReactionRolePanelListResponse | null = null;
	rewards: Response.MicupBotLevelRewardsResponse | null = null;
	leaderboard: Response.MicupBotLeaderboardResponse | null = null;
	warnings: Response.MicupBotWarningListResponse | null = null;
	warningUserId: string | null = null;
	applicationName: string | null = null;
	loading = false;
	warningsLoading = false;
	saving = false;
	error: string | null = null;
	private revision = 0;
	private warningRevision = 0;
	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}
	close(): void {
		this.revision++;
		this.clearWarningSelection();
		this.guildId = null;
		this.data = null;
		this.automod = null;
		this.panels = null;
		this.rewards = null;
		this.leaderboard = null;
		this.applicationName = null;
		this.loading = false;
		this.saving = false;
		this.error = null;
	}
	async open(guildId: string): Promise<void> {
		this.close();
		this.guildId = guildId;
		this.loading = true;
		const revision = this.revision;
		try {
			const [data, automod, panels, rewards, leaderboard] = await Promise.all([
				Commands.fetchSettings(guildId),
				Commands.fetchAutomod(guildId),
				Commands.fetchPanels(guildId),
				Commands.fetchRewards(guildId),
				Commands.fetchLeaderboard(guildId),
			]);
			if (revision !== this.revision) return;
			runInAction(() => {
				this.data = data;
				this.automod = automod;
				this.panels = panels;
				this.rewards = rewards;
				this.leaderboard = leaderboard;
				this.loading = false;
			});
			if (data.bot) {
				try {
					const application = await Commands.fetchApplication(data.bot.application_id);
					runInAction(() => {
						if (revision === this.revision) this.applicationName = application.name;
					});
				} catch {
					// The public name is optional presentation data; the translated tab label remains visible.
				}
			}
		} catch (error) {
			runInAction(() => {
				if (revision === this.revision) this.error = errorMessage(error, LOAD_ERROR);
			});
		} finally {
			runInAction(() => {
				if (revision === this.revision) this.loading = false;
			});
		}
	}
	async updateSettings(draft: (typeof MicupBotSettingsUpdateRequest)['_input']): Promise<boolean> {
		const current = this.data?.settings;
		const changed = Object.fromEntries(
			Object.entries(draft).filter(
				([key, value]) =>
					key !== 'updated_at' &&
					value !== undefined &&
					current &&
					key in current &&
					JSON.stringify(value) !== JSON.stringify(current[key as keyof typeof current]),
			),
		);
		if (!Object.keys(changed).length) return Promise.resolve(true);
		if (!this.valid(MicupBotSettingsUpdateRequest.safeParse(changed).success)) return Promise.resolve(false);
		const revision = this.revision;
		const guildId = this.guildId;
		const saved = await this.mutate(async (guildId) => {
			const data = await Commands.updateSettings(guildId, changed);
			return () => {
				this.data = data;
			};
		});
		if (saved && guildId && changed.levels_enabled === true && revision === this.revision) {
			try {
				const leaderboard = await Commands.fetchLeaderboard(guildId);
				runInAction(() => {
					if (revision === this.revision) this.leaderboard = leaderboard;
				});
			} catch (error) {
				runInAction(() => {
					if (revision === this.revision) this.error = errorMessage(error, LOAD_ERROR);
				});
			}
		}
		return saved;
	}
	updateAutomod(data: (typeof MicupBotAutomodUpdateRequest)['_input']): Promise<boolean> {
		if (!this.valid(MicupBotAutomodUpdateRequest.safeParse(data).success)) return Promise.resolve(false);
		return this.mutate(async (guildId) => {
			const result = await Commands.updateAutomod(guildId, data);
			return () => {
				this.automod = result;
			};
		});
	}
	createPanel(data: (typeof MicupBotReactionRolePanelCreateRequest)['_input']): Promise<boolean> {
		if (!this.valid(MicupBotReactionRolePanelCreateRequest.safeParse(data).success)) return Promise.resolve(false);
		return this.mutate(async (guildId) => {
			const result = await Commands.createPanel(guildId, data);
			return () => {
				this.panels?.panels.push(result);
			};
		});
	}
	deletePanel(messageId: string): Promise<boolean> {
		return this.mutate(async (guildId) => {
			await Commands.deletePanel(guildId, messageId);
			return () => {
				if (this.panels) this.panels.panels = this.panels.panels.filter((p) => p.message_id !== messageId);
			};
		});
	}
	updateRewards(data: (typeof MicupBotLevelRewardsUpdateRequest)['_input']): Promise<boolean> {
		if (!this.valid(MicupBotLevelRewardsUpdateRequest.safeParse(data).success)) return Promise.resolve(false);
		return this.mutate(async (guildId) => {
			const result = await Commands.updateRewards(guildId, data);
			return () => {
				this.rewards = result;
			};
		});
	}
	clearWarningSelection(): void {
		this.warningRevision++;
		this.warningUserId = null;
		this.warnings = null;
		this.warningsLoading = false;
	}
	async loadWarnings(userId: string): Promise<void> {
		this.clearWarningSelection();
		if (!this.guildId) return;
		this.warningUserId = userId;
		this.warningsLoading = true;
		this.error = null;
		const revision = this.warningRevision;
		try {
			const data = await Commands.fetchWarnings(this.guildId, userId);
			runInAction(() => {
				if (revision === this.warningRevision) this.warnings = data;
			});
		} catch (error) {
			runInAction(() => {
				if (revision === this.warningRevision) this.error = errorMessage(error, LOAD_ERROR);
			});
		} finally {
			runInAction(() => {
				if (revision === this.warningRevision) this.warningsLoading = false;
			});
		}
	}
	removeWarning(warningId?: string): Promise<boolean> {
		const userId = this.warningUserId;
		const revision = this.warningRevision;
		if (!userId) return Promise.resolve(false);
		return this.mutate(async (guildId) => {
			if (warningId) await Commands.deleteWarning(guildId, userId, warningId);
			else await Commands.clearWarnings(guildId, userId);
			return () => {
				if (revision === this.warningRevision && this.warnings)
					this.warnings.warnings = this.warnings.warnings.filter((w) => warningId && w.id !== warningId);
			};
		});
	}
	private valid(success: boolean): boolean {
		if (!success)
			this.error = i18n._(
				msg({
					message: 'Check the selected channels, roles and field limits.',
					comment: 'Community bot form validation failed against the shared API schema.',
				}),
			);
		return success;
	}
	private async mutate(action: (guildId: string) => Promise<() => void>): Promise<boolean> {
		if (!this.guildId || !this.data?.feature_enabled || !this.data.bot || this.saving) return false;
		const revision = this.revision;
		this.saving = true;
		this.error = null;
		try {
			const apply = await action(this.guildId);
			if (revision !== this.revision) return false;
			runInAction(apply);
			return true;
		} catch (error) {
			runInAction(() => {
				if (revision === this.revision) this.error = errorMessage(error);
			});
			return false;
		} finally {
			runInAction(() => {
				if (revision === this.revision) this.saving = false;
			});
		}
	}
}

export default new MicupBotSettings();
