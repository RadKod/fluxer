// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

// The first boot of this client on a browser profile written by the previous Micup web release:
// the token and user ID sit in raw localStorage and the FluxerAccounts record carries the old runtime snapshot
// (no uploadRelayEndpoint, community or services), so it is classified for runtime recovery through discovery.

import type {StoredAccountInventory} from '@app/features/auth/state/StoredAccountInventoryContract';
import {instanceDiscoveryFixture} from '@app/features/platform/state/__fixtures__/RuntimeBootstrapFixture';
import type {MessageDescriptor} from '@lingui/core';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: MessageDescriptor) => descriptor}));
vi.mock('@app/features/gateway/transport/GatewayConnection', () => ({
	default: {
		sendInvisiblePresenceForCurrentSession: () => undefined,
		retireForAccountTransition: async () => undefined,
		logout: () => undefined,
	},
}));
vi.mock('@app/features/presence/state/LocalPresence', () => ({
	default: {captureIntent: () => null, restoreIntent: () => undefined},
}));
vi.mock('@app/features/ui/state/LayerManager', () => ({default: {closeAll: () => undefined}}));

const WEB_ORIGIN = 'https://micup.test';
const API_ENDPOINT = `${WEB_ORIGIN}/api`;
const DISCOVERY_URL = `${WEB_ORIGIN}/.well-known/fluxer`;
const USER_ID = '1500000000000000001';
const TOKEN = 'deployed-session-token';
const ACCOUNT_KEY = `${API_ENDPOINT}::${USER_ID}`;
const ACCOUNTS_DB = 'FluxerAccounts';
const ACCOUNTS_STORE = 'accounts';

function discoveryDocument(apiEndpoint: string, release: 'previous' | 'current'): Record<string, unknown> {
	const document = instanceDiscoveryFixture(apiEndpoint) as unknown as Record<string, unknown>;
	const endpoints = {...(document.endpoints as Record<string, unknown>)};
	const community = {...(document.community as Record<string, unknown>)};
	if (release === 'previous') {
		delete endpoints.upload_relay;
		delete community.guild_create_access;
	} else {
		endpoints.upload_relay = null;
	}
	const features = {
		...(document.features as Record<string, unknown>),
		official_apps: [
			{application_id: '1556522428186755072', invite_permissions: '1099780156480'},
			{application_id: '1556521291765252096', invite_permissions: '17910848'},
		],
	};
	return {...document, api_code_version: 1, endpoints, community, features};
}

// AccountStorage.sanitizeRecord of the previous release keeps exactly these runtime fields.
function previousReleaseRecord(apiEndpoint: string, token: string = TOKEN): Record<string, unknown> {
	const origin = new URL(apiEndpoint).origin;
	return {
		userId: USER_ID,
		token,
		userData: {username: 'olcum', discriminator: '0001', globalName: null, avatar: null},
		presenceIntent: null,
		localStorageData: {},
		managedStorageData: {},
		lastActive: 1_760_000_000_000,
		instance: {
			apiEndpoint,
			apiPublicEndpoint: apiEndpoint,
			gatewayEndpoint: `${origin.replace(/^http/u, 'ws')}/gateway`,
			mediaEndpoint: 'https://media.micup.test',
			staticCdnEndpoint: 'https://static.micup.test',
			marketingEndpoint: `${origin}/marketing`,
			adminEndpoint: 'https://admin.micup.test',
			inviteEndpoint: `${origin}/invite`,
			giftEndpoint: `${origin}/gift`,
			webAppEndpoint: origin,
			gifProvider: 'klipy',
			gifProviderDisplayName: 'Klipy',
			gifAttributionRequired: false,
			captchaProvider: 'turnstile',
			hcaptchaSiteKey: null,
			turnstileSiteKey: 'site-key',
			apiCodeVersion: 1,
			features: {voice_enabled: true, self_hosted: true},
			sso: null,
			registration: {mode: 'open', admin_registration_urls_enabled: true},
			publicPushVapidKey: null,
			limits: {version: 1, traitDefinitions: [], rules: []},
			appPublic: {
				branding: {product_name: 'Micup'},
				setup: {configured: true, admin_url: null},
				legal: {terms_url: null, privacy_url: null, source_url: null},
				registration: {collect_date_of_birth: true},
			},
		},
	};
}

async function openAccountsDatabase(): Promise<IDBDatabase> {
	return await new Promise<IDBDatabase>((resolve, reject) => {
		const request = window.indexedDB.open(ACCOUNTS_DB, 2);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(ACCOUNTS_STORE, {keyPath: 'userId'}).createIndex('lastActive', 'lastActive');
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function seedAccountRecord(record: Record<string, unknown>): Promise<void> {
	const database = await openAccountsDatabase();
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction([ACCOUNTS_STORE], 'readwrite');
		transaction.objectStore(ACCOUNTS_STORE).put(record);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
	});
	database.close();
}

async function readAccountRecord(): Promise<Record<string, unknown> | null> {
	const database = await openAccountsDatabase();
	const record = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
		const request = database.transaction([ACCOUNTS_STORE], 'readonly').objectStore(ACCOUNTS_STORE).get(USER_ID);
		request.onsuccess = () => resolve((request.result as Record<string, unknown> | undefined) ?? null);
		request.onerror = () => reject(request.error);
	});
	database.close();
	return record;
}

function seedPreviousReleaseMirror(token: string = TOKEN): void {
	window.localStorage.setItem('token', token);
	window.localStorage.setItem('userId', USER_ID);
}

interface CurrentUserRequest {
	readonly url: string;
	readonly authorization: string | null;
}

// A user ID answers 200 with that user, a status answers that HTTP error, a body answers 200 with exactly that body
// and an Error is thrown as is (network failure, timeout).
type CurrentUserAnswer = {readonly id: string} | {readonly status: number} | {readonly body: unknown} | Error;

let currentUserAnswer: CurrentUserAnswer | null = null;
let currentUserLog: Array<CurrentUserRequest> = [];

function serveDiscovery(
	documents: Readonly<Record<string, unknown>>,
	currentUser: CurrentUserAnswer | null = null,
	currentUserRequests: Array<CurrentUserRequest> = [],
): Array<string> {
	const requested: Array<string> = [];
	currentUserAnswer = currentUser;
	currentUserLog = currentUserRequests;
	vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		requested.push(url);
		const document = documents[url];
		if (document === undefined) {
			return new Response('not found', {status: 404, headers: {'content-type': 'text/plain'}});
		}
		return new Response(JSON.stringify(document), {status: 200, headers: {'content-type': 'application/json'}});
	});
	return requested;
}

function setDocumentUrl(url: string): void {
	(window as unknown as {happyDOM: {setURL(url: string): void}}).happyDOM.setURL(url);
}

// The web boot order of index.tsx and AppBootstrap: storage bootstrap, session restore, storage finalization.
async function bootWebClient() {
	const {startAppStorage} = await import('@app/features/platform/state/AppStorageBootstrap');
	const storageBootstrap = await startAppStorage();
	const {createSessionManager} = await import('@app/features/platform/state/AuthSession');
	const {createDefaultAuthSessionDependencies} = await import(
		'@app/features/platform/state/auth_session/AuthSessionDependencies'
	);
	const {HttpError} = await import('@app/features/platform/types/EndpointError');
	const session = createSessionManager({
		...createDefaultAuthSessionDependencies(),
		// The REST transport is XMLHttpRequest; the instance answer for GET /users/@me is served here instead.
		http: {
			get: async <T>(path: string, options: {headers?: Record<string, string>; target: {apiEndpoint: string}}) => {
				const url = `${options.target.apiEndpoint}/v1${path}`;
				currentUserLog.push({url, authorization: options.headers?.Authorization ?? null});
				if (currentUserAnswer instanceof Error) {
					throw currentUserAnswer;
				}
				if (currentUserAnswer === null || 'status' in currentUserAnswer) {
					throw new HttpError({method: 'GET', path, status: currentUserAnswer?.status ?? 401});
				}
				return {body: ('body' in currentUserAnswer ? currentUserAnswer.body : {id: currentUserAnswer.id}) as T};
			},
		},
		closeLayers: () => undefined,
		captureForegroundFeedSnapshot: () => undefined,
		resetSyncedUserSettings: async () => undefined,
		captureSyncedUserSettingsCheckpoint: async () => Object.freeze({}) as never,
		restoreSyncedUserSettingsCheckpoint: async () => undefined,
	});
	let initializationError: unknown = null;
	try {
		await session.initialize();
	} catch (error) {
		initializationError = error;
	}
	const account = session.currentAccount;
	await storageBootstrap.finalizeAfterSessionResolution(
		account === null || account.instance === undefined
			? null
			: {accountKey: account.storageKey, userId: account.userId, token: account.token, instance: account.instance},
	);
	return {session, initializationError};
}

function expectMirrorIntact(token: string = TOKEN): void {
	expect(window.localStorage.getItem('userId')).toBe(USER_ID);
	expect(window.localStorage.getItem('token')).toBe(token);
}

function expectMirrorCleared(): void {
	expect(window.localStorage.getItem('token')).toBeNull();
	expect(window.localStorage.getItem('userId')).toBeNull();
}

function timeoutError(): Error {
	return Object.assign(new Error('Request timed out'), {name: 'TimeoutError'});
}

let consoleCalls: Array<ReadonlyArray<unknown>> = [];

function describeLogged(value: unknown, depth = 0): string {
	if (value instanceof Error && depth < 8) {
		const fields = describeLogged({...value}, depth + 1);
		return `${value.name}: ${value.message}\n${value.stack ?? ''}\n${fields}\n${describeLogged(value.cause, depth + 1)}`;
	}
	try {
		return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		return String(value);
	}
}

function loggedErrors(): Array<Error> {
	return consoleCalls.flat().filter((value): value is Error => value instanceof Error);
}

beforeEach(async () => {
	vi.resetModules();
	const {IDBFactory} = await import('fake-indexeddb');
	Object.defineProperty(window, 'indexedDB', {value: new IDBFactory(), configurable: true, writable: true});
	setDocumentUrl(`${WEB_ORIGIN}/channels/@me`);
	window.localStorage.clear();
	consoleCalls = [];
	for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) {
		vi.spyOn(console, method).mockImplementation((...args: Array<unknown>) => {
			consoleCalls.push(args);
		});
	}
});

afterEach(() => {
	// No boot path may write a session token into the console.
	const logged = consoleCalls.map((args) => args.map((value) => describeLogged(value)).join(' ')).join('\n');
	for (const token of [TOKEN, 'token-before-rotation']) {
		expect(logged).not.toContain(token);
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(window, 'electron');
	window.localStorage.clear();
});

describe('a web profile written by the previous release, on its first boot of this client', () => {
	test('stays signed in through one discovery request and is re-keyed to its instance-qualified account', async () => {
		await seedAccountRecord(previousReleaseRecord(API_ENDPOINT));
		seedPreviousReleaseMirror();
		const requested = serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')});

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(session.userId).toBe(USER_ID);
		expect(session.token).toBe(TOKEN);
		expect(session.currentAccountKey).toBe(ACCOUNT_KEY);
		expect(requested).toEqual([DISCOVERY_URL]);
		expect(window.localStorage.getItem('fluxer:auth:active-account-key')).toBe(ACCOUNT_KEY);
		expectMirrorIntact();
		expect((await readAccountRecord())?.storageKey).toBe(ACCOUNT_KEY);
	});

	test('a later boot stays signed in even when discovery is down, from the re-keyed record', async () => {
		await seedAccountRecord(previousReleaseRecord(API_ENDPOINT));
		seedPreviousReleaseMirror();
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')});
		await bootWebClient();

		vi.resetModules();
		serveDiscovery({});
		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(session.currentAccountKey).toBe(ACCOUNT_KEY);
	});

	test('a token rotated after the record was written (password change) is restored from the mirror', async () => {
		await seedAccountRecord(previousReleaseRecord(API_ENDPOINT, 'token-before-rotation'));
		seedPreviousReleaseMirror();
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')});

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(session.token).toBe(TOKEN);
	});

	test('discovery being unreachable on that first boot fails the boot and keeps the credentials', async () => {
		await seedAccountRecord(previousReleaseRecord(API_ENDPOINT));
		seedPreviousReleaseMirror();
		const requested = serveDiscovery({});

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeInstanceOf(Error);
		expect((initializationError as Error).name).toBe('InstanceDiscoveryUnreachableError');
		expect(session.isAuthenticated).toBe(false);
		expect(requested).toEqual([DISCOVERY_URL, `${API_ENDPOINT}/.well-known/fluxer`]);
		expectMirrorIntact();
	});

	test('a client API endpoint that changed with the upgrade fails every boot of the stored account', async () => {
		await seedAccountRecord(previousReleaseRecord(API_ENDPOINT));
		seedPreviousReleaseMirror();
		const movedApi = `${WEB_ORIGIN}/api/v2`;
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(movedApi, 'current')});

		const {session, initializationError} = await bootWebClient();

		expect((initializationError as Error | null)?.name).toBe('StoredAccountRuntimeIdentityMismatchError');
		expect(session.isAuthenticated).toBe(false);
		expectMirrorIntact();
	});

	test('the account record this client writes holds a runtime with official apps (no DataCloneError)', async () => {
		await seedAccountRecord(previousReleaseRecord(API_ENDPOINT));
		seedPreviousReleaseMirror();
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')});
		const {session} = await bootWebClient();

		await session.stashCurrentAccount();

		const stored = await readAccountRecord();
		expect(stored?.storageKey).toBe(ACCOUNT_KEY);
		expect(stored?.token).toBe(TOKEN);
		const instance = stored?.instance as {features: {official_apps: Array<unknown>}} | undefined;
		expect(instance?.features.official_apps).toHaveLength(2);
	});
});

// The previous release never persisted its account record on Micup: the runtime snapshot it stored kept the MobX
// observable features.official_apps array, so every IndexedDB put failed with a DataCloneError and fell back to memory.
// Its session lives only in the raw token/userId mirror.
describe('a previous-release session that only exists in the raw credential mirror', () => {
	test('is adopted for this page instance once the instance confirms the token, and stays signed in', async () => {
		seedPreviousReleaseMirror();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, {id: USER_ID}, currentUserRequests);

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(session.currentAccountKey).toBe(ACCOUNT_KEY);
		expect(window.localStorage.getItem('fluxer:auth:active-account-key')).toBe(ACCOUNT_KEY);
		expect(currentUserRequests).toEqual([{url: `${API_ENDPOINT}/v1/users/@me`, authorization: TOKEN}]);
		const stored = await readAccountRecord();
		expect(stored?.storageKey).toBe(ACCOUNT_KEY);
		expect(stored?.token).toBe(TOKEN);
		expectMirrorIntact();
	});

	test('is adopted once: the next boot restores from the account inventory without asking the instance again', async () => {
		seedPreviousReleaseMirror();
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, {id: USER_ID});
		await bootWebClient();

		vi.resetModules();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, null, currentUserRequests);
		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(currentUserRequests).toEqual([]);
	});

	test('a token the instance rejects is signed out cleanly: no record, no mirror, no second attempt', async () => {
		seedPreviousReleaseMirror();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, {status: 401}, currentUserRequests);

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(false);
		expect(currentUserRequests).toHaveLength(1);
		expect(await readAccountRecord()).toBeNull();
		expectMirrorCleared();
		const logged = consoleCalls.map((args) => args.map((value) => describeLogged(value)).join(' ')).join('\n');
		expect(logged).toContain('rejected the stored session credential, signing it out');
		expect(logged).not.toContain('keeping its credential mirror intact');
	});

	test('a token answered for another user is never adopted and is signed out after that one request', async () => {
		seedPreviousReleaseMirror();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery(
			{[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')},
			{id: '1500000000000000999'},
			currentUserRequests,
		);

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(false);
		expect(currentUserRequests).toHaveLength(1);
		expect(await readAccountRecord()).toBeNull();
		expectMirrorCleared();
	});

	test.each([
		['a network failure', (): CurrentUserAnswer => new Error('Network error during request')],
		['a timeout', (): CurrentUserAnswer => timeoutError()],
		['a 503', (): CurrentUserAnswer => ({status: 503})],
		['a 429', (): CurrentUserAnswer => ({status: 429})],
		['a 403', (): CurrentUserAnswer => ({status: 403})],
		['a 200 HTML page', (): CurrentUserAnswer => ({body: '<!doctype html><html></html>'})],
		['a 200 body without a user ID', (): CurrentUserAnswer => ({body: {}})],
		['a 200 body with a numeric user ID', (): CurrentUserAnswer => ({body: {id: 1_500_000_000_000_000}})],
	])('%s skips the adoption for this boot: signed out, credentials kept, logout still works', async (_, answer) => {
		seedPreviousReleaseMirror();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, answer(), currentUserRequests);

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(false);
		expect(currentUserRequests).toHaveLength(1);
		expect(await readAccountRecord()).toBeNull();
		expectMirrorIntact();
		await session.logout();
		expectMirrorCleared();
	});

	test.each([
		['an unreachable discovery', (): Record<string, unknown> => ({})],
		[
			'a discovery document this client rejects (API code version 0)',
			(): Record<string, unknown> => ({
				[DISCOVERY_URL]: {...discoveryDocument(API_ENDPOINT, 'current'), api_code_version: 0},
			}),
		],
	])('%s skips the adoption for this boot without asking for the current user', async (_, documents) => {
		seedPreviousReleaseMirror();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery(documents(), {id: USER_ID}, currentUserRequests);

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(false);
		expect(currentUserRequests).toEqual([]);
		expectMirrorIntact();
		await session.logout();
		expectMirrorCleared();
	});

	test('a boot that skipped the adoption leaves it to the next boot, which adopts the credential', async () => {
		seedPreviousReleaseMirror();
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, {status: 503});
		await bootWebClient();

		vi.resetModules();
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, {id: USER_ID});
		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(session.currentAccountKey).toBe(ACCOUNT_KEY);
	});

	test('a page whose discovery names an API on another origin never sends the token anywhere', async () => {
		seedPreviousReleaseMirror();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery(
			{[DISCOVERY_URL]: discoveryDocument('https://elsewhere.test/api', 'current')},
			{id: USER_ID},
			currentUserRequests,
		);

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(false);
		expect(currentUserRequests).toEqual([]);
		expect(await readAccountRecord()).toBeNull();
		expectMirrorIntact();
		const discoveryFailure = loggedErrors().find((error) => error.name === 'InstanceDiscoveryUnreachableError');
		expect(describeLogged(discoveryFailure)).toContain('declared an API at https://elsewhere.test/api');
	});

	test('the desktop 1.0.9 shell (remote micup document, no desktop storage bridge) takes the same path', async () => {
		Object.defineProperty(window, 'electron', {
			value: {platform: 'win32', capabilities: {}},
			configurable: true,
			writable: true,
		});
		seedPreviousReleaseMirror();
		serveDiscovery({[DISCOVERY_URL]: discoveryDocument(API_ENDPOINT, 'current')}, {id: USER_ID});

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(session.currentAccountKey).toBe(ACCOUNT_KEY);
		expect((await readAccountRecord())?.storageKey).toBe(ACCOUNT_KEY);
	});

	test('a localhost preview page in front of a previous-release API adopts the mirror for its own origin', async () => {
		setDocumentUrl('http://localhost:5430/channels/@me');
		const previewApi = 'http://localhost:5430/api';
		seedPreviousReleaseMirror();
		const currentUserRequests: Array<CurrentUserRequest> = [];
		serveDiscovery(
			{'http://localhost:5430/.well-known/fluxer': discoveryDocument(previewApi, 'previous')},
			{id: USER_ID},
			currentUserRequests,
		);

		const {session, initializationError} = await bootWebClient();

		expect(initializationError).toBeNull();
		expect(session.isAuthenticated).toBe(true);
		expect(session.currentAccountKey).toBe(`${previewApi}::${USER_ID}`);
		expect(currentUserRequests.map((request) => request.url)).toEqual([`${previewApi}/v1/users/@me`]);
	});
});

describe('the stored account resolver after it adopted the raw credential', () => {
	test('keeps its conflict retry for a record another tab rewrote in the meantime', async () => {
		const {AuthSessionStoredAccountResolver} = await import(
			'@app/features/platform/state/auth_session/AuthSessionStoredAccountResolver'
		);
		const {StoredAccountInventoryReplacementConflictError} = await import(
			'@app/features/auth/state/StoredAccountInventoryContract'
		);
		const {FIXTURE_CURRENT_INSTANCE_KEY, FIXTURE_CURRENT_INSTANCE_SNAPSHOT, FIXTURE_NOW} = await import(
			'@app/features/auth/state/__fixtures__/AccountRecordFixtures'
		);
		const storageKey = `${FIXTURE_CURRENT_INSTANCE_KEY}::${USER_ID}`;
		const inventoryWith = (token: string | null): StoredAccountInventory => ({
			source: 'idb',
			readyEntries:
				token === null
					? []
					: [
							{
								kind: 'ready',
								record: {
									userId: USER_ID,
									token,
									presenceIntent: null,
									localStorageData: {},
									managedStorageData: {},
									lastActive: FIXTURE_NOW,
									instance: FIXTURE_CURRENT_INSTANCE_SNAPSHOT,
									storageKey,
								},
								revision: {kind: 'stored-account-revision'},
							},
						],
			runtimeRecoveryCandidates: [],
			unqualifiedRecords: [],
			unavailableRecords: [],
		});
		// Before the adoption: no record. Then another tab's record with its own token, twice, then the replaced one.
		const inventories = [inventoryWith(null), inventoryWith('other-tab-token'), inventoryWith('other-tab-token')];
		let replacements = 0;
		const resolver = new AuthSessionStoredAccountResolver({
			accountStorage: {
				getAccountInventory: async () => inventories.shift() ?? inventoryWith(TOKEN),
				replaceInventoryEntry: async ({replacement}) => {
					replacements += 1;
					if (replacements === 1) {
						throw new StoredAccountInventoryReplacementConflictError(storageKey, 'Another tab replaced the record');
					}
					return replacement;
				},
			},
			resolveRuntimeEndpoint: async () => {
				throw new Error('resolveRuntimeEndpoint must not be reached');
			},
			adoptLegacyCredential: async () => 'adopted',
		});

		const restoration = await resolver.resolveActiveRestoration({storageKey: null, userId: USER_ID, token: TOKEN});

		expect(restoration.kind).toBe('resolved');
		expect(replacements).toBe(2);
	});
});
