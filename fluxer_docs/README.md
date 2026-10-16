# Developer documentation

The existing Fluxer Astro/Starlight documentation can be built with a product profile. `micup.env` contains only public build and runtime settings. sanalyer uses `https://sanalyer.com/docs`; example API, Gateway, media and static bases are derived from the same single-domain profile using the shared endpoint derivation code. These examples are not a verified live discovery response: clients should read `/.well-known/fluxer` and use its published endpoints.

From the repository root, PowerShell can load the profile before building:

```powershell
Get-Content fluxer_docs/micup.env | ForEach-Object {
    if ($_ -match '^([A-Z_]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
pnpm --filter fluxer_docs build
```

In a POSIX shell:

```sh
set -a
. ./fluxer_docs/micup.env
set +a
pnpm --filter fluxer_docs build
```

Use the same profile when starting the resulting server (`pnpm --filter fluxer_docs start`). Changing `FLUXER_DOCS_ENDPOINT` after a build cannot change its compiled asset/link base, so rebuild when changing the public endpoint. `FLUXER_DOCS_LISTEN_HOST` and `FLUXER_DOCS_LISTEN_PORT` remain runtime settings. No deployment route or Compose service is created by this profile.

The Dockerfile accepts the same five settings as build arguments and carries them into the final image. For example, from the repository root:

```sh
docker build -f fluxer_docs/Dockerfile \
  --build-arg FLUXER_DOCS_PRODUCT_NAME=sanalyer \
  --build-arg FLUXER_BASE_DOMAIN=sanalyer.com \
  --build-arg FLUXER_PUBLIC_SCHEME=https \
  --build-arg FLUXER_PUBLIC_PORT=443 \
  --build-arg FLUXER_DOCS_ENDPOINT=https://sanalyer.com/docs .
```

Content branding is committed: `node tools/brand/docs-marka.mjs` (from the repository root) rewrites `src/content/docs` with the rule table at the top of that script, marks upstream-only pages (self-hosting, package repositories, billing, donations, in-app purchases) as drafts, and rewrites the homepage and downloads page. Run it again after every upstream merge, then `node tools/brand/docs-marka.mjs --check`, which must report no user-visible match. Branding transforms run at build time on content metadata and the existing Markdown/MDX AST. They do not duplicate upstream pages. Technical names (headers, environment variables, discovery path), quoted error messages, license and upstream source attribution stay intact. Operator pages are explicitly upstream self-hosting references, including upstream defaults and origin guards. Upstream hosted promotions are removed in the branded build. sanalyer download pages state that downloads are unavailable because no verified package origin is configured; no mirror URL is invented. Announcement channels are closed in sanalyer, so the branded build withholds their topic page and the follow, publish and follower webhook sections listed in `src/branding/DocsBranding.ts`, and turns links into them into plain text. Without `FLUXER_DOCS_PRODUCT_NAME`, the default Fluxer content and branding remain active.

Run the small regression checks with `pnpm --filter fluxer_docs test`. The documentation suite also has `verify:sidebar`, `verify:coverage:source`, `verify:schemas`, and `verify:style` checks.
