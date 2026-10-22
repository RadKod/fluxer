// SPDX-License-Identifier: AGPL-3.0-or-later

// The harness page: the band activity's real View on the left, in a box the size of the call stage, and the
// controls for the fake room on the right. Dev-only text, so no lingui messages: nothing here reaches the catalogs.

import type {BandBot, BandBotRole, BandBotSettings} from '@app/features/activities/band/dev/BandBots';
import styles from '@app/features/activities/band/dev/BandDevApp.module.css';
import {type BandDevHarness, type BandDevLayout, MAX_BOTS} from '@app/features/activities/band/dev/BandDevHarness';
import {BandDevLayouts} from '@app/features/activities/band/dev/BandDevLayouts';
import {BAND_DIFFICULTIES, type BandDifficulty, type BandPart} from '@app/features/activities/band/engine/ChartModel';
import {BAND_PARTS} from '@app/features/activities/band/flow/BandRoomMachine';
import {observer} from 'mobx-react-lite';

const LAYOUT_CHOICES: ReadonlyArray<readonly [BandDevLayout, string]> = [
	['stage', 'Büyük sahne'],
	['grid', 'Görüşme kutusu'],
	['mini', 'Küçük pencere'],
	['picker', 'Etkinlik seçici'],
];

const CHEER_CHOICES: ReadonlyArray<readonly [number, string]> = [
	[0, 'hiç'],
	[2_000, '2 sn'],
	[6_000, '6 sn'],
	[15_000, '15 sn'],
];

function stateSummary(state: unknown): string {
	if (typeof state !== 'object' || state === null) return 'state yok';
	const {phase, songId} = state as {phase?: unknown; songId?: unknown};
	return typeof songId === 'string' ? `${String(phase)} · ${songId}` : String(phase);
}

const BotRow = observer(function BotRow({bot, harness}: {bot: BandBot; harness: BandDevHarness}) {
	const {settings} = bot;
	const update = (patch: Partial<BandBotSettings>) => bot.update(patch);
	return (
		<li className={styles.bot} data-flx="activities.band.dev.band-dev-app.bot-row.bot">
			<div className={styles.botHeader} data-flx="activities.band.dev.band-dev-app.bot-row.bot-header">
				<input
					className={styles.nameInput}
					value={settings.name}
					onChange={(event) => update({name: event.target.value})}
					aria-label="Bot adı"
					data-flx="activities.band.dev.band-dev-app.bot-row.name-input"
				/>
				<button
					type="button"
					className={styles.button}
					onClick={() => harness.bots.remove(bot)}
					data-flx="activities.band.dev.band-dev-app.bot-row.button"
				>
					Çıkar
				</button>
			</div>
			<div className={styles.botFields} data-flx="activities.band.dev.band-dev-app.bot-row.bot-fields">
				<label className={styles.field} data-flx="activities.band.dev.band-dev-app.bot-row.field">
					<span data-flx="activities.band.dev.band-dev-app.bot-row.span">Rol</span>
					<select
						value={settings.role}
						onChange={(event) => update({role: event.target.value as BandBotRole})}
						data-flx="activities.band.dev.band-dev-app.bot-row.select"
					>
						<option value="player" data-flx="activities.band.dev.band-dev-app.bot-row.option">
							çalan
						</option>
						<option value="spectator" data-flx="activities.band.dev.band-dev-app.bot-row.option--2">
							izleyici
						</option>
					</select>
				</label>
				<label className={styles.field} data-flx="activities.band.dev.band-dev-app.bot-row.field--2">
					<span data-flx="activities.band.dev.band-dev-app.bot-row.span--2">Parti</span>
					<select
						value={settings.preferredParts[0] ?? ''}
						onChange={(event) => update({preferredParts: event.target.value ? [event.target.value as BandPart] : []})}
						data-flx="activities.band.dev.band-dev-app.bot-row.select--2"
					>
						<option value="" data-flx="activities.band.dev.band-dev-app.bot-row.option--3">
							boş olan
						</option>
						{BAND_PARTS.map((part) => (
							<option key={part} value={part} data-flx="activities.band.dev.band-dev-app.bot-row.option--4">
								{part}
							</option>
						))}
					</select>
				</label>
				<label className={styles.field} data-flx="activities.band.dev.band-dev-app.bot-row.field--3">
					<span data-flx="activities.band.dev.band-dev-app.bot-row.span--3">Zorluk</span>
					<select
						value={settings.difficulty ?? ''}
						onChange={(event) => update({difficulty: (event.target.value || null) as BandDifficulty | null})}
						data-flx="activities.band.dev.band-dev-app.bot-row.select--3"
					>
						<option value="" data-flx="activities.band.dev.band-dev-app.bot-row.option--5">
							grubunki
						</option>
						{BAND_DIFFICULTIES.map((difficulty) => (
							<option key={difficulty} value={difficulty} data-flx="activities.band.dev.band-dev-app.bot-row.option--6">
								{difficulty}
							</option>
						))}
					</select>
				</label>
				<label className={styles.field} data-flx="activities.band.dev.band-dev-app.bot-row.field--4">
					<span data-flx="activities.band.dev.band-dev-app.bot-row.span--4">{`İsabet %${Math.round(settings.accuracy * 100)}`}</span>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round(settings.accuracy * 100)}
						onChange={(event) => update({accuracy: Number(event.target.value) / 100})}
						data-flx="activities.band.dev.band-dev-app.bot-row.input"
					/>
				</label>
				<label className={styles.field} data-flx="activities.band.dev.band-dev-app.bot-row.field--5">
					<span data-flx="activities.band.dev.band-dev-app.bot-row.span--5">Alkış</span>
					<select
						value={settings.cheerEveryMs}
						onChange={(event) => update({cheerEveryMs: Number(event.target.value)})}
						data-flx="activities.band.dev.band-dev-app.bot-row.select--4"
					>
						{CHEER_CHOICES.map(([value, label]) => (
							<option key={value} value={value} data-flx="activities.band.dev.band-dev-app.bot-row.option--7">
								{label}
							</option>
						))}
					</select>
				</label>
			</div>
			<p className={styles.muted} data-flx="activities.band.dev.band-dev-app.bot-row.muted">
				{`${bot.activity} · ${harness.hitCounts[bot.userId] ?? 0} vuruş mesajı`}
			</p>
		</li>
	);
});

const ControlPanel = observer(function ControlPanel({harness}: {harness: BandDevHarness}) {
	const {session, songs} = harness;
	const full = harness.bots.bots.length >= MAX_BOTS;
	return (
		<aside className={styles.panel} data-flx="activities.band.dev.band-dev-app.control-panel.panel">
			<section className={styles.section} data-flx="activities.band.dev.band-dev-app.control-panel.section">
				<h2 className={styles.heading} data-flx="activities.band.dev.band-dev-app.control-panel.heading">
					Şarkılar
				</h2>
				<p className={styles.muted} data-flx="activities.band.dev.band-dev-app.control-panel.muted">
					{songs.baseUrl}
				</p>
				{songs.error ? (
					<p className={styles.error} data-flx="activities.band.dev.band-dev-app.control-panel.error">
						{`${songs.error}. Şarkı sunucusu açık mı? node scripts/sarkilar/yerel-sunucu.mjs <kütüphane>`}
					</p>
				) : (
					<p data-flx="activities.band.dev.band-dev-app.control-panel.p">
						{songs.loading ? 'yükleniyor' : `${songs.songs.length} şarkı`}
					</p>
				)}
				<button
					type="button"
					className={styles.button}
					onClick={() => void songs.load()}
					data-flx="activities.band.dev.band-dev-app.control-panel.button"
				>
					Index'i yeniden oku
				</button>
			</section>

			<section className={styles.section} data-flx="activities.band.dev.band-dev-app.control-panel.section--layout">
				<h2 className={styles.heading} data-flx="activities.band.dev.band-dev-app.control-panel.heading--layout">
					Görünüm
				</h2>
				<div className={styles.row} data-flx="activities.band.dev.band-dev-app.control-panel.row--layout">
					{LAYOUT_CHOICES.map(([layout, label]) => (
						<button
							key={layout}
							type="button"
							className={styles.button}
							aria-pressed={harness.layout === layout}
							onClick={() => harness.setLayout(layout)}
							data-flx="activities.band.dev.band-dev-app.control-panel.button--layout"
						>
							{label}
						</button>
					))}
				</div>
				<p className={styles.muted} data-flx="activities.band.dev.band-dev-app.control-panel.muted--layout">
					Oyun bir kez kurulur ve yerler arasında taşınır; şarkı sürerken değiştirmek sesi kesmemeli.
				</p>
			</section>

			<section className={styles.section} data-flx="activities.band.dev.band-dev-app.control-panel.section--2">
				<h2 className={styles.heading} data-flx="activities.band.dev.band-dev-app.control-panel.heading--2">
					Oturum
				</h2>
				<p data-flx="activities.band.dev.band-dev-app.control-panel.p--2">
					{`${stateSummary(session.state)} · v${session.stateVersion}${session.ended ? ' · bitti' : ''}`}
				</p>
				<div className={styles.botFields} data-flx="activities.band.dev.band-dev-app.control-panel.bot-fields">
					<label className={styles.field} data-flx="activities.band.dev.band-dev-app.control-panel.field">
						<span data-flx="activities.band.dev.band-dev-app.control-panel.span">Gecikme (ms)</span>
						<input
							type="number"
							min={0}
							max={1000}
							value={session.latencyMs}
							onChange={(event) => session.setNetwork({latencyMs: Number(event.target.value)})}
							data-flx="activities.band.dev.band-dev-app.control-panel.input"
						/>
					</label>
					<label className={styles.field} data-flx="activities.band.dev.band-dev-app.control-panel.field--2">
						<span data-flx="activities.band.dev.band-dev-app.control-panel.span--2">Kayıp (%)</span>
						<input
							type="number"
							min={0}
							max={100}
							value={Math.round(session.lossyDropRate * 100)}
							onChange={(event) => session.setNetwork({lossyDropRate: Number(event.target.value) / 100})}
							data-flx="activities.band.dev.band-dev-app.control-panel.input--2"
						/>
					</label>
				</div>
				<button
					type="button"
					className={styles.button}
					onClick={() => harness.restart()}
					data-flx="activities.band.dev.band-dev-app.control-panel.button--2"
				>
					Oturumu yeniden başlat
				</button>
			</section>

			<section className={styles.section} data-flx="activities.band.dev.band-dev-app.control-panel.section--3">
				<h2 className={styles.heading} data-flx="activities.band.dev.band-dev-app.control-panel.heading--3">
					{`Botlar (${harness.bots.bots.length}/${MAX_BOTS})`}
				</h2>
				<div className={styles.row} data-flx="activities.band.dev.band-dev-app.control-panel.row">
					<button
						type="button"
						className={styles.button}
						disabled={full}
						onClick={() => harness.addBot({role: 'player'})}
						data-flx="activities.band.dev.band-dev-app.control-panel.button--3"
					>
						Çalan ekle
					</button>
					<button
						type="button"
						className={styles.button}
						disabled={full}
						onClick={() => harness.addBot({role: 'spectator'})}
						data-flx="activities.band.dev.band-dev-app.control-panel.button--4"
					>
						İzleyici ekle
					</button>
				</div>
				<ul className={styles.bots} data-flx="activities.band.dev.band-dev-app.control-panel.bots">
					{harness.bots.bots.map((bot) => (
						<BotRow
							key={bot.id}
							bot={bot}
							harness={harness}
							data-flx="activities.band.dev.band-dev-app.control-panel.bot-row"
						/>
					))}
				</ul>
			</section>

			<section className={styles.section} data-flx="activities.band.dev.band-dev-app.control-panel.section--4">
				<h2 className={styles.heading} data-flx="activities.band.dev.band-dev-app.control-panel.heading--4">
					Gelen mesajlar
				</h2>
				<ol className={styles.log} data-flx="activities.band.dev.band-dev-app.control-panel.log">
					{harness.log.map((entry) => (
						<li key={entry.key} data-flx="activities.band.dev.band-dev-app.control-panel.li">
							{`${entry.from}: ${entry.text}`}
						</li>
					))}
				</ol>
			</section>
		</aside>
	);
});

export const BandDevApp = observer(function BandDevApp({harness}: {harness: BandDevHarness}) {
	return (
		<div className={styles.root} data-flx="activities.band.dev.band-dev-app.root">
			<main className={styles.stage} data-flx="activities.band.dev.band-dev-app.stage">
				<BandDevLayouts harness={harness} data-flx="activities.band.dev.band-dev-app.layouts" />
			</main>
			<ControlPanel harness={harness} data-flx="activities.band.dev.band-dev-app.control-panel" />
		</div>
	);
});
