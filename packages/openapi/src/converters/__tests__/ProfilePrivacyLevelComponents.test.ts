// SPDX-License-Identifier: AGPL-3.0-or-later

import {ZodOpenAPIConverter} from '@fluxer/openapi/src/converters/ZodToOpenAPI';
import type {OpenAPIDocument} from '@fluxer/openapi/src/OpenAPITypes';
import {UserSettingsUpdateRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {UserSettingsResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {describe, expect, it} from 'vitest';

// The request and the response carry the four options (100, 101) and the legacy 1, under the component
// names the generated SDKs already use (ProfilePrivacyLevel for the response, ProfilePrivacyLevelInput for the request).
describe('profile privacy level components (sanalyer A0, T0)', () => {
	it('keeps the component names of the settings request and response', () => {
		const converter = new ZodOpenAPIConverter('draft-2020-12');
		converter.getRef('UserSettingsUpdateRequest', UserSettingsUpdateRequest, 'input');
		converter.getRef('UserSettingsResponse', UserSettingsResponse, 'output');
		const document: OpenAPIDocument = {
			openapi: '3.1.0',
			info: {title: 'Profile privacy level', version: '1'},
			paths: {},
			components: {schemas: converter.getAllSchemas(), securitySchemes: {}},
		};
		converter.normalizeComponents(document);
		const {schemas} = document.components;

		expect(schemas.ProfilePrivacyLevel?.enum).toEqual([0, 1, 2, 100, 101]);
		expect(schemas.ProfilePrivacyLevelInput?.enum).toEqual([0, 1, 2, 100, 101]);
		expect(schemas.UserSettingsResponse?.properties?.profile_privacy).toMatchObject({
			$ref: '#/components/schemas/ProfilePrivacyLevel',
		});
		expect(schemas.UserSettingsUpdateRequest?.properties?.profile_privacy).toMatchObject({
			$ref: '#/components/schemas/ProfilePrivacyLevelInput',
		});
	});
});
