// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildLike} from '@app/features/guild/components/modals/guild_tabs/guild_overview_tab/GuildOverviewTypes';
import type {FormInputs} from '@app/features/guild/utils/guild_tabs/GuildOverviewTabUtils';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {act, type ReactNode, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {type UseFormReturn, useForm} from 'react-hook-form';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
	source: vi.fn(),
	picker: vi.fn(),
	inspect: vi.fn(),
	downloadGif: vi.fn(),
	base64: vi.fn(),
	push: vi.fn(),
	error: vi.fn(),
	readCrop: vi.fn(),
	createUrl: vi.fn(),
	revokeUrl: vi.fn(),
}));
const i18n = vi.hoisted(() => ({
	locale: 'en',
	_: (descriptor: string | {message: string}, values: Record<string, unknown> = {}) => {
		const message = typeof descriptor === 'string' ? descriptor : descriptor.message;
		return message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/premium/utils/PremiumUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/premium/utils/PremiumUtils')>()),
	getPremiumProductName: () => 'sanalyer Plus',
}));
vi.mock('@app/features/accessibility/state/Accessibility', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/accessibility/state/Accessibility')>()),
	default: {useReducedMotion: false, isAnimationKeptUnderReducedMotion: () => false},
}));
vi.mock('@app/features/app/hooks/useSaveData', () => ({useSaveData: () => false}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getGifAutoPlay: () => false}}));
vi.mock('@app/features/messaging/utils/ImageCacheUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/messaging/utils/ImageCacheUtils')>()),
	loadImage: (_url: string, onLoad: () => void) => {
		onLoad();
		return () => {};
	},
}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({
	fileToBase64: mocks.base64,
	parseAvatarHash: (value: string) => ({animated: value.startsWith('a_'), hash: value.replace(/^a_/, '')}),
	getGuildIconURL: ({icon}: {icon: string | null}, animated = false) =>
		icon ? `${animated && icon.startsWith('a_') ? 'animated' : 'static'}:icon:${icon.replace(/^a_/, '')}` : null,
	getGuildBannerURL: ({banner}: {banner: string | null}, animated = false) =>
		banner
			? `${animated && banner.startsWith('a_') ? 'animated' : 'static'}:banner:${banner.replace(/^a_/, '')}`
			: null,
	getGuildSplashURL: () => 'static:splash',
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		small: _small,
		variant: _variant,
		...props
	}: {
		children: ReactNode;
		small?: boolean;
		variant?: string;
	}) => (
		<button type="button" {...props}>
			{children}
		</button>
	),
}));
vi.mock('@app/features/expressions/components/modals/AssetCropModal', () => ({
	AssetType: {GUILD_ICON: 'guild_icon', GUILD_BANNER: 'guild_banner', SPLASH: 'splash'},
	getAssetConfig: () => ({minWidth: 480, minHeight: 270, aspectRatio: 16 / 9}),
	AssetCropModal: () => null,
}));
vi.mock('@app/features/expressions/components/modals/AssetSourceModal', () => ({openAssetSourceModal: mocks.source}));
vi.mock('@app/features/messaging/utils/FilePickerUtils', () => ({openFilePicker: mocks.picker}));
vi.mock('@app/features/expressions/utils/AnimatedImageUtils', () => ({inspectImageFile: mocks.inspect}));
vi.mock('@app/features/expressions/utils/GifFileDownload', () => ({downloadGifAsImageFile: mocks.downloadGif}));
vi.mock('@app/features/expressions/utils/AnimatedAvifModalUtils', () => ({showAnimatedAvifUnsupportedModal: vi.fn()}));
vi.mock('@app/features/platform/utils/ImageDecoderInterop', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/platform/utils/ImageDecoderInterop')>()),
	canDecodeAnimatedAvif: async () => true,
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({modal: (render: unknown) => render, push: mocks.push}));
vi.mock('@app/features/app/components/alerts/GenericErrorModalCommands', () => ({showGenericErrorModal: mocks.error}));
vi.mock('@app/features/platform/utils/BlobDataUrl', async (original) => {
	const actual = await original<typeof import('@app/features/platform/utils/BlobDataUrl')>();
	// The crop path reads the cropped blob through readBlobAsDataUrl; the source file read keeps the real helper.
	return {
		...actual,
		readBlobAsDataUrl: (blob: Blob) => (blob instanceof File ? actual.readBlobAsDataUrl(blob) : mocks.readCrop(blob)),
	};
});

const {GuildIconUploadField} = await import('./GuildIconUploadField');
const {GuildBannerUploadField} = await import('./GuildBannerUploadField');
const {GuildInviteSplashUploadField} = await import('./GuildInviteSplashUploadField');
type Kind = 'icon' | 'banner' | 'splash';
const tips = {
	icon: 'Boost to Level 1 to upload animated icons.',
	banner: 'Boost to Level 3 to upload animated banners.',
};
const featuresAtLevel = [
	[],
	[GuildFeatures.BOOST_LEVEL_1, GuildFeatures.ANIMATED_ICON],
	[GuildFeatures.BOOST_LEVEL_1, GuildFeatures.BOOST_LEVEL_2, GuildFeatures.ANIMATED_ICON],
	[
		GuildFeatures.BOOST_LEVEL_1,
		GuildFeatures.BOOST_LEVEL_2,
		GuildFeatures.BOOST_LEVEL_3,
		GuildFeatures.ANIMATED_ICON,
		GuildFeatures.ANIMATED_BANNER,
	],
];
class ViewportObserver {
	static instances: Array<ViewportObserver> = [];
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
	constructor(readonly callback: IntersectionObserverCallback) {
		ViewportObserver.instances.push(this);
	}
	enter(target: Element, visible: boolean) {
		this.callback(
			[{target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0} as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		);
	}
}
let form: UseFormReturn<FormInputs>;
function Field({
	kind,
	features,
	preview = null,
	canManage = true,
}: {
	kind: Kind;
	features: Array<string>;
	preview?: string | null;
	canManage?: boolean;
}) {
	form = useForm<FormInputs>({defaultValues: {name: 'Community'}});
	const [previewUrl, setPreviewUrl] = useState<string | null>(preview);
	const [cleared, setCleared] = useState(false);
	const [ratio, setRatio] = useState<number>();
	const guild: GuildLike = {
		id: '42',
		name: 'Community',
		icon: 'a_icon',
		banner: 'a_banner',
		splash: 'splash',
		features: new Set(features),
	};
	const common = {guild, form, canManageGuild: canManage};
	if (kind === 'icon')
		return (
			<GuildIconUploadField
				{...common}
				previewIconUrl={previewUrl}
				setPreviewIconUrl={setPreviewUrl}
				hasClearedIcon={cleared}
				setHasClearedIcon={setCleared}
			/>
		);
	const aspect = {computeAspectRatioFromBase64: async () => 16 / 9};
	if (kind === 'banner')
		return (
			<GuildBannerUploadField
				{...common}
				{...aspect}
				previewBannerUrl={previewUrl}
				setPreviewBannerUrl={setPreviewUrl}
				hasClearedBanner={cleared}
				setHasClearedBanner={setCleared}
				bannerAspectRatio={ratio}
				setBannerAspectRatio={setRatio}
			/>
		);
	return (
		<GuildInviteSplashUploadField
			{...common}
			{...aspect}
			previewSplashUrl={previewUrl}
			setPreviewSplashUrl={setPreviewUrl}
			hasClearedSplash={cleared}
			setHasClearedSplash={setCleared}
			splashAspectRatio={ratio}
			setSplashAspectRatio={setRatio}
		/>
	);
}

describe('community boost asset locks', () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
		vi.stubGlobal('IntersectionObserver', undefined);
		ViewportObserver.instances = [];
		Object.defineProperty(document, 'hidden', {configurable: true, value: false});
		document.documentElement.classList.add('window-focused');
		mocks.inspect.mockResolvedValue({format: 'png', animated: false});
		mocks.base64.mockResolvedValue('data:image/png;base64,c291cmNl');
		mocks.readCrop.mockResolvedValue('data:image/png;base64,Y3JvcA==');
		mocks.createUrl.mockReturnValue('blob:preview');
		vi.spyOn(URL, 'createObjectURL').mockImplementation(mocks.createUrl);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(mocks.revokeUrl);
		host = document.createElement('div');
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		document.documentElement.classList.remove('window-focused');
		Object.defineProperty(document, 'hidden', {configurable: true, value: false});
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	const render = async (kind: Kind, features: Array<string> = [], preview: string | null = null, canManage = true) => {
		await act(async () =>
			root.render(<Field kind={kind} features={features} preview={preview} canManage={canManage} />),
		);
	};
	const click = async (text: string) => {
		const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === text)!;
		expect(button.disabled).toBe(false);
		await act(async () => button.click());
	};
	const upload = async (kind: Kind, file = new File(['image'], 'image.png', {type: 'image/png'})) => {
		await click(kind === 'icon' ? 'Upload icon' : kind === 'banner' ? 'Upload banner' : 'Upload background');
		mocks.picker.mockResolvedValueOnce([file]);
		await act(async () => mocks.source.mock.lastCall![0].onPickUpload());
	};
	const crop = () => mocks.push.mock.lastCall![0]().props;

	it.each((['icon', 'banner'] as const).flatMap((kind) => [0, 1, 2, 3].map((level) => ({kind, level}))))(
		'shows the $kind lock only below its level in S$level',
		async ({kind, level}) => {
			await render(kind, featuresAtLevel[level]);
			const unlocked = kind === 'icon' ? level >= 1 : level >= 3;
			expect(host.textContent?.includes(tips[kind])).toBe(!unlocked);
			await click(kind === 'icon' ? 'Upload icon' : 'Upload banner');
			expect(mocks.source.mock.lastCall![0].showGifOption).toBe(unlocked);
		},
	);
	it.each(['icon', 'banner'] as const)('keeps grandfather S0 %s animation unlocked', async (kind) => {
		await render(kind, [kind === 'icon' ? GuildFeatures.ANIMATED_ICON : GuildFeatures.ANIMATED_BANNER]);
		expect(host.textContent).not.toContain(tips[kind]);
		mocks.inspect.mockResolvedValueOnce({format: 'gif', animated: true});
		await upload(kind, new File(['GIF'], 'legacy.gif', {type: 'image/gif'}));
		expect(mocks.source.mock.lastCall![0].showGifOption).toBe(true);
		expect(mocks.picker.mock.lastCall![0].accept).toContain('image/gif');
		expect(mocks.push).toHaveBeenCalledOnce();
		expect(mocks.error).not.toHaveBeenCalled();
	});
	it.each((['icon', 'banner', 'splash'] as const).flatMap((kind) => [0, 1, 2, 3].map((level) => ({kind, level}))))(
		'keeps static $kind upload and clear available at S$level',
		async ({kind, level}) => {
			await render(kind, featuresAtLevel[level]);
			await upload(kind);
			await act(async () => crop().onCropComplete(new Blob(['crop'], {type: 'image/png'})));
			expect(form.getValues(kind)).toBe('data:image/png;base64,Y3JvcA==');
			await click('Remove');
			expect(form.getValues(kind)).toBeNull();
			expect(host.textContent).not.toContain('Remove');
			expect(mocks.revokeUrl).toHaveBeenCalledWith('blob:preview');
		},
	);
	it.each(['icon', 'banner'] as const)(
		'rejects inspected animated %s bytes despite a static extension',
		async (kind) => {
			await render(kind);
			mocks.inspect.mockResolvedValueOnce({format: 'gif', animated: true});
			await upload(kind);
			expect(mocks.error.mock.lastCall![0].message).toBe(tips[kind]);
			expect(mocks.push).not.toHaveBeenCalled();
			expect(form.getValues(kind)).toBeUndefined();
		},
	);
	it.each(['icon', 'banner'] as const)('uses current features rather than level markers for %s', async (kind) => {
		await render(kind, [GuildFeatures.BOOST_LEVEL_1, GuildFeatures.BOOST_LEVEL_2, GuildFeatures.BOOST_LEVEL_3]);
		expect(host.textContent).toContain(tips[kind]);
	});
	it.each(['icon', 'banner'] as const)('displays a form API error while keeping %s clear available', async (kind) => {
		await render(kind);
		await act(async () =>
			form.setError(kind, {type: 'server', message: 'Animation is no longer available. Try a static image.'}),
		);
		expect(host.textContent).toContain('Animation is no longer available. Try a static image.');
		await click('Remove');
		expect(host.textContent).not.toContain('Animation is no longer available.');
	});
	it('keeps crop processing failure recoverable', async () => {
		await render('banner', [GuildFeatures.ANIMATED_BANNER]);
		await upload('banner');
		mocks.readCrop.mockRejectedValueOnce(new Error('decode failed'));
		await act(async () => crop().onCropComplete(new Blob(['crop'])));
		expect(mocks.error.mock.lastCall![0].message).toBe('Failed to process the cropped image. Try again.');
		expect(form.getValues('banner')).toBeUndefined();
		await click('Remove');
	});
	it('reports GIF download failure through the existing image error path', async () => {
		await render('icon', [GuildFeatures.ANIMATED_ICON]);
		await click('Upload icon');
		mocks.downloadGif.mockRejectedValueOnce(new Error('offline'));
		await act(async () => mocks.source.mock.lastCall![0].onSelectGif({}));
		expect(mocks.error.mock.lastCall![0].message).toBe('That image is invalid. Try another one.');
		expect(mocks.push).not.toHaveBeenCalled();
	});
	it('keeps the existing management permission gate', async () => {
		await render('banner', featuresAtLevel[3], null, false);
		expect([...host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
	});
	it('starts an existing banner statically, plays on keyboard focus, and stops when hidden', async () => {
		await render('banner', [GuildFeatures.ANIMATED_BANNER]);
		expect(host.querySelector('img')?.getAttribute('src')).toBe('static:banner:banner');
		await act(async () => host.querySelector('button')!.focus());
		expect(host.querySelector('img')?.getAttribute('src')).toBe('animated:banner:banner');
		await act(async () => {
			Object.defineProperty(document, 'hidden', {configurable: true, value: true});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(host.querySelector('img')?.getAttribute('src')).toBe('static:banner:banner');
	});
	it('plays the existing banner on hover and stops after hover ends', async () => {
		await render('banner', [GuildFeatures.ANIMATED_BANNER]);
		const preview = host.firstElementChild as HTMLElement;
		vi.spyOn(preview, 'matches').mockImplementation((selector) => selector === ':hover');
		await act(async () => {
			preview.dispatchEvent(new MouseEvent('mouseenter'));
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		expect(host.querySelector('img')?.getAttribute('src')).toBe('animated:banner:banner');
		await act(async () => preview.dispatchEvent(new MouseEvent('mouseleave')));
		expect(host.querySelector('img')?.getAttribute('src')).toBe('static:banner:banner');
	});
	it('stops a hovered existing icon when hidden and disposes its shared visibility subscription', async () => {
		const remove = vi.spyOn(document, 'removeEventListener');
		await render('icon', [GuildFeatures.ANIMATED_ICON]);
		const icon = host.querySelector<HTMLElement>('[data-flx="guild.guild-icon.container"]')!;
		vi.spyOn(icon, 'matches').mockImplementation((selector) => selector === ':hover');
		await act(async () => {
			icon.dispatchEvent(new MouseEvent('mouseenter'));
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		expect(icon.style.getPropertyValue('--guild-icon-image')).toContain('animated:icon:icon');
		await act(async () => {
			Object.defineProperty(document, 'hidden', {configurable: true, value: true});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(icon.style.getPropertyValue('--guild-icon-image')).toContain('static:icon:icon');
		act(() => root.render(null));
		expect(remove.mock.calls.map(([name]) => name)).toContain('visibilitychange');
	});
	it.each(['icon', 'banner'] as const)('detaches a local %s preview while the document is hidden', async (kind) => {
		await render(kind, featuresAtLevel[3], 'blob:animated-preview');
		expect(host.innerHTML).toContain('blob:animated-preview');
		await act(async () => {
			Object.defineProperty(document, 'hidden', {configurable: true, value: true});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(host.innerHTML).not.toContain('blob:animated-preview');
		act(() => root.render(null));
		expect(mocks.revokeUrl).toHaveBeenCalledWith('blob:animated-preview');
	});
	it.each(
		(['icon', 'banner'] as const).flatMap((kind) =>
			[false, true].flatMap((offscreen) => [0, 3].map((level) => ({kind, offscreen, level}))),
		),
	)(
		'keeps an uploaded static $kind preview when playback is blocked at level $level (offscreen: $offscreen)',
		async ({kind, offscreen, level}) => {
			if (offscreen) vi.stubGlobal('IntersectionObserver', ViewportObserver);
			await render(kind, featuresAtLevel[level]);
			await upload(kind);
			await act(async () => crop().onCropComplete(new Blob(['crop'], {type: 'image/png'})));
			await act(async () => {
				Object.defineProperty(document, 'hidden', {configurable: true, value: true});
				document.dispatchEvent(new Event('visibilitychange'));
			});
			expect(host.innerHTML).toContain('blob:preview');
			act(() => root.render(null));
			expect(mocks.revokeUrl).toHaveBeenCalledWith('blob:preview');
		},
	);
	it.each(['icon', 'banner'] as const)('stops an uploaded animated %s preview when hidden', async (kind) => {
		await render(kind, featuresAtLevel[3]);
		mocks.inspect.mockResolvedValueOnce({format: 'gif', animated: true});
		await upload(kind, new File(['GIF'], 'animated.gif', {type: 'image/gif'}));
		await act(async () => crop().onCropComplete(new Blob(['GIF'], {type: 'image/gif'})));
		expect(host.innerHTML).toContain('blob:preview');
		await act(async () => {
			Object.defineProperty(document, 'hidden', {configurable: true, value: true});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(host.innerHTML).not.toContain('blob:preview');
	});
	it.each(['icon', 'banner'] as const)(
		'detaches an offscreen local %s preview and releases observation on unmount',
		async (kind) => {
			vi.stubGlobal('IntersectionObserver', ViewportObserver);
			await render(kind, featuresAtLevel[3], 'blob:animated-preview');
			expect(host.innerHTML).not.toContain('blob:animated-preview');
			expect(ViewportObserver.instances).toHaveLength(1);
			const observer = ViewportObserver.instances[0];
			const target = observer.observe.mock.calls[0][0] as Element;
			await act(async () => observer.enter(target, true));
			expect(host.innerHTML).toContain('blob:animated-preview');
			await act(async () => observer.enter(target, false));
			expect(host.innerHTML).not.toContain('blob:animated-preview');
			await act(async () => observer.enter(target, true));
			expect(host.innerHTML).toContain('blob:animated-preview');
			act(() => root.render(null));
			expect(observer.unobserve).toHaveBeenCalledExactlyOnceWith(target);
			expect(observer.disconnect).toHaveBeenCalledOnce();
			expect(mocks.revokeUrl).toHaveBeenCalledWith('blob:animated-preview');
		},
	);
	it('keeps a focused saved banner static while its preview is offscreen', async () => {
		vi.stubGlobal('IntersectionObserver', ViewportObserver);
		await render('banner', [GuildFeatures.ANIMATED_BANNER]);
		await act(async () => host.querySelector('button')!.focus());
		expect(host.querySelector('img')?.getAttribute('src')).toBe('static:banner:banner');
		const observer = ViewportObserver.instances[0];
		const target = observer.observe.mock.calls[0][0] as Element;
		await act(async () => observer.enter(target, true));
		expect(host.querySelector('img')?.getAttribute('src')).toBe('animated:banner:banner');
		await act(async () => observer.enter(target, false));
		expect(host.querySelector('img')?.getAttribute('src')).toBe('static:banner:banner');
	});
	it('shares a single viewport observer between both fields and disconnects after both unmount', async () => {
		vi.stubGlobal('IntersectionObserver', ViewportObserver);
		await act(async () =>
			root.render(
				<>
					<Field kind="icon" features={featuresAtLevel[3]} />
					<Field kind="banner" features={featuresAtLevel[3]} />
				</>,
			),
		);
		expect(ViewportObserver.instances).toHaveLength(1);
		const observer = ViewportObserver.instances[0];
		expect(observer.observe).toHaveBeenCalledTimes(2);
		act(() => root.render(null));
		expect(observer.unobserve).toHaveBeenCalledTimes(2);
		expect(observer.disconnect).toHaveBeenCalledOnce();
	});
});
