// SPDX-License-Identifier: AGPL-3.0-or-later

import {searchGuildMembers} from '@app/features/channel/components/guild_members_page/SearchApi';
import {M} from '@app/features/micupbot/components/MicupBotControls';
import styles from '@app/features/micupbot/components/MicupBotTab.module.css';
import Settings, {errorMessage} from '@app/features/micupbot/state/MicupBotSettings';
import {Button} from '@app/features/ui/button/Button';
import {Combobox} from '@app/features/ui/components/form/FormCombobox';
import {Input} from '@app/features/ui/components/form/FormInput';
import Users from '@app/features/user/state/Users';
import {getFormattedDateTime} from '@app/features/user/utils/DateFormatting';
import {getNickname} from '@app/features/user/utils/NicknameUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';

function moderatorName(guildId: string, userId: string): string {
	if (userId === Settings.data?.bot?.user_id && Settings.applicationName) return Settings.applicationName;
	const user = Users.getUser(userId);
	return user ? getNickname(user, guildId) : userId;
}

export const MicupBotWarnings = observer(({guildId}: {guildId: string}) => {
	const {i18n} = useLingui();
	const [query, setQuery] = useState('');
	const [options, setOptions] = useState<Array<{value: string; label: string}>>([]);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | 'all' | null>(null);
	const revision = useRef(0);
	useEffect(
		() => () => {
			revision.current++;
			Settings.clearWarningSelection();
		},
		[],
	);
	return (
		<section className={styles.fields} data-flx="micupbot.micup-bot-warnings.fields">
			<form
				className={styles.search}
				onSubmit={async (event) => {
					event.preventDefault();
					Settings.clearWarningSelection();
					setDeleting(null);
					setOptions([]);
					const current = ++revision.current;
					setSearching(true);
					setError(null);
					try {
						const result = await searchGuildMembers(guildId, {query: query.trim(), limit: 25, offset: 0});
						if (current === revision.current)
							setOptions(
								result.members.map((member) => ({
									value: member.user_id,
									label: member.nickname || member.global_name || member.username,
								})),
							);
					} catch (failure) {
						if (current === revision.current)
							setError(
								errorMessage(
									failure,
									msg({
										message: 'An error occurred while searching.',
										comment: 'Fallback when searching community members for bot warnings fails.',
									}),
								),
							);
					} finally {
						if (current === revision.current) setSearching(false);
					}
				}}
				data-flx="micupbot.micup-bot-warnings.row.prevent-default"
			>
				<Input
					label={i18n._(
						msg({message: 'Search members', comment: 'Search community members before viewing their bot warnings.'}),
					)}
					value={query}
					maxLength={100}
					onChange={(event) => setQuery(event.target.value)}
					data-flx="micupbot.micup-bot-warnings.input.set-query"
				/>
				<Button type="submit" submitting={searching} data-flx="micupbot.micup-bot-warnings.button.submit">
					{i18n._(msg({message: 'Search', comment: 'Run a bounded community member search for warning management.'}))}
				</Button>
			</form>
			{error && (
				<p role="alert" data-flx="micupbot.micup-bot-warnings.alert">
					{error}
				</p>
			)}
			<Combobox
				label={i18n._(
					msg({message: 'Member', comment: 'Select the community member whose bot warnings should be shown.'}),
				)}
				value={Settings.warningUserId ?? ''}
				options={[{value: '', label: i18n._(M.none)}, ...options]}
				onChange={(userId) => {
					setDeleting(null);
					if (userId) void Settings.loadWarnings(userId);
					else Settings.clearWarningSelection();
				}}
				data-flx="micupbot.micup-bot-warnings.combobox.set-deleting"
			/>
			{Settings.warningsLoading ? (
				<p role="status" data-flx="micupbot.micup-bot-warnings.status">
					{i18n._(M.loading)}
				</p>
			) : (
				Settings.warnings && (
					<>
						{Settings.warnings.warnings.length === 0 && (
							<p data-flx="micupbot.micup-bot-warnings.p">
								{i18n._(msg({message: 'No warnings.', comment: 'The selected community member has no bot warnings.'}))}
							</p>
						)}
						<ul className={styles.list} data-flx="micupbot.micup-bot-warnings.list">
							{Settings.warnings.warnings.map((warning) => (
								<li key={warning.id} className={styles.card} data-flx="micupbot.micup-bot-warnings.card">
									<p data-flx="micupbot.micup-bot-warnings.p--2">{warning.reason}</p>
									<p data-flx="micupbot.micup-bot-warnings.p--3">
										{i18n._(
											msg({
												message: 'Moderator: {moderator}',
												comment: 'Moderator name recorded with a community bot warning, or the user ID when unknown.',
											}),
											{moderator: moderatorName(guildId, warning.moderator_id)},
										)}
										<span aria-hidden="true" data-flx="micupbot.micup-bot-warnings.separator">
											{' '}
											·{' '}
										</span>
										<time dateTime={warning.created_at} data-flx="micupbot.micup-bot-warnings.time">
											{getFormattedDateTime(warning.created_at)}
										</time>
									</p>
									<Button
										variant="secondary"
										disabled={Settings.saving}
										onClick={() => setDeleting(warning.id)}
										data-flx="micupbot.micup-bot-warnings.button.set-deleting"
									>
										{i18n._(M.remove)}
									</Button>
								</li>
							))}
						</ul>
						<Button
							variant="danger"
							disabled={Settings.saving || !Settings.warnings.warnings.length}
							onClick={() => setDeleting('all')}
							data-flx="micupbot.micup-bot-warnings.button.set-deleting--2"
						>
							{i18n._(
								msg({
									message: 'Clear all warnings',
									comment: 'Start confirmation to delete all warnings for the selected member.',
								}),
							)}
						</Button>
						{deleting && (
							<div className={styles.card} data-flx="micupbot.micup-bot-warnings.card--2">
								<p role="alert" data-flx="micupbot.micup-bot-warnings.alert--2">
									{i18n._(
										deleting === 'all'
											? msg({
													message: 'Delete all warnings for this member?',
													comment: 'Confirmation for permanently clearing one member’s community bot warnings.',
												})
											: msg({
													message: 'Delete this warning?',
													comment: 'Confirmation for deleting a single community bot warning.',
												}),
									)}
								</p>
								<div className={styles.row} data-flx="micupbot.micup-bot-warnings.row">
									<Button
										variant="danger"
										disabled={Settings.saving}
										onClick={async () => {
											if (await Settings.removeWarning(deleting === 'all' ? undefined : deleting)) setDeleting(null);
										}}
										data-flx="micupbot.micup-bot-warnings.button"
									>
										{i18n._(M.remove)}
									</Button>
									<Button
										variant="secondary"
										onClick={() => setDeleting(null)}
										data-flx="micupbot.micup-bot-warnings.button.set-deleting--3"
									>
										{i18n._(M.cancel)}
									</Button>
								</div>
							</div>
						)}
					</>
				)
			)}
		</section>
	);
});
