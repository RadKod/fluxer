// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'}}),
}));
const limits = vi.hoisted((): Record<string, number> => ({}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {resolve: ({key}: {key: string}) => limits[key] ?? 1},
}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({createPost: vi.fn(async () => 'ok')}));
vi.mock('@app/features/feed/components/FeedItemMenu', () => ({toastFeedFailure: vi.fn()}));
// The pickers themselves are covered in FeedExpressionButtons.test.tsx; here one button adds an emoji to the draft
// and the other picks one GIF.
const GIF = vi.hoisted(() => ({id: 'cat-1', slug: 'cat-1', provider: 'klipy'}));
vi.mock('@app/features/feed/components/FeedExpressionButtons', () => ({
	FeedExpressionButtons: ({
		value,
		onChange,
		onGif,
		gifDisabled,
	}: {
		value: string;
		onChange: (value: string) => void;
		onGif: (gif: unknown) => void;
		gifDisabled: boolean;
	}) => [
		createElement('button', {
			key: 'emoji',
			type: 'button',
			'aria-label': 'Open emoji picker',
			onClick: () => onChange(`${value}😀`),
		}),
		createElement('button', {
			key: 'gif',
			type: 'button',
			'aria-label': 'Choose a GIF',
			disabled: gifDisabled,
			onClick: () => onGif(GIF),
		}),
	],
}));
const gifFile = vi.hoisted(() => new File(['g'], 'cat-1.gif', {type: 'image/gif'}));
vi.mock('@app/features/expressions/utils/GifFileDownload', () => ({
	downloadGifAsImageFile: vi.fn(async () => gifFile),
}));
vi.mock('@app/features/feed/commands/FeedVideoCommands', () => ({
	postVideo: vi.fn(async () => 'ok'),
	cancelVideo: vi.fn(async () => 'ok'),
	watchPending: vi.fn(() => () => {}),
}));
vi.mock('@app/features/messaging/utils/FilePickerUtils', () => ({openFilePicker: vi.fn(async () => [])}));
vi.mock('@app/features/messaging/utils/FileUtils', () => ({formatFileSize: () => '10 MB'}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled}, children),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({error: vi.fn(), success: vi.fn()}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({user}: {user: {id: string}}) => createElement('span', {'data-avatar-user': user.id}),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Textarea: ({
		'aria-label': label,
		value,
		onChange,
		onPaste,
	}: {
		'aria-label': string;
		value?: string;
		onChange?: (event: unknown) => void;
		onPaste?: (event: unknown) => void;
	}) => createElement('textarea', {'aria-label': label, value, onChange, onPaste}),
	Input: (props: Record<string, unknown>) => createElement('input', props),
}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({
	Combobox: ({label}: {label: string}) => createElement('select', {'aria-label': label}),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
// The real Tooltip gives its child a ref and props, which only a DOM element (or a component passing them on) takes:
// the mock keeps each Tooltip's child by its text so a test can check what the Tooltip wraps.
const tooltipChildren = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({
	Tooltip: ({text, children}: {text: string; children: ReactNode}) => {
		tooltipChildren.set(text, children);
		return children;
	},
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
const account = vi.hoisted(() => ({currentUserId: '1' as string | null}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: account}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: async () => {}}));
const privacy = vi.hoisted(() => ({level: 0 as number, hydrated: true}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {getProfilePrivacy: () => privacy.level, isHydrated: () => privacy.hydrated},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {currentUser: {id: '1', maxAttachmentFileSize: 30_000_000}},
}));

const {default: FeedTabs} = await import('@app/features/feed/state/FeedTabs');
const {FeedComposer} = await import('@app/features/feed/components/FeedComposer');
const {createPost} = await import('@app/features/feed/commands/FeedCommands');
const {toastFeedFailure} = await import('@app/features/feed/components/FeedItemMenu');
const FeedVideoCommands = await import('@app/features/feed/commands/FeedVideoCommands');
const {default: PendingVideos} = await import('@app/features/feed/state/FeedPendingVideos');
const {openFilePicker} = await import('@app/features/messaging/utils/FilePickerUtils');
const {downloadGifAsImageFile} = await import('@app/features/expressions/utils/GifFileDownload');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');

const PUBLIC_HINT = 'Anyone with the link can see it, and it can show up in Discover';

describe('FeedComposer', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		for (const key of Object.keys(limits)) delete limits[key];
		vi.clearAllMocks();
		tooltipChildren.clear();
		(MobileLayout as {enabled: boolean}).enabled = false;
		privacy.level = ProfilePrivacyLevels.ALL_GUILDS;
		privacy.hydrated = true;
		PendingVideos.reset();
		FeedTabs.setComposerDraft(null);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const button = (label: string) =>
		Array.from(container.querySelectorAll('button')).find(
			(element) => element.getAttribute('aria-label') === label || element.textContent === label,
		) as HTMLButtonElement | undefined;
	const click = async (element: Element | null | undefined) => {
		expect(element).toBeTruthy();
		await act(async () => (element as HTMLElement).click());
	};
	const type = (element: Element | null | undefined, value: string) =>
		act(() => {
			const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
			Object.getOwnPropertyDescriptor(prototype.prototype, 'value')!.set!.call(element, value);
			element!.dispatchEvent(new Event('input', {bubbles: true}));
		});
	const textBox = () => container.querySelector('textarea');
	const video = (name = 'clip.mp4') => new File(['v'], name, {type: 'video/mp4'});

	it('shows your avatar, then an icon-only "Add images" button before the Post button', () => {
		act(() => root.render(createElement(FeedComposer)));
		expect(container.querySelector('[data-avatar-user="1"]')).not.toBeNull();
		const addImages = container.querySelector('button[aria-label="Add images"]');
		expect(addImages).not.toBeNull();
		expect(addImages!.textContent).toBe('');
		const post = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Post');
		expect(addImages!.compareDocumentPosition(post!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('posts the emoji picked from the toolbar with the text', async () => {
		act(() => root.render(createElement(FeedComposer)));
		type(textBox(), 'Hello ');
		await click(button('Open emoji picker'));
		await click(button('Post'));
		expect(createPost).toHaveBeenLastCalledWith('Hello 😀', [], {poll: null});
	});

	it('adds a picked GIF as one of the post images, downloaded through the media proxy', async () => {
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Choose a GIF'));
		expect(downloadGifAsImageFile).toHaveBeenCalledWith(GIF);
		expect(container.querySelector('img[alt="cat-1.gif"]')).not.toBeNull();
		await click(button('Post'));
		expect(createPost).toHaveBeenLastCalledWith('', [gifFile], {poll: null});
	});

	it('says so when the GIF cannot be fetched', async () => {
		vi.mocked(downloadGifAsImageFile).mockRejectedValueOnce(new Error('offline'));
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Choose a GIF'));
		expect(ToastCommands.error).toHaveBeenCalledWith('Something went wrong');
		expect(container.querySelector('img')).toBeNull();
	});

	it('takes no GIF next to a poll, like images', async () => {
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Add poll'));
		expect(button('Choose a GIF')?.disabled).toBe(true);
	});

	// The GIF lands after its download; what the draft holds by then counts, not what it held at the click.
	const slowGif = () => {
		let finish: () => void = () => {};
		vi.mocked(downloadGifAsImageFile).mockImplementationOnce(
			() =>
				new Promise<File>((resolve) => {
					finish = () => resolve(gifFile);
				}),
		);
		return async () => act(async () => finish());
	};

	it('keeps an image added while the GIF downloads, next to the GIF', async () => {
		const image = new File(['i'], 'photo.png', {type: 'image/png'});
		vi.mocked(openFilePicker).mockResolvedValueOnce([image]);
		const finish = slowGif();
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Choose a GIF'));
		await click(button('Add images'));
		await finish();
		await click(button('Post'));
		expect(createPost).toHaveBeenLastCalledWith('', [image, gifFile], {poll: null});
	});

	it('takes no second GIF while one downloads', async () => {
		const finish = slowGif();
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Choose a GIF'));
		expect(button('Choose a GIF')?.disabled).toBe(true);
		await finish();
		expect(button('Choose a GIF')?.disabled).toBe(false);
	});

	it('drops the GIF when a poll was added while it downloaded', async () => {
		const finish = slowGif();
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Choose a GIF'));
		await click(button('Add poll'));
		await finish();
		expect(container.querySelector('img')).toBeNull();
	});

	const publicSwitch = () => container.querySelector('[role="switch"]');
	const remount = () => {
		act(() => root.unmount());
		FeedTabs.setComposerDraft(null);
		root = createRoot(container);
	};

	// The box has no Public switch or its hint, on either layout, with Discover on or off.
	it('has no switch to make a post public', () => {
		for (const discover of [1, 0]) {
			limits.feature_feed_discover = discover;
			for (const phone of [false, true]) {
				(MobileLayout as {enabled: boolean}).enabled = phone;
				act(() => root.render(createElement(FeedComposer)));
				expect(publicSwitch()).toBeNull();
				expect(container.textContent).not.toContain('Public');
				expect(container.textContent).not.toContain(PUBLIC_HINT);
				expect(tooltipChildren.has(PUBLIC_HINT)).toBe(false);
				remount();
			}
		}
	});

	// Micup: the server sets the public bit from the author's profile visibility, so the box sends the same
	// request at every level, before the settings load too, and never a public field.
	it('sends posts and videos without a public field at every profile visibility', async () => {
		for (const level of [
			ProfilePrivacyLevels.EVERYONE,
			ProfilePrivacyLevels.ALL_GUILDS,
			ProfilePrivacyLevels.SMALL_GUILDS_ONLY,
			ProfilePrivacyLevels.FRIENDS_ONLY,
			ProfilePrivacyLevels.ONLY_ME,
		]) {
			privacy.level = level;
			privacy.hydrated = level !== ProfilePrivacyLevels.ALL_GUILDS;
			act(() => root.render(createElement(FeedComposer)));
			type(textBox(), 'Hello');
			await click(button('Post'));
			expect(createPost).toHaveBeenLastCalledWith('Hello', [], {poll: null});
			const clip = video();
			vi.mocked(openFilePicker).mockResolvedValueOnce([clip]);
			await click(button('Add video'));
			await click(button('Post'));
			expect(FeedVideoCommands.postVideo).toHaveBeenLastCalledWith(clip, {content: ''});
			remount();
		}
	});

	// A kept box from when there was a switch goes out like any other.
	it('sends a kept draft that held the old switch off without a public field', async () => {
		const kept = {userId: '1', text: 'Kept', files: [], poll: null, isPublic: false};
		FeedTabs.setComposerDraft(kept);
		act(() => root.render(createElement(FeedComposer)));
		expect(textBox()!.value).toBe('Kept');
		await click(button('Post'));
		expect(createPost).toHaveBeenLastCalledWith('Kept', [], {poll: null});
	});

	it('confirms a new post with a toast only when asked, as Discover does not list your own posts', async () => {
		act(() => root.render(createElement(FeedComposer)));
		type(textBox(), 'Hello');
		await click(button('Post'));
		expect(ToastCommands.success).not.toHaveBeenCalled();

		act(() => root.render(createElement(FeedComposer, {announcePosted: true})));
		type(textBox(), 'Hello again');
		await click(button('Post'));
		expect(ToastCommands.success).toHaveBeenCalledExactlyOnceWith('Sent');

		vi.mocked(createPost).mockResolvedValueOnce('failed');
		type(textBox(), 'Not sent');
		await click(button('Post'));
		expect(ToastCommands.success).toHaveBeenCalledTimes(1);
		expect(toastFeedFailure).toHaveBeenLastCalledWith(expect.anything(), 'failed');
	});

	it('adds a poll, needs text for it and disables media while it is open', async () => {
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Add poll'));
		expect(button('Add poll')).toBeUndefined();
		expect(button('Remove poll')).toBeDefined();
		expect(button('Add images')?.disabled).toBe(true);
		expect(button('Add video')?.disabled).toBe(true);
		const options = () => Array.from(container.querySelectorAll('input[aria-label="Option {number}"]'));
		expect(options()).toHaveLength(2);
		type(options()[0], ' Tea ');
		type(options()[1], 'Coffee');
		expect(button('Post')?.disabled).toBe(true);
		type(textBox(), 'Tea or coffee?');
		expect(button('Post')?.disabled).toBe(false);
		type(options()[1], 'tea');
		expect(button('Post')?.disabled).toBe(true);
		type(options()[1], 'Coffee');
		await click(button('Post'));
		expect(createPost).toHaveBeenLastCalledWith('Tea or coffee?', [], {
			poll: {options: ['Tea', 'Coffee'], durationHours: 24},
		});
		expect(button('Add poll')).toBeDefined();
		expect(options()).toHaveLength(0);

		await click(button('Add poll'));
		await click(button('Remove poll'));
		expect(options()).toHaveLength(0);
		expect(button('Add images')?.disabled).toBe(false);
	});

	it('hides the video button while feature_feed_video is 0', () => {
		limits.feature_feed_video = 0;
		act(() => root.render(createElement(FeedComposer)));
		expect(button('Add images')).toBeDefined();
		expect(button('Add video')).toBeUndefined();
	});

	it('refuses a file over 500 MB or of another type before any request', async () => {
		const big = video('long.mov');
		Object.defineProperty(big, 'size', {value: 524_288_001});
		vi.mocked(openFilePicker)
			.mockResolvedValueOnce([big])
			.mockResolvedValueOnce([new File(['a'], 'clip.avi', {type: 'video/x-msvideo'})]);
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Add video'));
		expect(openFilePicker).toHaveBeenCalledWith({
			accept: 'video/mp4,video/webm,video/quicktime,video/x-matroska,.mov,.mkv',
		});
		expect(ToastCommands.error).toHaveBeenLastCalledWith('A video must be {maxSize} or smaller.');
		await click(button('Add video'));
		expect(ToastCommands.error).toHaveBeenLastCalledWith('Only MP4, WebM, MOV and MKV videos can be added to a post.');
		expect(container.querySelector('video')).toBeNull();
		expect(button('Post')?.disabled).toBe(true);
		expect(FeedVideoCommands.postVideo).not.toHaveBeenCalled();
		expect(createPost).not.toHaveBeenCalled();
	});

	// Windows often has no type for .mkv: the browser gives an empty one and the server needs one of its four.
	it('takes an MKV the browser gives no type and sends it as Matroska', async () => {
		vi.mocked(openFilePicker).mockResolvedValueOnce([new File(['v'], 'match.mkv', {type: ''})]);
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Add video'));
		expect(ToastCommands.error).not.toHaveBeenCalled();
		expect(container.querySelector('video')).not.toBeNull();
		await click(button('Post'));
		const [sent] = vi.mocked(FeedVideoCommands.postVideo).mock.lastCall!;
		expect([sent.name, sent.type]).toEqual(['match.mkv', 'video/x-matroska']);
	});

	it('a video disables images and poll and goes out through the video upload', async () => {
		const clip = video('clip.mov');
		vi.mocked(openFilePicker).mockResolvedValueOnce([clip]);
		act(() => root.render(createElement(FeedComposer)));
		await click(button('Add video'));
		const preview = container.querySelector('video');
		expect(preview).not.toBeNull();
		expect(preview!.muted).toBe(true);
		expect(button('Add images')?.disabled).toBe(true);
		expect(button('Add poll')?.disabled).toBe(true);
		expect(button('Add video')?.disabled).toBe(true);
		expect(button('Remove video')).toBeDefined();
		type(textBox(), 'Ace on B');
		await click(button('Post'));
		expect(FeedVideoCommands.postVideo).toHaveBeenLastCalledWith(clip, {content: 'Ace on B'});
		expect(createPost).not.toHaveBeenCalled();
		expect(textBox()!.value).toBe('');
		expect(container.querySelector('video')).toBeNull();
		expect(button('Add poll')?.disabled).toBe(false);
	});

	it('shows uploading then processing rows and cancels one', async () => {
		const clip = video('ace_bind_a_site.mp4');
		vi.mocked(openFilePicker).mockResolvedValueOnce([clip]);
		vi.mocked(FeedVideoCommands.postVideo).mockImplementationOnce(async (file) => {
			PendingVideos.handleUploadStarted('v1', file);
			return 'ok';
		});
		vi.mocked(FeedVideoCommands.cancelVideo).mockImplementationOnce(async (videoId) => {
			PendingVideos.handleRemoved(videoId);
			return 'ok';
		});
		act(() => root.render(createElement(FeedComposer)));
		expect(FeedVideoCommands.watchPending).toHaveBeenCalledTimes(1);
		await click(button('Add video'));
		await click(button('Post'));
		const row = () => container.querySelector('li');
		expect(row()!.textContent).toContain('ace_bind_a_site.mp4');
		expect(row()!.textContent).toContain('Uploading · {percent}% · posted when ready');
		act(() => PendingVideos.handleUploaded('v1'));
		expect(row()!.textContent).toContain('Processing · posted when ready');
		// The post box is free for the next post meanwhile.
		expect(button('Add video')?.disabled).toBe(false);
		await click(button('Cancel video'));
		expect(FeedVideoCommands.cancelVideo).toHaveBeenCalledWith('v1');
		expect(row()).toBeNull();
	});

	// The feed list and its post box make way for a post page; what you were writing waits for you, not for another
	// account on this device.
	it('keeps what you were writing when it comes back, for the same account only', async () => {
		const clip = video('clip.mov');
		vi.mocked(openFilePicker).mockResolvedValueOnce([clip]);
		act(() => root.render(createElement(FeedComposer)));
		type(textBox(), 'Half a thought');
		await click(button('Add video'));
		act(() => root.unmount());

		root = createRoot(container);
		act(() => root.render(createElement(FeedComposer)));
		expect(textBox()!.value).toBe('Half a thought');
		expect(container.querySelector('video')).not.toBeNull();
		act(() => root.unmount());

		account.currentUserId = '2';
		root = createRoot(container);
		act(() => root.render(createElement(FeedComposer)));
		expect(textBox()!.value).toBe('');
		expect(container.querySelector('video')).toBeNull();
		act(() => root.unmount());

		// Kept for the account that wrote it, also when the account changes while the box is up.
		account.currentUserId = '1';
		root = createRoot(container);
		act(() => root.render(createElement(FeedComposer)));
		type(textBox(), 'For account 1 only');
		account.currentUserId = '2';
		act(() => root.unmount());
		root = createRoot(container);
		act(() => root.render(createElement(FeedComposer)));
		expect(textBox()!.value).toBe('');
		account.currentUserId = '1';
	});

	it('shows no video rows while feature_feed_video is 0', () => {
		limits.feature_feed_video = 0;
		PendingVideos.handleUploadStarted('v1', video());
		act(() => root.render(createElement(FeedComposer)));
		expect(container.querySelector('li')).toBeNull();
		expect(FeedVideoCommands.watchPending).not.toHaveBeenCalled();
	});
});
