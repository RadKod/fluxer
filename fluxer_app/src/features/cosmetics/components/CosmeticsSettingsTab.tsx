// SPDX-License-Identifier: AGPL-3.0-or-later

import {SettingsSection} from '@app/features/app/components/dialogs/shared/SettingsSection';
import {SettingsTabContainer, SettingsTabContent} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import {StatusSlate} from '@app/features/app/components/dialogs/shared/StatusSlate';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import styles from '@app/features/cosmetics/components/CosmeticsSettingsTab.module.css';
import {NameplateBackground} from '@app/features/cosmetics/components/NameplateBackground';
import Cosmetics, {
	VISIBLE_COSMETIC_TYPES,
	type CosmeticItem,
	type CosmeticSelection,
	type CosmeticType,
	isCosmeticLocked,
} from '@app/features/cosmetics/state/Cosmetics';
import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import {
	COSMETIC_MINE_DESCRIPTOR,
	COSMETIC_SEARCH_PLACEHOLDER_DESCRIPTOR,
	COSMETIC_SERIES_COUNT_DESCRIPTOR,
	COSMETIC_SERIES_OTHER_DESCRIPTOR,
	COSMETIC_TYPE_DESCRIPTIONS,
	COSMETIC_TYPE_LABELS,
} from '@app/features/cosmetics/utils/CosmeticLabels';
import {cosmeticMatchesQuery, groupCosmeticsBySeries} from '@app/features/cosmetics/utils/CosmeticSeriesGroups';
import {
	GET_PREMIUM_DESCRIPTOR,
	SOMETHING_WENT_WRONG_DESCRIPTOR,
	TRY_AGAIN_DESCRIPTOR,
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {ComponentBus} from '@app/features/platform/utils/ComponentBus';
import {shouldShowPremiumFeatures} from '@app/features/premium/utils/PremiumUtils';
import {Button} from '@app/features/ui/button/Button';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import * as UnsavedChangesCommands from '@app/features/ui/commands/UnsavedChangesCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import {Spinner} from '@app/features/ui/components/Spinner';
import {Input} from '@app/features/ui/components/form/FormInput';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {ProfilePreview} from '@app/features/user/components/profile/ProfilePreview';
import Users from '@app/features/user/state/Users';
import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {
	CaretDownIcon,
	CaretRightIcon,
	LockSimpleIcon,
	MagnifyingGlassIcon,
	ProhibitIcon,
	WarningIcon,
} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useMemo, useState} from 'react';

// Matches the settings tab type, which is what the unsaved changes bar is keyed by.
const TAB_ID = 'profile_cosmetics';
const TILE_IMAGE_CSS_SIZE = 72;
// sanalyer: up to this many items of a type, every series starts open.
const SMALL_CATALOG_SIZE = 24;

const NONE_DESCRIPTOR = msg({
	message: 'None',
	comment: 'Profile decorations settings: the tile that takes a cosmetic off its slot.',
});
const LOCKED_DESCRIPTOR = msg({
	message: '{name} comes with {premiumProductName}.',
	comment:
		'Profile decorations settings: shown when a Plus-only decoration is picked without Plus. {name} is the decoration name.',
});

function toAssetData(item: CosmeticItem | null): CosmeticAssetDataResponse | null {
	return item ? {asset: item.asset, item_id: item.id} : null;
}

function pendingChanges(draft: CosmeticSelection): CosmeticSelection {
	return Object.fromEntries(
		Object.entries(draft).filter(([type, itemId]) => itemId !== Cosmetics.equippedId(type as CosmeticType)),
	);
}

function openPremiumTab(): void {
	ComponentBus.dispatch('USER_SETTINGS_TAB_SELECT', {tab: 'plutonium'});
}

interface CosmeticTileProps {
	type: CosmeticType;
	item: CosmeticItem | null;
	selected: boolean;
	locked: boolean;
	onSelect: (type: CosmeticType, item: CosmeticItem | null) => void;
}

const CosmeticTile = observer(function CosmeticTile({type, item, selected, locked, onSelect}: CosmeticTileProps) {
	const {i18n} = useLingui();
	const label = item?.name ?? i18n._(NONE_DESCRIPTOR);
	const assetData = toAssetData(item);
	const imageUrl = assetData ? getCosmeticAssetURL(type, assetData, TILE_IMAGE_CSS_SIZE, false) : '';
	return (
		<div className={styles.tileWrapper} data-flx="cosmetics.cosmetics-settings-tab.tile-wrapper">
			<FocusRing offset={-2} data-flx="cosmetics.cosmetics-settings-tab.focus-ring">
				<button
					type="button"
					className={clsx(styles.tile, selected && styles.tileSelected)}
					aria-pressed={selected}
					aria-label={label}
					onClick={() => onSelect(type, item)}
					data-flx="cosmetics.cosmetics-settings-tab.tile"
				>
					{item ? (
						imageUrl && (
							<img
								className={styles.tileImage}
								src={imageUrl}
								alt=""
								draggable={false}
								data-flx="cosmetics.cosmetics-settings-tab.tile-image"
							/>
						)
					) : (
						<ProhibitIcon
							className={styles.noneIcon}
							weight="bold"
							data-flx="cosmetics.cosmetics-settings-tab.none-icon"
						/>
					)}
					{locked && (
						<span className={styles.lockBadge} data-flx="cosmetics.cosmetics-settings-tab.lock-badge">
							<LockSimpleIcon weight="fill" data-flx="cosmetics.cosmetics-settings-tab.lock-icon" />
						</span>
					)}
				</button>
			</FocusRing>
			<span className={styles.tileName} aria-hidden data-flx="cosmetics.cosmetics-settings-tab.tile-name">
				{label}
			</span>
		</div>
	);
});

// sanalyer: the catalog holds ~1650 items, so a type's picker shows "Mine" (worn and owned) open, every series as a
// collapsed group with its count, and items without a series last under "Other". A query flattens the picker to the
// matching items. The "None" tile always leads.
interface CosmeticPickerProps {
	type: CosmeticType;
	items: ReadonlyArray<CosmeticItem>;
	selectedId: string | null;
	isPremium: boolean;
	onSelect: (type: CosmeticType, item: CosmeticItem | null) => void;
}

const CosmeticPicker = observer(function CosmeticPicker({
	type,
	items,
	selectedId,
	isPremium,
	onSelect,
}: CosmeticPickerProps) {
	const {i18n} = useLingui();
	const [query, setQuery] = useState('');
	const groups = useMemo(() => groupCosmeticsBySeries(items), [items]);
	// A small catalog, or one with a single group, shows everything at once as before.
	const [openSlugs, setOpenSlugs] = useState<ReadonlySet<string>>(() =>
		items.length <= SMALL_CATALOG_SIZE || groups.length === 1 ? new Set(groups.map((group) => group.slug)) : new Set(),
	);
	const mine = useMemo(
		() => items.filter((item) => item.owned || item.id === selectedId || item.id === Cosmetics.equippedId(type)),
		[items, selectedId, type],
	);
	const trimmed = query.trim();
	const matches = useMemo(
		() => (trimmed.length === 0 ? [] : items.filter((item) => cosmeticMatchesQuery(item, trimmed))),
		[items, trimmed],
	);
	const tile = (item: CosmeticItem | null) => (
		<CosmeticTile
			key={item?.id ?? 'none'}
			type={type}
			item={item}
			selected={(item?.id ?? null) === selectedId}
			locked={item !== null && isCosmeticLocked(item, isPremium)}
			onSelect={onSelect}
			data-flx="cosmetics.cosmetics-settings-tab.cosmetic-tile"
		/>
	);
	const grid = (list: ReadonlyArray<CosmeticItem | null>, label: string) => (
		<div className={styles.grid} role="group" aria-label={label} data-flx="cosmetics.cosmetics-settings-tab.grid">
			{list.map(tile)}
		</div>
	);
	const toggle = (slug: string) =>
		setOpenSlugs((previous) => {
			const next = new Set(previous);
			if (next.has(slug)) next.delete(slug);
			else next.add(slug);
			return next;
		});
	const typeLabel = i18n._(COSMETIC_TYPE_LABELS[type]);
	return (
		<div className={styles.picker} data-flx="cosmetics.cosmetics-settings-tab.picker">
			{items.length > 0 && (
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={i18n._(COSMETIC_SEARCH_PLACEHOLDER_DESCRIPTOR)}
					leftIcon={<MagnifyingGlassIcon aria-hidden />}
					aria-label={`${typeLabel}: ${i18n._(COSMETIC_SEARCH_PLACEHOLDER_DESCRIPTOR)}`}
					data-flx="cosmetics.cosmetics-settings-tab.search"
				/>
			)}
			{trimmed.length > 0 ? (
				grid([null, ...matches], typeLabel)
			) : (
				<>
					<div className={styles.seriesGroup} data-flx="cosmetics.cosmetics-settings-tab.mine">
						<div className={styles.seriesHead} data-flx="cosmetics.cosmetics-settings-tab.mine-head">
							<span className={styles.seriesName}>{i18n._(COSMETIC_MINE_DESCRIPTOR)}</span>
							<span className={styles.seriesCount}>
								{i18n._(COSMETIC_SERIES_COUNT_DESCRIPTOR, {count: mine.length})}
							</span>
						</div>
						{grid([null, ...mine], i18n._(COSMETIC_MINE_DESCRIPTOR))}
					</div>
					{groups.map((group) => {
						const name = group.name ?? i18n._(COSMETIC_SERIES_OTHER_DESCRIPTOR);
						const open = openSlugs.has(group.slug);
						const Caret = open ? CaretDownIcon : CaretRightIcon;
						return (
							<div key={group.slug} className={styles.seriesGroup} data-flx="cosmetics.cosmetics-settings-tab.series">
								<button
									type="button"
									className={styles.seriesHead}
									aria-expanded={open}
									onClick={() => toggle(group.slug)}
									data-flx="cosmetics.cosmetics-settings-tab.series-toggle"
								>
									<Caret className={styles.seriesCaret} weight="bold" aria-hidden />
									<img
										className={styles.seriesCover}
										src={getCosmeticAssetURL(
											type,
											{asset: group.items[0].asset, item_id: group.items[0].id},
											TILE_IMAGE_CSS_SIZE,
											false,
										)}
										alt=""
										loading="lazy"
										data-flx="cosmetics.cosmetics-settings-tab.series-cover"
									/>
									<span className={styles.seriesName}>{name}</span>
									<span className={styles.seriesCount}>
										{i18n._(COSMETIC_SERIES_COUNT_DESCRIPTOR, {count: group.items.length})}
									</span>
								</button>
								{open && grid(group.items, name)}
							</div>
						);
					})}
				</>
			)}
		</div>
	);
});

const CosmeticsSettingsTab = observer(function CosmeticsSettingsTab() {
	const {i18n} = useLingui();
	// Picks are previewed locally and saved together: every save fans the user change out to all their communities.
	const [draft, setDraft] = useState<CosmeticSelection>({});
	const [lockedItem, setLockedItem] = useState<CosmeticItem | null>(null);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		void Cosmetics.load();
		return () => UnsavedChangesCommands.clearUnsavedChanges(TAB_ID);
	}, []);
	const hasChanges = Object.keys(pendingChanges(draft)).length > 0;
	const handleReset = useCallback(() => setDraft({}), []);
	const handleSave = useCallback(async () => {
		const changes = pendingChanges(draft);
		if (Object.keys(changes).length === 0) return;
		setSaving(true);
		try {
			await Cosmetics.equip(changes);
			setDraft({});
		} catch {
			ToastCommands.createToast({type: 'error', children: i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)});
		} finally {
			setSaving(false);
		}
	}, [draft, i18n]);
	useEffect(() => {
		UnsavedChangesCommands.setUnsavedChanges(TAB_ID, hasChanges);
	}, [hasChanges]);
	useEffect(() => {
		UnsavedChangesCommands.setTabData(TAB_ID, {onReset: handleReset, onSave: handleSave, isSubmitting: saving});
	}, [handleReset, handleSave, saving]);
	const user = Users.currentUser;
	if (Cosmetics.failed) {
		return (
			<StatusSlate
				Icon={WarningIcon}
				title={i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)}
				description={i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR)}
				actions={[{text: i18n._(TRY_AGAIN_DESCRIPTOR), onClick: () => void Cosmetics.load()}]}
				data-flx="cosmetics.cosmetics-settings-tab.status-slate"
			/>
		);
	}
	if (!Cosmetics.ready || !user) {
		return (
			<div className={styles.spinnerContainer} data-flx="cosmetics.cosmetics-settings-tab.spinner-container">
				<Spinner data-flx="cosmetics.cosmetics-settings-tab.spinner" />
			</div>
		);
	}
	const isPremium = user.isPremium();
	const selectedId = (type: CosmeticType) => (type in draft ? (draft[type] ?? null) : Cosmetics.equippedId(type));
	const handleSelect = (type: CosmeticType, item: CosmeticItem | null) => {
		if (item && isCosmeticLocked(item, isPremium)) {
			setLockedItem(item);
			return;
		}
		setLockedItem(null);
		setDraft((previous) => ({...previous, [type]: item?.id ?? null}));
	};
	// Untouched slots keep the worn data from the user, so an item the catalog dropped still shows.
	const previewUser = user.withUpdates({
		...('avatar_decoration' in draft && {
			avatar_decoration_data: toAssetData(Cosmetics.getItem(selectedId('avatar_decoration'))),
		}),
		...('avatar_ultra' in draft && {avatar_ultra_data: toAssetData(Cosmetics.getItem(selectedId('avatar_ultra')))}),
		...('nameplate' in draft && {nameplate_data: toAssetData(Cosmetics.getItem(selectedId('nameplate')))}),
	});
	return (
		<SettingsTabContainer data-flx="cosmetics.cosmetics-settings-tab.settings-tab-container">
			<SettingsTabContent data-flx="cosmetics.cosmetics-settings-tab.settings-tab-content">
				<div className={styles.layout} data-flx="cosmetics.cosmetics-settings-tab.layout">
					<div className={styles.pickers} data-flx="cosmetics.cosmetics-settings-tab.pickers">
						{VISIBLE_COSMETIC_TYPES.map((type) => (
							<SettingsSection
								key={type}
								id={`profile-cosmetics-${type}`}
								linkable={false}
								title={i18n._(COSMETIC_TYPE_LABELS[type])}
								description={i18n._(COSMETIC_TYPE_DESCRIPTIONS[type])}
								data-flx="cosmetics.cosmetics-settings-tab.settings-section"
							>
								<CosmeticPicker
									type={type}
									items={Cosmetics.itemsOfType(type)}
									selectedId={selectedId(type)}
									isPremium={isPremium}
									onSelect={handleSelect}
									data-flx="cosmetics.cosmetics-settings-tab.cosmetic-picker"
								/>
								{lockedItem?.type === type && (
									<div className={styles.lockedNotice} data-flx="cosmetics.cosmetics-settings-tab.locked-notice">
										<span className={styles.lockedText} data-flx="cosmetics.cosmetics-settings-tab.locked-text">
											{i18n._(LOCKED_DESCRIPTOR, {name: lockedItem.name, premiumProductName: PREMIUM_PRODUCT_NAME})}
										</span>
										{shouldShowPremiumFeatures() && (
											<Button
												small={true}
												onClick={openPremiumTab}
												data-flx="cosmetics.cosmetics-settings-tab.button.get-premium"
											>
												{i18n._(GET_PREMIUM_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
											</Button>
										)}
									</div>
								)}
							</SettingsSection>
						))}
					</div>
					<div className={styles.previewColumn} data-flx="cosmetics.cosmetics-settings-tab.preview-column">
						<ProfilePreview
							user={previewUser}
							previewProfileEffect={toAssetData(Cosmetics.getItem(selectedId('profile_effect')))}
							showMembershipInfo={false}
							showMessageButton={false}
							data-flx="cosmetics.cosmetics-settings-tab.profile-preview"
						/>
						<div className={styles.nameplatePreview} data-flx="cosmetics.cosmetics-settings-tab.nameplate-preview">
							<NameplateBackground
								nameplate={previewUser.nameplate}
								data-flx="cosmetics.cosmetics-settings-tab.nameplate-background"
							>
								<div className={styles.nameplateRow} data-flx="cosmetics.cosmetics-settings-tab.nameplate-row">
									<Avatar user={previewUser} size={32} data-flx="cosmetics.cosmetics-settings-tab.avatar" />
									<span className={styles.nameplateName} data-flx="cosmetics.cosmetics-settings-tab.nameplate-name">
										{previewUser.displayName}
									</span>
								</div>
							</NameplateBackground>
						</div>
					</div>
				</div>
			</SettingsTabContent>
		</SettingsTabContainer>
	);
});

export default CosmeticsSettingsTab;
