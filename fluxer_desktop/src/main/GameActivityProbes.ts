// SPDX-License-Identifier: AGPL-3.0-or-later

// Process listing and Spotify now-playing probes for macOS and Linux (and Spotify on Windows).
// Nothing here needs a native module or a macOS privacy permission, except the Spotify AppleScript
// query, which macOS gates behind a one-time Automation prompt the first time it runs.

import {execFile} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import {LISTENING_ACTIVITY_PREFIX} from '@electron/common/GameActivityTypes';

export interface ProbeProcessEntry {
	exe: string;
	pid: number;
}

export interface NowPlaying {
	artist: string;
	title: string;
}

export type ExecFileRunner = (file: string, args: ReadonlyArray<string>, timeoutMs: number) => Promise<string>;

export interface ProcFs {
	readdir: (path: string) => Promise<Array<string>>;
	readFile: (path: string) => Promise<Buffer>;
}

const MAX_PROCESSES = 20_000;
const MAX_NAME_LENGTH = 260;
const PS_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 4_000;
const PROC_BATCH = 64;
const MAX_NAME_CODE_POINTS = 64;
const MAX_NAME_BYTES = 256;
// Matches what the gateway and schema reject in a manual_name, plus surrogates.
const INVISIBLE =
	/(?:[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|\u034f|[\u115f\u1160\u17b4\u17b5\u3164\uffa0]|[\u180b-\u180f]|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}])/gu;
const SPOTIFY_WINDOW_IDLE = /^spotify(?: (?:free|premium))?$/i;

export const defaultExecFile: ExecFileRunner = (file, args, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8'},
			(error, stdout, stderr) => {
				if (error) reject(Object.assign(error, {stderr: String(stderr ?? '')}));
				else resolve(String(stdout));
			},
		);
	});

const defaultProcFs: ProcFs = {readdir: (path) => readdir(path), readFile: (path) => readFile(path)};

// Basename of a Unix or Windows style path, lowercased; null when it would not pass snapshot validation.
export function processBasename(path: string): string | null {
	const base = path.trim().split(/[\\/]/).pop()?.trim().toLowerCase() ?? '';
	if (base.length === 0 || base.length > MAX_NAME_LENGTH || /[\p{Cc}\p{Cf}]/u.test(base)) return null;
	return base;
}

function parsePsLines(output: string): Map<number, string> {
	const rows = new Map<number, string>();
	for (const line of output.split('\n')) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		if (Number.isSafeInteger(pid)) rows.set(pid, match[2]);
	}
	return rows;
}

// A Wine, CrossOver or Whisky process shows the Windows game path as argv[0].
// A space is only accepted inside a Windows path, so "grep cs2.exe" is not read as a game.
function windowsExeFromArgs(args: string): string | null {
	const match = /^(.*?\.exe)(?:\s|$)/i.exec(args);
	if (!match || (match[1].includes(' ') && !match[1].includes('\\'))) return null;
	return processBasename(match[1]);
}

// `comm` is the exact executable path (it may contain spaces, so it gets its own ps call); `args` only
// supplies the `.exe` name of Windows games running under a compatibility layer.
export function parseDarwinProcesses(commOutput: string, argsOutput: string): Array<ProbeProcessEntry> {
	const args = parsePsLines(argsOutput);
	const entries: Array<ProbeProcessEntry> = [];
	for (const [pid, comm] of parsePsLines(commOutput)) {
		const argv = args.get(pid);
		const exe = (argv ? windowsExeFromArgs(argv) : null) ?? processBasename(comm);
		if (exe) entries.push({exe, pid});
		if (entries.length >= MAX_PROCESSES) break;
	}
	return entries;
}

export async function listDarwinProcesses(run: ExecFileRunner = defaultExecFile): Promise<Array<ProbeProcessEntry>> {
	const [comm, args] = await Promise.all([
		run('/bin/ps', ['-axww', '-o', 'pid=,comm='], PS_TIMEOUT_MS),
		run('/bin/ps', ['-axww', '-o', 'pid=,args='], PS_TIMEOUT_MS),
	]);
	return parseDarwinProcesses(comm, args);
}

// argv[0] keeps the full name (`comm` is cut at 15 bytes) and shows the `.exe` of Proton and Wine games.
// Some programs rewrite argv[0] into one space-joined command line, so a candidate is only trusted when
// it starts with the kernel's `comm`.
export function linuxProcessName(cmdline: Buffer | null, comm: Buffer | null): string | null {
	const argv0 = cmdline ? cmdline.toString('utf8').split('\0')[0] : '';
	const kernel = comm ? processBasename(comm.toString('utf8')) : null;
	if (argv0) {
		const exe = windowsExeFromArgs(argv0);
		if (exe) return exe;
		const whole = processBasename(argv0);
		const first = processBasename(argv0.split(' ')[0]);
		if (!kernel) return first;
		for (const candidate of [whole === kernel ? whole : null, first, whole]) {
			if (candidate?.startsWith(kernel)) return candidate;
		}
	}
	return kernel;
}

export async function listLinuxProcesses(fs: ProcFs = defaultProcFs): Promise<Array<ProbeProcessEntry>> {
	const pids = (await fs.readdir('/proc'))
		.filter((name) => /^\d{1,10}$/.test(name))
		.map(Number)
		.filter(Number.isSafeInteger)
		.slice(0, MAX_PROCESSES);
	const read = (path: string) => fs.readFile(path).catch(() => null);
	const entries: Array<ProbeProcessEntry> = [];
	for (let index = 0; index < pids.length; index += PROC_BATCH) {
		const batch = pids.slice(index, index + PROC_BATCH);
		const names = await Promise.all(
			batch.map(async (pid) => {
				const cmdline = await read(`/proc/${pid}/cmdline`);
				// Kernel threads have an empty cmdline; they are never games.
				if (!cmdline || cmdline.length === 0) return null;
				return linuxProcessName(cmdline, await read(`/proc/${pid}/comm`));
			}),
		);
		names.forEach((exe, offset) => {
			if (exe) entries.push({exe, pid: batch[offset]});
		});
	}
	return entries;
}

function clean(value: string): string {
	return value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

// "♫ Artist – Title", cut to the 64 code point / 256 byte manual_name limit.
export function formatListeningName(nowPlaying: NowPlaying): string | null {
	const artist = clean(nowPlaying.artist);
	const title = clean(nowPlaying.title);
	if (!title) return null;
	const full = `${LISTENING_ACTIVITY_PREFIX}${artist ? `${artist} \u2013 ${title}` : title}`;
	const points = Array.from(full);
	let name =
		points.length > MAX_NAME_CODE_POINTS
			? `${points
					.slice(0, MAX_NAME_CODE_POINTS - 1)
					.join('')
					.trimEnd()}\u2026`
			: full;
	while (new TextEncoder().encode(name).length > MAX_NAME_BYTES)
		name = `${Array.from(name).slice(0, -2).join('')}\u2026`;
	return name;
}

// AppleScript output: "playing\nArtist\nTitle"; anything else means nothing is playing.
export function parseSpotifyAppleScript(output: string): NowPlaying | null {
	const [state, artist = '', title = ''] = output.replace(/\r/g, '').replace(/\n$/, '').split('\n');
	return state === 'playing' && title.trim() ? {artist, title} : null;
}

// Spotify's main window title is "Artist - Title" while playing and "Spotify" (or "Spotify Premium") when paused.
export function parseSpotifyWindowTitles(output: string): NowPlaying | null {
	for (const raw of output.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || SPOTIFY_WINDOW_IDLE.test(line)) continue;
		const separator = line.indexOf(' - ');
		if (separator <= 0) continue;
		return {artist: line.slice(0, separator), title: line.slice(separator + 3)};
	}
	return null;
}

// playerctl format: "Playing\tArtist\tTitle".
export function parsePlayerctl(output: string): NowPlaying | null {
	const [status, artist = '', title = ''] = output.replace(/\r?\n$/, '').split('\t');
	return status === 'Playing' && title.trim() ? {artist, title} : null;
}

// Runs only after a Spotify process was seen, so `tell application` never has to look for or launch it;
// the `is running` guard covers Spotify quitting between the process scan and this call.
const SPOTIFY_APPLESCRIPT = [
	'if application "Spotify" is running then',
	'tell application "Spotify"',
	'if player state is playing then',
	'set t to current track',
	'return "playing" & linefeed & (artist of t as text) & linefeed & (name of t as text)',
	'end if',
	'end tell',
	'end if',
	'return "stopped"',
];

const SPOTIFY_POWERSHELL =
	'[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
	'Get-Process -Name Spotify -ErrorAction SilentlyContinue|ForEach-Object{$_.MainWindowTitle}';

export function spotifyProcessName(platform: NodeJS.Platform): string | null {
	if (platform === 'darwin' || platform === 'linux') return 'spotify';
	if (platform === 'win32') return 'spotify.exe';
	return null;
}

export class SpotifyProbeUnavailable extends Error {
	public constructor() {
		super('Spotify probe unavailable');
		this.name = 'SpotifyProbeUnavailable';
	}
}

export async function readSpotifyNowPlaying(
	platform: NodeJS.Platform,
	run: ExecFileRunner = defaultExecFile,
): Promise<NowPlaying | null> {
	try {
		if (platform === 'darwin') {
			const args = SPOTIFY_APPLESCRIPT.flatMap((line) => ['-e', line]);
			return parseSpotifyAppleScript(await run('/usr/bin/osascript', args, PROBE_TIMEOUT_MS));
		}
		if (platform === 'win32') {
			const shell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
			const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SPOTIFY_POWERSHELL];
			return parseSpotifyWindowTitles(await run(shell, args, PROBE_TIMEOUT_MS));
		}
		if (platform === 'linux') {
			const args = ['--player=spotify', 'metadata', '--format', '{{status}}\t{{artist}}\t{{title}}'];
			return parsePlayerctl(await run('playerctl', args, PROBE_TIMEOUT_MS));
		}
		return null;
	} catch (error) {
		const code = (error as {code?: unknown}).code;
		const stderr = String((error as {stderr?: unknown}).stderr ?? '');
		// Missing playerctl, or macOS Automation access denied (-1743): stop asking for a while.
		if (code === 'ENOENT' || /-1743|not authori[sz]ed/i.test(stderr)) throw new SpotifyProbeUnavailable();
		// playerctl exits non-zero when Spotify exposes no MPRIS player; that is "nothing playing".
		if (platform === 'linux' && typeof code === 'number') return null;
		throw error;
	}
}
