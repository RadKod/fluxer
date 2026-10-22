// SPDX-License-Identifier: AGPL-3.0-or-later

// The jam harness page. Dev-only text, so no lingui messages: nothing here reaches the catalogs.

import type {GuitarTone, JamDevHarness, JamDevSettings} from '@app/features/activities/band/dev/JamDevHarness';
import {JAM_BACKING_STYLES} from '@app/features/activities/band/jam/JamBacking';
import {JAM_SCALES, type JamInstrument, type JamScale} from '@app/features/activities/band/jam/JamScales';
import {observer} from 'mobx-react-lite';
import {type CSSProperties, useEffect} from 'react';

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const INSTRUMENTS: ReadonlyArray<JamInstrument> = ['guitar', 'bass', 'keys', 'drums'];
const TONES: ReadonlyArray<GuitarTone> = ['lead', 'clean'];

const page: CSSProperties = {
	fontFamily: 'system-ui, sans-serif',
	padding: 24,
	maxWidth: 760,
	color: '#e8e8e8',
	background: '#16171a',
	minHeight: '100vh',
	boxSizing: 'border-box',
};
const row: CSSProperties = {display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0'};
const lane: CSSProperties = {
	flex: '1 1 0',
	padding: '14px 6px',
	textAlign: 'center',
	border: '1px solid #444',
	borderRadius: 6,
	fontSize: 13,
};

function Select<T extends string | number>({
	label,
	value,
	options,
	onChange,
	format = String,
}: {
	label: string;
	value: T;
	options: ReadonlyArray<T>;
	onChange: (value: T) => void;
	format?: (value: T) => string;
}) {
	return (
		<label data-flx="activities.band.dev.jam-dev-app.select.label">
			{label}{' '}
			<select
				value={String(value)}
				onChange={(event) => {
					const picked = options.find((option) => String(option) === event.target.value);
					if (picked !== undefined) onChange(picked);
				}}
				data-flx="activities.band.dev.jam-dev-app.select.select"
			>
				{options.map((option) => (
					<option key={String(option)} value={String(option)} data-flx="activities.band.dev.jam-dev-app.select.option">
						{format(option)}
					</option>
				))}
			</select>
		</label>
	);
}

function Toggle({label, checked, onChange}: {label: string; checked: boolean; onChange: (checked: boolean) => void}) {
	return (
		<label data-flx="activities.band.dev.jam-dev-app.toggle.label">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				data-flx="activities.band.dev.jam-dev-app.toggle.input.change.checkbox"
			/>{' '}
			{label}
		</label>
	);
}

export const JamDevApp = observer(function JamDevApp({harness}: {harness: JamDevHarness}) {
	const {settings} = harness;
	const update = (patch: Partial<JamDevSettings>) => harness.update(patch);

	useEffect(() => {
		const down = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
			harness.handleKeyDown(event);
		};
		const up = (event: KeyboardEvent) => harness.handleKeyUp(event);
		const blur = () => harness.releaseAll();
		window.addEventListener('keydown', down);
		window.addEventListener('keyup', up);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('keydown', down);
			window.removeEventListener('keyup', up);
			window.removeEventListener('blur', blur);
		};
	}, [harness]);

	const latency = harness.medianLatency;
	const last = harness.latencies[harness.latencies.length - 1];
	const octaves = harness.octaveChoices();

	return (
		<div style={page} data-flx="activities.band.dev.jam-dev-app.div">
			<h2 data-flx="activities.band.dev.jam-dev-app.h2">Doğaçlama ses motoru (yerel deneme)</h2>
			<div style={row} data-flx="activities.band.dev.jam-dev-app.div--2">
				<button
					type="button"
					onClick={() => void harness.start()}
					disabled={harness.bank !== null}
					data-flx="activities.band.dev.jam-dev-app.button"
				>
					Sesi başlat
				</button>
				<span data-flx="activities.band.dev.jam-dev-app.span">{harness.status}</span>
				{harness.loadMs !== null && (
					<span data-flx="activities.band.dev.jam-dev-app.span--2">
						yükleme + hazırlık {Math.round(harness.loadMs)} ms
					</span>
				)}
			</div>
			<div style={{fontSize: 12, opacity: 0.7}} data-flx="activities.band.dev.jam-dev-app.div--3">
				Sample'lar: {harness.assetUrl} {harness.audioInfo}
			</div>

			<div style={row} data-flx="activities.band.dev.jam-dev-app.div--4">
				<Select
					label="Enstrüman"
					value={settings.instrument}
					options={INSTRUMENTS}
					onChange={(v) => update({instrument: v})}
					data-flx="activities.band.dev.jam-dev-app.select.update"
				/>
				{settings.instrument === 'guitar' && (
					<>
						<Select
							label="Ton"
							value={settings.tone}
							options={TONES}
							onChange={(v) => update({tone: v})}
							data-flx="activities.band.dev.jam-dev-app.select.update--2"
						/>
						<Toggle
							label="Power chord"
							checked={settings.powerChords}
							onChange={(v) => update({powerChords: v})}
							data-flx="activities.band.dev.jam-dev-app.toggle.update"
						/>
					</>
				)}
			</div>
			<div style={row} data-flx="activities.band.dev.jam-dev-app.div--5">
				<Select
					label="Ton merkezi"
					value={settings.key}
					options={KEY_NAMES.map((_, i) => i)}
					format={(i) => KEY_NAMES[i]}
					onChange={(v) => update({key: v})}
					data-flx="activities.band.dev.jam-dev-app.select.update--3"
				/>
				<Select
					label="Gam"
					value={settings.scale}
					options={Object.keys(JAM_SCALES) as ReadonlyArray<JamScale>}
					onChange={(v) => update({scale: v})}
					data-flx="activities.band.dev.jam-dev-app.select.update--4"
				/>
				<Select
					label="Pozisyon"
					value={settings.position}
					options={JAM_SCALES[settings.scale].map((_, i) => i)}
					onChange={(v) => update({position: v})}
					data-flx="activities.band.dev.jam-dev-app.select.update--5"
				/>
				<span data-flx="activities.band.dev.jam-dev-app.span--3">
					Oktav {settings.octave} (Z / X; geçerli: {octaves.join(', ') || '-'})
				</span>
			</div>

			<div style={{...row, flexWrap: 'nowrap'}} data-flx="activities.band.dev.jam-dev-app.div--6">
				{harness.laneLabels().map((label, i) => (
					<div key={label} style={lane} data-flx="activities.band.dev.jam-dev-app.div--7">
						<div style={{fontWeight: 600}} data-flx="activities.band.dev.jam-dev-app.div--8">
							{'ASDFG'[i]}
						</div>
						{label}
					</div>
				))}
			</div>
			<div style={{fontSize: 13, opacity: 0.8}} data-flx="activities.band.dev.jam-dev-app.div--9">
				Basılı tut: sustain (lead tonda 1.7 s sonra feedback). Space: tam ses bend, Shift+Space: 1.5 ses. Shift + şerit:
				pinch harmonic (lead) ya da alternatif davul.
			</div>

			<h3 data-flx="activities.band.dev.jam-dev-app.h3">Eşlik</h3>
			<div style={row} data-flx="activities.band.dev.jam-dev-app.div--10">
				<Select
					label="Stil"
					value={settings.backingStyle}
					options={JAM_BACKING_STYLES}
					onChange={(v) => update({backingStyle: v})}
					data-flx="activities.band.dev.jam-dev-app.select.update--6"
				/>
				<label data-flx="activities.band.dev.jam-dev-app.label">
					<span data-flx="activities.band.dev.jam-dev-app.span--4">BPM </span>
					<input
						type="number"
						min={40}
						max={240}
						value={settings.bpm}
						onChange={(event) => update({bpm: Number(event.target.value) || settings.bpm})}
						style={{width: 60}}
						data-flx="activities.band.dev.jam-dev-app.input.update.number"
					/>
				</label>
				<Toggle
					label="Davul"
					checked={settings.backingDrums}
					onChange={(v) => update({backingDrums: v})}
					data-flx="activities.band.dev.jam-dev-app.toggle.update--2"
				/>
				<Toggle
					label="Bas"
					checked={settings.backingBass}
					onChange={(v) => update({backingBass: v})}
					data-flx="activities.band.dev.jam-dev-app.toggle.update--3"
				/>
				<Toggle
					label="Klik"
					checked={settings.click}
					onChange={(v) => update({click: v})}
					data-flx="activities.band.dev.jam-dev-app.toggle.update--4"
				/>
				<button
					type="button"
					onClick={() => harness.toggleBacking()}
					disabled={harness.bank === null}
					data-flx="activities.band.dev.jam-dev-app.button.toggle-backing"
				>
					{harness.backingRunning ? 'Durdur' : 'Başlat'}
				</button>
			</div>

			<h3 data-flx="activities.band.dev.jam-dev-app.h3--2">Uzak oyuncu benzetimi</h3>
			<div style={row} data-flx="activities.band.dev.jam-dev-app.div--11">
				<Toggle
					label="Notalarımı uzak oyuncu olarak tekrar çal"
					checked={settings.echo}
					onChange={(v) => update({echo: v})}
					data-flx="activities.band.dev.jam-dev-app.toggle.update--5"
				/>
				<label data-flx="activities.band.dev.jam-dev-app.label--2">
					<span data-flx="activities.band.dev.jam-dev-app.span--5">ağ gecikmesi </span>
					<input
						type="number"
						min={0}
						max={500}
						value={settings.echoDelayMs}
						onChange={(event) => update({echoDelayMs: Number(event.target.value)})}
						style={{width: 60}}
						data-flx="activities.band.dev.jam-dev-app.input.update.number--2"
					/>
					<span data-flx="activities.band.dev.jam-dev-app.span--6"> ms ± </span>
					<input
						type="number"
						min={0}
						max={200}
						value={settings.echoJitterMs}
						onChange={(event) => update({echoJitterMs: Number(event.target.value)})}
						style={{width: 50}}
						data-flx="activities.band.dev.jam-dev-app.input.update.number--3"
					/>
					<span data-flx="activities.band.dev.jam-dev-app.span--7"> ms</span>
				</label>
				<span data-flx="activities.band.dev.jam-dev-app.span--8">
					{`geç kalan olay: ${harness.lateEvents}`}
					{harness.lateEvents > 0 && ` (son ${harness.lastLateMs.toFixed(0)} ms)`}
				</span>
			</div>

			<h3 data-flx="activities.band.dev.jam-dev-app.h3--3">Teknik demoları (offline render)</h3>
			<div style={row} data-flx="activities.band.dev.jam-dev-app.div--12">
				<button
					type="button"
					onClick={() => void harness.renderTechniques()}
					disabled={harness.rendering}
					data-flx="activities.band.dev.jam-dev-app.button--2"
				>
					{harness.rendering ? 'Render ediliyor…' : 'Bend, pinch, feedback demolarını render et'}
				</button>
				{harness.renderWavUrl && (
					<a
						href={harness.renderWavUrl}
						download="jam-teknik.wav"
						style={{color: '#8ab4ff'}}
						data-flx="activities.band.dev.jam-dev-app.a"
					>
						WAV indir
					</a>
				)}
			</div>
			{harness.renderReport && (
				<pre style={{fontSize: 12, whiteSpace: 'pre-wrap'}} data-flx="activities.band.dev.jam-dev-app.pre">
					{JSON.stringify(harness.renderReport, null, 1)}
				</pre>
			)}

			<h3 data-flx="activities.band.dev.jam-dev-app.h3--4">Gecikme (tuş → ses)</h3>
			<div data-flx="activities.band.dev.jam-dev-app.div--13">
				{latency === null
					? 'Henüz nota yok.'
					: `medyan ${latency.toFixed(1)} ms, son ${last?.toFixed(1)} ms, ${harness.latencies.length} nota`}
			</div>
		</div>
	);
});
