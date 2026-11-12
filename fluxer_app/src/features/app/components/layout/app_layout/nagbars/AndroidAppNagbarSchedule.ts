// SPDX-License-Identifier: AGPL-3.0-or-later

// sanalyer: upstream's nagbar sends Android users to the upstream Play Store app, which signs in to the upstream
// instance, not to sanalyer. Our Android app is not on the Play Store yet, so the nagbar never starts.
export function useAndroidAppNagbarStarted(): boolean {
	return false;
}
