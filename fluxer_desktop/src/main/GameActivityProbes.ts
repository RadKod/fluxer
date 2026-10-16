// SPDX-License-Identifier: AGPL-3.0-or-later

// Process listing for game activity on macOS and Linux. Nothing here needs a native module or a macOS
// privacy permission: `ps` and /proc only show process names.

import {execFile} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';

export interface ProbeProcessEntry {
	exe: string;
	pid: number;
}

export type ExecFileRunner = (file: string, args: ReadonlyArray<string>, timeoutMs: number) => Promise<string>;

export interface ProcFs {
	readdir: (path: string) => Promise<Array<string>>;
	readFile: (path: string) => Promise<Buffer>;
}

const MAX_PROCESSES = 20_000;
const MAX_NAME_LENGTH = 260;
const PS_TIMEOUT_MS = 5_000;
const PROC_BATCH = 64;

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
