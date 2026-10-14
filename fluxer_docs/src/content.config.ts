// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineCollection} from 'astro:content';
import {docsLoader} from '@astrojs/starlight/loaders';
import {docsSchema} from '@astrojs/starlight/schema';
import {brandDocsFrontmatter} from './branding/DocsBranding';
import {docsExampleEndpoints, docsProductName} from './server/DocsConfig';

const loader = docsLoader();

export const collections = {
	docs: defineCollection({
		loader: {
			...loader,
			load(context) {
				return loader.load({
					...context,
					generateDigest(data) {
						return context.generateDigest({data, productName: docsProductName(), endpoints: docsExampleEndpoints()});
					},
					parseData(entry) {
						return context.parseData({...entry, data: brandDocsFrontmatter(entry.data, entry.filePath ?? entry.id)});
					},
				});
			},
		},
		schema: docsSchema(),
	}),
};
