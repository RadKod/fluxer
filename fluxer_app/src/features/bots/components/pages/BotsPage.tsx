// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {openOAuthAuthorizeModalFromUrl} from '@app/features/auth/commands/OAuthAuthorizeModalCommands';
import {buildBotInviteUrl} from '@app/features/auth/utils/BotInviteUrl';
import {DeveloperDocumentationButton} from '@app/features/bots/components/DeveloperDocumentationButton';
import styles from '@app/features/bots/components/pages/BotsPage.module.css';
import {BOT_SYSTEM_DESCRIPTOR, CREATE_YOUR_OWN_BOT_DESCRIPTOR} from '@app/features/bots/utils/BotMessageDescriptors';
import {DMPageFrame} from '@app/features/channel/components/direct_message/DMPageFrame';
import {http} from '@app/features/platform/transport/RestTransport';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {UserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import {getUserAvatarURL} from '@app/features/user/utils/AvatarUtils';
import type {ApplicationPublicResponse} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {RobotIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const DESCRIPTION = msg({
	message: 'Official Micup bots you can add to your community.',
	comment: 'Description of the official applications listed in the bot catalog.',
});
const EMPTY = msg({message: 'No apps yet.', comment: 'Shown when no official applications are configured.'});
const LOADING = msg({message: 'Loading apps', comment: 'Accessible status while official application cards load.'});
const ERROR = msg({
	message: 'Some apps could not be loaded.',
	comment: 'Shown when one or more official application cards cannot be fetched. Failed cards are hidden.',
});
const ADD = msg({message: 'Add to community', comment: 'Opens the bot authorization flow with a community selector.'});

interface AppCard {
	applicationId: string;
	permissions: string;
	application: ApplicationPublicResponse;
}

export const BotsPage = observer(function BotsPage() {
	const {i18n} = useLingui();
	const officialApps = RuntimeConfig.officialApps;
	const [state, setState] = useState<{cards: Array<AppCard>; loading: boolean; error: boolean}>({
		cards: [],
		loading: officialApps.length > 0,
		error: false,
	});
	useEffect(() => {
		let cancelled = false;
		setState({cards: [], loading: officialApps.length > 0, error: false});
		void Promise.allSettled(
			officialApps.map(async ({application_id, invite_permissions}) => ({
				applicationId: application_id,
				permissions: invite_permissions,
				application: (await http.get<ApplicationPublicResponse>(Endpoints.OAUTH_PUBLIC_APPLICATION(application_id)))
					.body,
			})),
		).then((results) => {
			if (cancelled) return;
			setState({
				cards: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
				loading: false,
				error: results.some((result) => result.status === 'rejected'),
			});
		});
		return () => {
			cancelled = true;
		};
	}, [officialApps]);
	return (
		<DMPageFrame
			icon={RobotIcon}
			title={i18n._(BOT_SYSTEM_DESCRIPTOR)}
			bodyClassName={styles.body}
			data-flx="bots.bots-page.dm-page-frame"
		>
			<section
				className={styles.container}
				aria-labelledby="discovery-apps-heading"
				aria-busy={state.loading}
				data-flx="discovery.apps.container"
			>
				<h1 id="discovery-apps-heading" className={styles.heading} data-flx="discovery.apps.heading">
					{i18n._(BOT_SYSTEM_DESCRIPTOR)}
				</h1>
				<div className={styles.actions} data-flx="bots.bots-page.actions">
					<Button
						variant="primary"
						fitContent
						onClick={() =>
							ModalCommands.push(
								modal(() => (
									<UserSettingsModal initialTab="applications" data-flx="bots.bots-page.user-settings-modal" />
								)),
							)
						}
						data-flx="bots.bots-page.create-bot"
					>
						{i18n._(CREATE_YOUR_OWN_BOT_DESCRIPTOR)}
					</Button>
					<DeveloperDocumentationButton data-flx="bots.bots-page.documentation" />
				</div>
				<p className={styles.description} data-flx="discovery.apps.description">
					{i18n._(DESCRIPTION)}
				</p>
				{state.loading && (
					<div role="status" aria-label={i18n._(LOADING)} data-flx="discovery.apps.loading">
						<Spinner data-flx="discovery.apps.spinner" />
					</div>
				)}
				{state.error && (
					<p role="alert" data-flx="discovery.apps.error">
						{i18n._(ERROR)}
					</p>
				)}
				{officialApps.length === 0 && <p data-flx="discovery.apps.empty">{i18n._(EMPTY)}</p>}
				<ul className={styles.cards} data-flx="discovery.apps.cards">
					{state.cards.map(({applicationId, permissions, application}) => (
						<li key={applicationId} className={styles.card} data-flx="discovery.apps.card">
							{application.icon ? (
								<img
									src={getUserAvatarURL({id: applicationId, avatar: application.icon})}
									alt=""
									className={styles.icon}
									data-flx="discovery.apps.icon"
								/>
							) : (
								<RobotIcon className={styles.icon} aria-hidden data-flx="discovery.apps.default-icon" />
							)}
							<h2 className={styles.name} data-flx="discovery.apps.name">
								{application.name}
							</h2>
							<p className={styles.appDescription} data-flx="discovery.apps.app-description">
								{application.description}
							</p>
							<Button
								onClick={() => openOAuthAuthorizeModalFromUrl(buildBotInviteUrl({applicationId, permissions}))}
								data-flx="discovery.apps.add"
							>
								{i18n._(ADD)}
							</Button>
						</li>
					))}
				</ul>
			</section>
		</DMPageFrame>
	);
});
