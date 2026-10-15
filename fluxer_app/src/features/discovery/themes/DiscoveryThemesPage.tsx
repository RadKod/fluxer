// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/discovery/themes/DiscoveryThemesPage.module.css';
import {
	isThemeCatalogId,
	THEME_CATALOG,
	type ThemeCatalogEntry,
	type ThemeCatalogSwatches,
} from '@app/features/discovery/themes/ThemeCatalog';
import ThemeLibrary from '@app/features/theme/state/ThemeLibrary';
import {Button} from '@app/features/ui/button/Button';
import {Scroller} from '@app/features/ui/components/Scroller';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useState} from 'react';

const PAGE_TITLE_DESCRIPTOR = msg({
	message: 'Themes',
	comment: 'Heading of the Discovery themes page.',
});

const PREVIEW_DESCRIPTOR = msg({
	message: 'Preview of the {themeName} theme',
	comment: 'Accessible label of the colour preview on a Discovery theme card. {themeName} is the theme name.',
});

// Installs the catalog theme into the user's library (refreshing its CSS when the shipped file changed) and enables
// it; other catalog palettes are switched off so two full palettes never stack. The user's own themes stay as they are.
export async function applyCatalogTheme(entry: ThemeCatalogEntry): Promise<void> {
	await ThemeLibrary.init();
	const existing = ThemeLibrary.themes.find((theme) => theme.id === entry.id);
	if (!existing || existing.css !== entry.css) {
		const theme = ThemeLibrary.createThemeFromCss(entry.css, `${entry.slug}.css`, 'import', {
			id: entry.id,
			createdAt: existing?.createdAt,
		});
		await ThemeLibrary.saveTheme(theme);
	}
	for (const enabledId of ThemeLibrary.enabledThemeIds) {
		if (enabledId !== entry.id && isThemeCatalogId(enabledId)) {
			await ThemeLibrary.setThemeEnabled(enabledId, false);
		}
	}
	await ThemeLibrary.setThemeEnabled(entry.id, true);
}

export async function removeCatalogTheme(entry: ThemeCatalogEntry): Promise<void> {
	await ThemeLibrary.init();
	if (ThemeLibrary.themes.some((theme) => theme.id === entry.id)) {
		await ThemeLibrary.deleteTheme(entry.id);
	}
}

function ThemePreview({swatches, label}: {swatches: ThemeCatalogSwatches; label: string}) {
	return (
		<div
			className={styles.preview}
			role="img"
			aria-label={label}
			style={{background: swatches.chat}}
			data-flx="discovery.themes.discovery-themes-page.preview"
		>
			<div className={styles.previewRail} style={{background: swatches.rail}}>
				<span className={styles.previewRailDot} style={{background: swatches.brand, opacity: 1}} />
				<span className={styles.previewRailDot} style={{background: swatches.text}} />
				<span className={styles.previewRailDot} style={{background: swatches.text}} />
			</div>
			<div className={styles.previewPanel} style={{background: swatches.panel}}>
				<span className={styles.previewLine} style={{background: swatches.text, width: '80%'}} />
				<span className={styles.previewLine} style={{background: swatches.text, width: '55%'}} />
				<span className={styles.previewLine} style={{background: swatches.brand, opacity: 0.9, width: '70%'}} />
				<span className={styles.previewLine} style={{background: swatches.text, width: '60%'}} />
			</div>
			<div className={styles.previewChat}>
				{[0, 1].map((index) => (
					<div key={index} className={styles.previewMessage}>
						<span
							className={styles.previewAvatar}
							style={{background: index === 0 ? swatches.brand : swatches.panel}}
						/>
						<div className={styles.previewMessageLines}>
							<span className={styles.previewName} style={{background: index === 0 ? swatches.brand : swatches.text}} />
							<span className={styles.previewText} style={{background: swatches.text}} />
							<span className={styles.previewText} style={{background: swatches.text}} />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

const ThemeCard = observer(function ThemeCard({entry}: {entry: ThemeCatalogEntry}) {
	const {i18n} = useLingui();
	const [busy, setBusy] = useState(false);
	const installed = ThemeLibrary.themes.some((theme) => theme.id === entry.id);
	const active = installed && ThemeLibrary.enabledThemeIds.includes(entry.id);
	const run = useCallback(async (work: () => Promise<void>) => {
		setBusy(true);
		try {
			await work();
		} finally {
			setBusy(false);
		}
	}, []);
	return (
		<div
			className={clsx(styles.card, active && styles.cardActive)}
			data-flx="discovery.themes.discovery-themes-page.card"
		>
			<ThemePreview swatches={entry.swatches} label={i18n._(PREVIEW_DESCRIPTOR, {themeName: entry.name})} />
			<div className={styles.body}>
				<div className={styles.titleRow}>
					<span className={styles.name}>{entry.name}</span>
					{active && (
						<span className={styles.activeBadge} data-flx="discovery.themes.discovery-themes-page.active-badge">
							<Trans>Active</Trans>
						</span>
					)}
				</div>
				<span className={styles.description}>{entry.description}</span>
				{entry.tags.length > 0 && (
					<div className={styles.tags}>
						{entry.tags.map((tag) => (
							<span key={tag} className={styles.tag}>
								{tag}
							</span>
						))}
					</div>
				)}
				<div className={styles.actions}>
					{active ? (
						<Button
							variant="secondary"
							fitContent
							submitting={busy}
							onClick={() => void run(() => ThemeLibrary.setThemeEnabled(entry.id, false))}
							data-flx="discovery.themes.discovery-themes-page.button.disable"
						>
							<Trans>Turn off</Trans>
						</Button>
					) : (
						<Button
							fitContent
							submitting={busy}
							onClick={() => void run(() => applyCatalogTheme(entry))}
							data-flx="discovery.themes.discovery-themes-page.button.apply"
						>
							<Trans>Apply</Trans>
						</Button>
					)}
					{installed && !active && (
						<Button
							variant="ghost"
							fitContent
							submitting={busy}
							onClick={() => void run(() => removeCatalogTheme(entry))}
							data-flx="discovery.themes.discovery-themes-page.button.remove"
						>
							<Trans>Remove from library</Trans>
						</Button>
					)}
				</div>
			</div>
		</div>
	);
});

export const DiscoveryThemesPage = observer(function DiscoveryThemesPage() {
	const {i18n} = useLingui();
	useEffect(() => {
		void ThemeLibrary.init();
	}, []);
	return (
		<div className={styles.container} data-flx="discovery.themes.discovery-themes-page.container">
			<Scroller data-flx="discovery.themes.discovery-themes-page.scroller">
				<div className={styles.scrollBody}>
					<h1 className={styles.heading}>{i18n._(PAGE_TITLE_DESCRIPTOR)}</h1>
					<p className={styles.lead}>
						<Trans>
							Ready-made colour palettes for the app. Apply one here; it lands in your theme library under Appearance,
							where you can switch it off or edit it in Theme Studio.
						</Trans>
					</p>
					<div className={styles.grid} data-flx="discovery.themes.discovery-themes-page.grid">
						{THEME_CATALOG.map((entry) => (
							<ThemeCard key={entry.id} entry={entry} />
						))}
					</div>
				</div>
			</Scroller>
		</div>
	);
});
