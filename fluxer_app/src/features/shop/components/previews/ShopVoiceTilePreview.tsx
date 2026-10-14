// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/shop/components/previews/ShopVoiceTilePreview.module.css';
import {Avatar} from '@app/features/ui/components/Avatar';
import type {User} from '@app/features/user/models/User';
import {
	TILE_AVATAR_BASE,
	TILE_AVATAR_MEDIA_SIZE,
	TILE_AVATAR_STYLE,
} from '@app/features/voice/components/voice_participant_tile/shared';
import {observer} from 'mobx-react-lite';

interface ShopVoiceTilePreviewProps {
	user: User;
}

// A voice tile without LiveKit: the tile's own box, ring and avatar, as a participant with the camera off shows. The
// decoration plays as it does while the user speaks; under reduced motion the avatar keeps it still.
export const ShopVoiceTilePreview = observer<ShopVoiceTilePreviewProps>(({user}) => (
	<div className={styles.tile} data-flx="shop.shop-voice-tile-preview.tile">
		<div className={styles.placeholder} data-flx="shop.shop-voice-tile-preview.placeholder">
			<div className={styles.avatarRing} data-flx="shop.shop-voice-tile-preview.avatar-ring">
				<Avatar
					user={user}
					size={TILE_AVATAR_BASE}
					decorationSurface="voice"
					mediaSize={TILE_AVATAR_MEDIA_SIZE}
					style={TILE_AVATAR_STYLE}
					forceAnimate
					data-flx="shop.shop-voice-tile-preview.avatar"
				/>
			</div>
		</div>
		<span className={styles.name} data-flx="shop.shop-voice-tile-preview.name">
			{user.displayName}
		</span>
	</div>
));
