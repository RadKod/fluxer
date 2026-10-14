// SPDX-License-Identifier: AGPL-3.0-or-later

export const prerender = true;

export function GET(): Response {
	return new Response(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#15151b"/><path d="M7 25V7h4l5 9 5-9h4v18h-4V14l-5 8-5-8v11Z" fill="#fff"/></svg>',
		{
			headers: {'Content-Type': 'image/svg+xml'},
		},
	);
}
