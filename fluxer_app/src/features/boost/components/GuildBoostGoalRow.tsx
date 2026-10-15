// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {openGuildBoostPanel} from '@app/features/boost/commands/GuildBoostPanelCommands';
import styles from '@app/features/boost/components/GuildBoostGoalRow.module.css';
import {GuildBoostLevelBadge} from '@app/features/boost/components/GuildBoostLevelBadge';
import {
	GUILD_BOOST_LEVELS,
	getGuildBoostLevelPerks,
	isGuildBoostAvailable,
} from '@app/features/boost/utils/GuildBoostLevels';
import {
	BOOST_DESCRIPTOR,
	GOAL_DESCRIPTOR,
	guildBoostPerkLabel,
	LEVEL_DESCRIPTOR,
	LEVEL_PROGRESS_DESCRIPTOR,
	LEVEL_TOTAL_DESCRIPTOR,
	TOP_LEVEL_DESCRIPTOR,
} from '@app/features/boost/utils/GuildBoostMessages';
import Guilds from '@app/features/guild/state/Guilds';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

export const GuildBoostGoalRow = observer(({guildId, onBanner = false}: {guildId: string; onBanner?: boolean}) => {
	const {i18n} = useLingui();
	const [animate, setAnimate] = useState(() => !Accessibility.useReducedMotion);
	const guild = Guilds.getGuild(guildId);
	if (!guild || !isGuildBoostAvailable(guild)) return null;
	const level = guild.premiumTier ?? 0;
	const next = GUILD_BOOST_LEVELS.find((candidate) => candidate.level === level + 1);
	const label = next ? i18n._(GOAL_DESCRIPTOR, {level: next.level}) : i18n._(LEVEL_DESCRIPTOR, {level});
	const progressLabel = i18n._(LEVEL_PROGRESS_DESCRIPTOR, {level});
	const nextPerks = next
		? (getGuildBoostLevelPerks(RuntimeConfig.limits).find((candidate) => candidate.level === next.level)?.perks ?? [])
		: [];
	const tooltip = next ? (
		<>
			<span>{i18n._(LEVEL_TOTAL_DESCRIPTOR, {count: next.boosts, level: next.level})}</span>
			<ul className={styles.tooltipPerks}>
				{nextPerks.map((perk) => (
					<li key={perk.type}>{guildBoostPerkLabel(i18n, perk)}</li>
				))}
			</ul>
		</>
	) : (
		i18n._(TOP_LEVEL_DESCRIPTOR)
	);
	return (
		<Tooltip text={() => tooltip} position="bottom">
			<button
				type="button"
				className={styles.row}
				data-on-banner={onBanner}
				aria-label={`${label}, ${progressLabel}`}
				aria-haspopup="dialog"
				onClick={() => openGuildBoostPanel(guildId)}
				data-flx="boost.goal-row.button"
			>
				<GuildBoostLevelBadge level={next?.level ?? level} size={16} />
				<span className={styles.goal}>{label}</span>
				<span className={styles.progressGroup}>
					<span
						className={styles.track}
						role="progressbar"
						aria-label={progressLabel}
						aria-valuemin={0}
						aria-valuenow={level}
						aria-valuemax={3}
					>
						{GUILD_BOOST_LEVELS.map((candidate) => (
							<span
								key={candidate.level}
								className={styles.fill}
								data-state={candidate.level <= level ? 'unlocked' : candidate.level === next?.level ? 'next' : 'locked'}
								data-animate={animate && !Accessibility.useReducedMotion}
								onAnimationEnd={() => setAnimate(false)}
								data-flx="boost.goal-row.segment"
							/>
						))}
					</span>
				</span>
				<span className={styles.cta} data-flx="boost.goal-row.cta">
					{i18n._(BOOST_DESCRIPTOR)}
				</span>
			</button>
		</Tooltip>
	);
});
