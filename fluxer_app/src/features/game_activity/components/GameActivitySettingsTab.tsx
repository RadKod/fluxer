// SPDX-License-Identifier: AGPL-3.0-or-later
import {Routes} from '@app/app/Routes';
import {SettingsTabSection} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import {ExternalLink} from '@app/features/app/components/shared/ExternalLink';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import styles from '@app/features/game_activity/components/GameActivitySettingsTab.module.css';
import GameActivityLocalSettings from '@app/features/game_activity/state/GameActivityLocalSettings';
import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import DesktopGameActivityBridge from '@app/features/game_activity/utils/DesktopGameActivityBridge';
import {Button} from '@app/features/ui/button/Button';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import * as UserSettingsCommands from '@app/features/user/commands/UserSettingsCommands';
import UserSettings, {type GameActivityVisibility} from '@app/features/user/state/UserSettings';
import Users from '@app/features/user/state/Users';
import {getEffectiveProfilePrivacy} from '@app/features/user/utils/ProfilePrivacyUtils';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {getGameById} from '@fluxer/game_catalog/src/GameCatalog';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useId, useState} from 'react';

const TITLE = msg({message: 'Show my game activity', comment: 'Privacy settings heading for game sharing.'});
const OFF = msg({
	message: 'Off',
	comment: 'Game sharing option; nobody sees the game and game detection on this device stops.',
});
const FRIENDS = msg({message: 'Friends', comment: 'Game sharing option; only friends see the game.'});
const EVERYONE = msg({
	message: 'Everyone',
	comment:
		'Game sharing option; friends and members of servers the user shares see the game. Not the public internet. Default for eligible accounts.',
});
const AGE = msg({
	message: 'Available from age 15.',
	comment: 'Game sharing requires the account to be 15 or older with a known date of birth; unknown age is disabled.',
});
const ONLY_ME = msg({
	message: 'Your profile is set to Only me. Game activity is not shared, even when Friends or Everyone is selected.',
	comment: 'Explain that the Only me profile privacy level hides game activity from everyone, friends included.',
});
const DISCLOSURE = msg({
	message:
		'Sharing sends your game name or ID and start time to the people you choose. Everyone means your friends and members of servers you share; Friends means only your friends. People you’ve blocked can’t see it. Activity is temporary and expires when it is no longer renewed. The process list stays on this device. Off stops game detection on this device. You can remove local game rules at any time.',
	comment:
		'Game activity disclosure; describes recipients of each option, blocking, transient storage and local process data. Legal-effect text: approved before release.',
});
const RIGHTS = msg({
	message: 'Read the Privacy Policy for your rights and how to exercise them.',
	comment: 'Game activity link to the existing privacy policy.',
});
const UNSUPPORTED = msg({
	message: 'Game detection requires a supported desktop app. You can still see other people’s game activity.',
	comment: 'Web, legacy desktop and unsupported game detection explanation.',
});
const ERROR = msg({
	message: 'We could not confirm this change. Detection stays stopped. Retry to confirm your sharing setting.',
	comment: 'Game sharing failure including revocation acknowledgement timeout; never claim successful revocation.',
});
const LOCAL_ERROR = msg({
	message: 'This device could not complete the game action. Please retry.',
	comment: 'Failure of a local desktop game rule or detection operation.',
});
const RETRY = msg({message: 'Retry', comment: 'Retry a failed game sharing setting change.'});
const ADD = msg({message: 'Add game', comment: 'Explicit action to list local process candidates for a game rule.'});
const RULES = msg({message: 'Local game rules', comment: 'Explicit action to show locally stored game mappings.'});
const REMOVE = msg({message: 'Remove', comment: 'Delete a local game detection rule.'});
const NAME = msg({message: 'Game name', comment: 'Plain text name for a manually added local game.'});
const PROCESS = msg({
	message: 'Application',
	comment: 'Label for the local candidate selector; tokens stay on device.',
});
const SAVE = msg({message: 'Save game', comment: 'Save a selected local process token and manual game name.'});
const MORE = msg({
	message: 'More applications',
	comment: 'Explicit action to fetch the next page of local candidates.',
});
const EMPTY = msg({message: 'No local game rules.', comment: 'Empty local game rule list.'});
const GAME = msg({message: 'Game', comment: 'Fallback for unknown local catalog rule ID.'});
const SPOTIFY = msg({
	message: 'Show what I’m listening to on Spotify',
	comment: 'Switch in game activity settings; shares the song playing in the local Spotify app like a game.',
});
const SPOTIFY_DESCRIPTION = msg({
	message:
		'Shows the song playing in the Spotify app on this device to the same people who see your game activity. No Spotify account link is needed. macOS may ask once whether this app can control Spotify.',
	comment:
		'Description under the Spotify switch. The song is read from the desktop Spotify app, never from a Spotify account. The macOS sentence refers to the system Automation permission prompt.',
});

type Rule = {rule_id: string; game_id?: string; manual_name?: string};
type Candidate = {token: string; label: string};

export const GameActivitySettingsTab = observer(() => {
	const {i18n} = useLingui();
	const nameId = useId();
	const candidateId = useId();
	const account = Users.currentUser;
	const accountId = account?.id;
	const eligible = UserSettings.getGameActivityEligible() && !!account && !account.bot;
	const visibility = UserSettings.getGameActivityVisibility();
	const [busy, setBusy] = useState(false);
	const [failedVisibility, setFailedVisibility] = useState<GameActivityVisibility | null>(null);
	const [localError, setLocalError] = useState(false);
	const [rules, setRules] = useState<{accountId: string; values: Array<Rule>} | null>(null);
	const [candidates, setCandidates] = useState<{accountId: string; values: Array<Candidate>; cursor?: string} | null>(
		null,
	);
	const [token, setToken] = useState('');
	const [name, setName] = useState('');
	const updateVisibility = async (value: GameActivityVisibility) => {
		setBusy(true);
		setFailedVisibility(null);
		try {
			await UserSettingsCommands.updateGameActivityVisibility(value);
		} catch {
			setFailedVisibility(value);
		} finally {
			setBusy(false);
		}
	};
	const localAction = async (action: () => Promise<void>) => {
		setBusy(true);
		setLocalError(false);
		try {
			await action();
		} catch {
			setLocalError(true);
		} finally {
			setBusy(false);
		}
	};
	const listRules = async () => {
		const response = await DesktopGameActivityBridge.listRules();
		if (response.state !== 'ok') throw new Error('Local game rules unavailable');
		if (accountId && Users.currentUser?.id === accountId) setRules({accountId, values: response.rules});
	};
	const listCandidates = async (cursor?: string) => {
		const response = await DesktopGameActivityBridge.listCandidates(cursor);
		if (response.state !== 'ok') throw new Error('Local game candidates unavailable');
		if (accountId && Users.currentUser?.id === accountId) {
			setCandidates({accountId, values: response.candidates, cursor: response.next_cursor});
			setToken(response.candidates[0]?.token ?? '');
		}
	};
	const visibleRules = rules && rules.accountId === accountId ? rules.values : null;
	const visibleCandidates = candidates && candidates.accountId === accountId ? candidates : null;
	if (!GameActivityStore.enabled) return null;
	return (
		<SettingsTabSection title={i18n._(TITLE)}>
			<div className={styles.content}>
				<p className={styles.description}>{i18n._(DISCLOSURE)}</p>
				<ExternalLink href={RuntimeConfig.privacyUrl ?? Routes.privacy()}>{i18n._(RIGHTS)}</ExternalLink>
				{!eligible && <p className={styles.description}>{i18n._(AGE)}</p>}
				{getEffectiveProfilePrivacy() === ProfilePrivacyLevels.ONLY_ME && (
					<p className={styles.description}>{i18n._(ONLY_ME)}</p>
				)}
				<RadioGroup
					value={visibility}
					onChange={updateVisibility}
					aria-label={i18n._(TITLE)}
					options={[
						{value: 'off', name: i18n._(OFF), disabled: busy},
						{value: 'friends', name: i18n._(FRIENDS), disabled: busy || !eligible},
						{value: 'everyone', name: i18n._(EVERYONE), disabled: busy || !eligible},
					]}
				/>
				{failedVisibility && (
					<div role="alert">
						<p>{i18n._(ERROR)}</p>
						<Button variant="secondary" disabled={busy} onClick={() => void updateVisibility(failedVisibility)}>
							{i18n._(RETRY)}
						</Button>
					</div>
				)}
				{localError && <p role="alert">{i18n._(LOCAL_ERROR)}</p>}
				{DesktopGameActivityBridge.supported && accountId ? (
					<>
						{DesktopGameActivityBridge.spotifySupported && (
							<Switch
								label={i18n._(SPOTIFY)}
								description={i18n._(SPOTIFY_DESCRIPTION)}
								value={visibility !== 'off' && GameActivityLocalSettings.showSpotify}
								disabled={busy || visibility === 'off'}
								onChange={GameActivityLocalSettings.setShowSpotify}
							/>
						)}
						<div className={styles.actions}>
							<Button variant="secondary" disabled={busy} onClick={() => void localAction(() => listCandidates())}>
								{i18n._(ADD)}
							</Button>
							<Button variant="secondary" disabled={busy} onClick={() => void localAction(listRules)}>
								{i18n._(RULES)}
							</Button>
						</div>
						{visibleCandidates && (
							<div className={styles.content}>
								<label htmlFor={candidateId}>{i18n._(PROCESS)}</label>
								<select
									id={candidateId}
									className={styles.input}
									value={token}
									onChange={(event) => setToken(event.target.value)}
								>
									{visibleCandidates.values.map((candidate) => (
										<option key={candidate.token} value={candidate.token}>
											{candidate.label}
										</option>
									))}
								</select>
								{visibleCandidates.cursor && (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() => void localAction(() => listCandidates(visibleCandidates.cursor))}
									>
										{i18n._(MORE)}
									</Button>
								)}
								<label htmlFor={nameId}>{i18n._(NAME)}</label>
								<input
									id={nameId}
									className={styles.input}
									value={name}
									maxLength={64}
									onChange={(event) => setName(event.target.value)}
								/>
								<Button
									disabled={busy || !token || !name.trim()}
									onClick={() =>
										void localAction(async () => {
											const response = await DesktopGameActivityBridge.addRule({token, manual_name: name.trim()});
											if (response.state !== 'ok') throw new Error('Local game rule unavailable');
											setCandidates(null);
											setToken('');
											setName('');
											await listRules();
										})
									}
								>
									{i18n._(SAVE)}
								</Button>
							</div>
						)}
						{visibleRules &&
							(visibleRules.length === 0 ? (
								<p>{i18n._(EMPTY)}</p>
							) : (
								<ul className={styles.rules}>
									{visibleRules.map((rule) => (
										<li key={rule.rule_id} className={styles.rule}>
											<span>
												{rule.manual_name ??
													(rule.game_id ? getGameById(rule.game_id)?.name : undefined) ??
													i18n._(GAME)}
											</span>
											<Button
												variant="secondary"
												small
												disabled={busy}
												onClick={() =>
													void localAction(async () => {
														const response = await DesktopGameActivityBridge.removeRule(rule.rule_id);
														if (response.state !== 'ok') throw new Error('Local game rule removal unavailable');
														await listRules();
													})
												}
											>
												{i18n._(REMOVE)}
											</Button>
										</li>
									))}
								</ul>
							))}
					</>
				) : (
					<p className={styles.description}>{i18n._(UNSUPPORTED)}</p>
				)}
			</div>
		</SettingsTabSection>
	);
});
