// SPDX-License-Identifier: AGPL-3.0-or-later

import {MemberListItem} from '@app/features/channel/components/MemberListItem';
import type {User} from '@app/features/user/models/User';
import {StatusTypes} from '@fluxer/constants/src/StatusConstants';
import {observer} from 'mobx-react-lite';

// Not a channel: with the status given and no community, the row reads no presence, custom status or typing.
const PREVIEW_CHANNEL_ID = 'shop-preview';

interface ShopMemberRowPreviewProps {
	user: User;
	// No hover reaches the inert row, so the caller says whether its nameplate plays; it does unless told otherwise.
	animateNameplate?: boolean;
}

// The real member list row, inert so its profile popout and context menu never open.
export const ShopMemberRowPreview = observer<ShopMemberRowPreviewProps>(({user, animateNameplate = true}) => (
	<div inert data-flx="shop.shop-member-row-preview.row">
		<MemberListItem
			user={user}
			channelId={PREVIEW_CHANNEL_ID}
			status={StatusTypes.ONLINE}
			customStatus={null}
			animateNameplate={animateNameplate}
			data-flx="shop.shop-member-row-preview.member-list-item"
		/>
	</div>
));
