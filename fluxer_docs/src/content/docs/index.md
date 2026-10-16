---
# SPDX-License-Identifier: AGPL-3.0-or-later
title: sanalyer API
description: Build bots, tools and clients for sanalyer.
---

sanalyer is the chat service at [sanalyer.com](https://sanalyer.com). These pages describe its HTTP API, Gateway, media proxy and admin API.

- To build a client or a bot, start with the [HTTP API](/http-api/) and the [Gateway](/gateway/overview/).
- For a first bot in Python, read the Turkish [quick start](/bots/hizli-baslangic/).
- For voice and screen sharing, read [Voice](/voice/).
- The desktop app is on the [download page](https://sanalyer.com/indir).

Questions about the API go to [info@sanalyer.com](mailto:info@sanalyer.com).

## Protocol surfaces

Use the HTTP API to read and change resources, and Gateway [events](/gateway/events/) to receive updates. The [Media Proxy](/media-proxy/overview/) serves media and uploads. The [Admin API](/admin-api/) provides privileged instance management.

## Shared contracts

See [Authentication](/authentication/), [Errors](/http-api/errors/), [Rate limits](/topics/rate-limits/) and [Locales](/topics/locales/) for shared behaviour. Most resource identifiers are [snowflakes](/snowflakes/). Each resource page states where it differs from this shared behaviour.

## Field notation

In field tables, `?` after a field name means optional. Before a type, it means nullable.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Required and cannot be `null` |
| `name?` | `string` | Optional, but cannot be `null` when present |
| `name` | `?string` | Required, but can be `null` |
| `name?` | `?string` | Nullish, so it can be omitted or set to `null` |

An omitted field is different from a field set to `null`. Each operation explains how these values affect the resource.

In the type column, `array[type]` is an array of the named type, and `map[key, value]` is a JSON object keyed by the first type with values of the second.

## Endpoint discovery

Start with `GET /.well-known/fluxer` on the instance origin. It requires no authentication and allows cross-origin requests. The path keeps its upstream name; it is part of the protocol.

```text
GET https://sanalyer.com/.well-known/fluxer
```

Read base URLs from the response's [endpoints](/http-api/instance/#instance-endpoints-object). Do not derive them from the origin or hard-code them.

- Bots, libraries and third-party clients use `endpoints.api_public`.
- The first-party web application uses `endpoints.api_client`. `endpoints.api` is an alias for it.

Use `/v1` paths and send credentials in the `Authorization` header as described in [Authentication](/authentication/).

## Source code

sanalyer runs on open-source software licensed under the AGPLv3. The upstream source is on [GitHub](https://github.com/fluxerapp/fluxer).
