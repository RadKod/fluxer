# NOTICE — Micup

Bu arşiv, Fluxer'ın (https://github.com/fluxerapp/fluxer) Micup tarafından değiştirilmiş bir sürümünün kaynak kodudur.
This archive contains the source code of a version of Fluxer (https://github.com/fluxerapp/fluxer) modified by Micup.

- Ürün / Product: Micup web uygulaması ve sunucu / Micup web app and server
- Sürüm / Version: 2026.1013.202325
- Micup commit: 30c978997426ac62da7a7559605b967c53900034 (2026-10-13T20:23:25Z)
- Fluxer taban commit'i / Fluxer base commit: 317fedeef9ae7deaea9db09d609ec83246b59c20 (git merge-base)
- Arşiv üretim tarihi / Archive generated (UTC): 2026-10-13T20:28:27Z

## Lisans / License

GNU Affero Genel Kamu Lisansı sürüm 3 ya da sonrası (AGPL-3.0-or-later): kök dizindeki `LICENSE`,
https://www.gnu.org/licenses/agpl-3.0.html. / GNU Affero General Public License v3 or later: see `LICENSE`.

`fluxer_static/` kendi bildirimlerini taşır / carries its own notices: `fluxer_static/LICENSE`, `fluxer_static/THIRD_PARTY_LICENSES.md`.

## Marka / Trademarks

"Micup" ve "Fluxer" adları ve logoları lisans kapsamında değildir; lisans marka hakkı vermez (`.github/GOVERNANCE.md`, "Name and marks").
The "Micup" and "Fluxer" names and logos are not covered by the license; it grants no trademark rights.

## Arşivde olmayanlar / Not included

- git geçmişi / git history
- sırlar ve canlı ortam değerleri (arşiv otomatik sır taramasından geçti) / secrets and production configuration values (the archive passed an automated secret scan)
- yapay zekâ ajan talimat dosyaları / AI agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude/`)

Kaynak kodu teklifi / Source code offer: https://micup.gg/yasal/kaynak

## Değişen dosyalar / Changed files

`git diff --stat 317fedeef9ae7deaea9db09d609ec83246b59c20 30c978997426ac62da7a7559605b967c53900034`:

```
 .gitattributes                                                                                                               |     1 +
 .github/workflows/build-desktop.yaml                                                                                         |    68 +-
 .github/workflows/micup-imaj.yml                                                                                             |   197 +
 .github/workflows/micup-kapi.yml                                                                                             |   552 +
 .github/workflows/micup-nsfw-imaj.yml                                                                                        |   171 +
 .gitignore                                                                                                                   |     1 +
 deploy/self-hosting/.env.example                                                                                             |    37 +-
 deploy/self-hosting/docker-compose.yml                                                                                       |    37 +-
 fluxer_admin/build.rs                                                                                                        |    37 +-
 fluxer_admin/openapi-admin.json                                                                                              | 10833 ++++++++++----
 fluxer_admin/src/acl.rs                                                                                                      |    42 +
 fluxer_admin/src/admin_flags.rs                                                                                              |    59 +-
 fluxer_admin/src/api/badges.rs                                                                                               |    38 +
 fluxer_admin/src/api/codes.rs                                                                                                |    10 +
 fluxer_admin/src/api/cosmetics.rs                                                                                            |    71 +
 fluxer_admin/src/api/feed.rs                                                                                                 |    19 +
 fluxer_admin/src/api/guild_threads.rs                                                                                        |    16 +-
 fluxer_admin/src/api/mod.rs                                                                                                  |     5 +
 fluxer_admin/src/api/referral.rs                                                                                             |    85 +
 fluxer_admin/src/api/reports.rs                                                                                              |    12 +-
 fluxer_admin/src/api/shop.rs                                                                                                 |    71 +
 fluxer_admin/src/api/types/badges.rs                                                                                         |    10 +
 fluxer_admin/src/api/types/cosmetics.rs                                                                                      |    54 +
 fluxer_admin/src/api/types/guild_threads.rs                                                                                  |     1 +
 fluxer_admin/src/api/types/instance_config.rs                                                                                |   307 +
 fluxer_admin/src/api/types/mod.rs                                                                                            |     8 +
 fluxer_admin/src/api/types/referral.rs                                                                                       |    90 +
 fluxer_admin/src/api/types/shop.rs                                                                                           |   156 +
 fluxer_admin/src/api/users.rs                                                                                                |    70 +-
 fluxer_admin/src/middleware/error_handler.rs                                                                                 |     2 +-
 fluxer_admin/src/routes/auth.rs                                                                                              |     4 +-
 fluxer_admin/src/routes/badges.rs                                                                                            |   137 +
 fluxer_admin/src/routes/codes.rs                                                                                             |   264 +-
 fluxer_admin/src/routes/cosmetics.rs                                                                                         |   537 +
 fluxer_admin/src/routes/feed_moderation.rs                                                                                   |   108 +
 fluxer_admin/src/routes/guild_tabs.rs                                                                                        |    13 +-
 fluxer_admin/src/routes/guilds.rs                                                                                            |     2 +
 fluxer_admin/src/routes/mod.rs                                                                                               |    61 +-
 fluxer_admin/src/routes/referral.rs                                                                                          |   444 +
 fluxer_admin/src/routes/shop.rs                                                                                              |   623 +
 fluxer_admin/src/routes/system_actions.rs                                                                                    |   871 +-
 fluxer_admin/src/routes/user_actions.rs                                                                                      |   168 +-
 fluxer_admin/src/routes/username_migration.rs                                                                                |   528 +
 fluxer_admin/src/routes/usernames.rs                                                                                         |   557 +
 fluxer_admin/src/routes/users.rs                                                                                             |     5 +
 fluxer_admin/src/templates/layout.rs                                                                                         |     2 +-
 fluxer_admin/src/templates/layout_sidebar.rs                                                                                 |     2 +-
 fluxer_admin/src/templates/layout_sidebar_nav.rs                                                                             |    66 +-
 fluxer_admin/src/templates/pages/badges.rs                                                                                   |   166 +
 fluxer_admin/src/templates/pages/bulk_actions.rs                                                                             |    46 +-
 fluxer_admin/src/templates/pages/cosmetics.rs                                                                                |   581 +
 fluxer_admin/src/templates/pages/feed_moderation.rs                                                                          |    76 +
 fluxer_admin/src/templates/pages/gift_codes.rs                                                                               |   137 +-
 fluxer_admin/src/templates/pages/guild_detail_tabs/threads.rs                                                                |    94 +-
 fluxer_admin/src/templates/pages/instance_config.rs                                                                          |   576 +-
 fluxer_admin/src/templates/pages/limit_config.rs                                                                             |     2 +-
 fluxer_admin/src/templates/pages/login.rs                                                                                    |     4 +-
 fluxer_admin/src/templates/pages/mod.rs                                                                                      |     7 +
 fluxer_admin/src/templates/pages/referral.rs                                                                                 |   657 +
 fluxer_admin/src/templates/pages/report_detail.rs                                                                            |    13 +-
 fluxer_admin/src/templates/pages/reports_list.rs                                                                             |     6 +-
 fluxer_admin/src/templates/pages/shop.rs                                                                                     |   877 ++
 fluxer_admin/src/templates/pages/user_detail_tabs/account.rs                                                                 |    15 +-
 fluxer_admin/src/templates/pages/user_detail_tabs/moderation.rs                                                              |    29 +
 fluxer_admin/src/templates/pages/user_detail_tabs/overview.rs                                                                |   101 +-
 fluxer_admin/src/templates/pages/user_detail_tabs/settings.rs                                                                |     2 +-
 fluxer_admin/src/templates/pages/user_peek.rs                                                                                |     2 +-
 fluxer_admin/src/templates/pages/username_migration.rs                                                                       |   239 +
 fluxer_admin/src/templates/pages/usernames.rs                                                                                |   264 +
 fluxer_admin/tests/api_deserialization.rs                                                                                    |   284 +
 fluxer_admin/tests/htmx_acceptance.rs                                                                                        |   234 +-
 fluxer_admin/tests/micup_admin_item_actions.rs                                                                               |   753 +
 fluxer_admin/tests/micup_admin_pages.rs                                                                                      |  1504 ++
 fluxer_admin/tests/micup_admin_referral.rs                                                                                   |   868 ++
 fluxer_admin/tests/micup_admin_visionary.rs                                                                                  |   757 +
 fluxer_admin/tests/micup_admin_voice_room.rs                                                                                 |   472 +
 fluxer_admin/tests/username_migration.rs                                                                                     |   672 +
 fluxer_admin/tests/username_moderation.rs                                                                                    |   400 +
 fluxer_admin/tests/usernames.rs                                                                                              |   596 +
 fluxer_api/package.json                                                                                                      |     2 +
 fluxer_api/pkgs/captcha/src/providers/TurnstileProvider.ts                                                                   |    62 +
 fluxer_api/pkgs/cassandra/src/Client.ts                                                                                      |    22 +
 fluxer_api/pkgs/email/src/EmailHtml.test.ts                                                                                  |    33 +
 fluxer_api/pkgs/email/src/EmailHtml.ts                                                                                       |   140 +
 fluxer_api/pkgs/email/src/EmailProviderTypes.ts                                                                              |     9 +
 fluxer_api/pkgs/email/src/EmailService.test.ts                                                                               |   347 +-
 fluxer_api/pkgs/email/src/EmailService.ts                                                                                    |   117 +-
 fluxer_api/pkgs/email/src/IEmailService.ts                                                                                   |     1 +
 fluxer_api/pkgs/email/src/SmtpEmailProvider.ts                                                                               |     1 +
 fluxer_api/pkgs/email/src/TestEmailService.ts                                                                                |     5 +
 fluxer_api/pkgs/email/src/email_i18n/EmailI18n.ts                                                                            |    17 +-
 fluxer_api/pkgs/email/src/email_i18n/EmailI18nLocaleFiles.test.ts                                                            |    83 +-
 fluxer_api/pkgs/email/src/email_i18n/EmailI18nMessages.ts                                                                    |    19 +-
 fluxer_api/pkgs/email/src/email_i18n/EmailI18nTypes.generated.ts                                                             |     2 +
 fluxer_api/pkgs/email/src/email_i18n/EmailI18nTypes.ts                                                                       |     3 +
 fluxer_api/pkgs/email/src/email_i18n/MicupTurkishSuffix.test.ts                                                              |    13 +
 fluxer_api/pkgs/email/src/email_i18n/locales/ar.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/bg.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/cs.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/da.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/de.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/el.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/en-GB.ts                                                                        |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/es-419.ts                                                                       |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/es-ES.ts                                                                        |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/fi.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/fr.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/he.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/hi.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/hr.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/hu.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/id.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/it.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/ja.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/ko.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/lt.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/nl.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/no.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/pl.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/pt-BR.ts                                                                        |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/ro.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/ru.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/sv-SE.ts                                                                        |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/th.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/tr.ts                                                                           |    37 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/uk.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/vi.ts                                                                           |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/zh-CN.ts                                                                        |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/locales/zh-TW.ts                                                                        |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/ar.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/bg.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/cs.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/da.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/de.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/el.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/en-GB.json                                                              |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/es-419.json                                                             |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/es-ES.json                                                              |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/fi.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/fr.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/he.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/hi.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/hr.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/hu.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/id.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/it.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/ja.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/ko.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/lt.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/nl.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/no.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/pl.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/pt-BR.json                                                              |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/ro.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/ru.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/sv-SE.json                                                              |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/th.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/tr.json                                                                 |    37 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/uk.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/vi.json                                                                 |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/zh-CN.json                                                              |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/locales/zh-TW.json                                                              |    33 +-
 fluxer_api/pkgs/email/src/email_i18n/weblate/messages.json                                                                   |    33 +-
 fluxer_api/pkgs/geoip/src/IpInfoService.ts                                                                                   |   533 +
 fluxer_api/pkgs/kv_client/src/IKVProvider.ts                                                                                 |    14 +
 fluxer_api/pkgs/kv_client/src/KVClient.ts                                                                                    |   104 +
 fluxer_api/pkgs/kv_client/src/KVPipeline.ts                                                                                  |    10 +
 fluxer_api/pkgs/kv_client/src/__tests__/KVClientHash.test.ts                                                                 |    88 +
 fluxer_api/pkgs/kv_client/src/__tests__/KVClientSortedSetRanks.test.ts                                                       |    96 +
 fluxer_api/src/api/Config.test.ts                                                                                            |    33 +
 fluxer_api/src/api/Config.ts                                                                                                 |    65 +
 fluxer_api/src/api/RateLimitConfig.test.ts                                                                                   |    34 +
 fluxer_api/src/api/RateLimitConfig.ts                                                                                        |    24 +
 fluxer_api/src/api/Tables.ts                                                                                                 |   114 +-
 fluxer_api/src/api/admin/AdminAuditActions.ts                                                                                |    10 +
 fluxer_api/src/api/admin/AdminRepository.ts                                                                                  |    37 +-
 fluxer_api/src/api/admin/IAdminRepository.ts                                                                                 |     6 +-
 fluxer_api/src/api/admin/controllers/BanAdminController.ts                                                                   |    61 +
 fluxer_api/src/api/admin/controllers/CodesAdminController.ts                                                                 |   120 +-
 fluxer_api/src/api/admin/controllers/InstanceConfigAdminController.ts                                                        |   316 +-
 fluxer_api/src/api/admin/controllers/ReportAdminController.ts                                                                |     2 +
 fluxer_api/src/api/admin/controllers/ThreadAdminController.ts                                                                |    11 +-
 fluxer_api/src/api/admin/controllers/UserAdminController.ts                                                                  |   186 +-
 fluxer_api/src/api/admin/controllers/index.ts                                                                                |    16 +
 fluxer_api/src/api/admin/services/AdminBanManagementService.ts                                                               |   296 +-
 fluxer_api/src/api/admin/services/AdminCodeGenerationService.ts                                                              |    48 +-
 fluxer_api/src/api/admin/services/AdminMessageService.ts                                                                     |     3 +-
 fluxer_api/src/api/admin/services/AdminUserBanService.ts                                                                     |     2 +
 fluxer_api/src/api/admin/services/AdminUserProfileService.ts                                                                 |   305 +-
 fluxer_api/src/api/admin/services/AdminUserRelationshipService.ts                                                            |   132 +-
 fluxer_api/src/api/admin/services/AdminUserSecurityService.ts                                                                |    27 +
 fluxer_api/src/api/admin/services/guild/AdminGuildUpdateService.ts                                                           |    30 +-
 fluxer_api/src/api/admin/services/guild/AdminGuildVanityService.ts                                                           |    80 +-
 fluxer_api/src/api/admin/tests/AdminGameActivityPolicy.test.ts                                                               |   630 +
 fluxer_api/src/api/admin/tests/AdminGiftCodeRevocation.test.ts                                                               |   229 +
 fluxer_api/src/api/admin/tests/AdminMessageDeletePurge.test.ts                                                               |   108 +
 fluxer_api/src/api/admin/tests/AdminOAuth2ApplicationRequirement.test.ts                                                     |    12 +-
 fluxer_api/src/api/admin/tests/AdminSyntheticUserMutations.test.ts                                                           |    15 +-
 fluxer_api/src/api/admin/tests/AdminThreadPagination.test.ts                                                                 |    90 +
 fluxer_api/src/api/admin/tests/GatewayRolloutConfigAdmin.test.ts                                                             |   127 +
 fluxer_api/src/api/admin/tests/InstanceConfigBilling.test.ts                                                                 |    38 +-
 fluxer_api/src/api/admin/tests/InstanceConfigOfficialApps.test.ts                                                            |   175 +
 fluxer_api/src/api/admin/tests/InstanceGameActivityRollout.test.ts                                                           |   185 +
 fluxer_api/src/api/admin/tests/InstancePolicyPremiumTrialDays.test.ts                                                        |    87 +
 fluxer_api/src/api/admin/tests/audit_coverage/AdminAuditRouteCoverage.test.ts                                                |    16 +
 fluxer_api/src/api/admin/tests/audit_coverage/BadgeAdminAuditCases.ts                                                        |   151 +
 fluxer_api/src/api/admin/tests/audit_coverage/BadgeAdminAuditCoverage.test.ts                                                |     6 +
 fluxer_api/src/api/admin/tests/audit_coverage/BanAdminAuditCases.ts                                                          |    44 +
 fluxer_api/src/api/admin/tests/audit_coverage/CodesAdminAuditCases.ts                                                        |    35 +
 fluxer_api/src/api/admin/tests/audit_coverage/CosmeticAdminAuditCases.ts                                                     |   141 +
 fluxer_api/src/api/admin/tests/audit_coverage/CosmeticAdminAuditCoverage.test.ts                                             |     6 +
 fluxer_api/src/api/admin/tests/audit_coverage/FeedModerationAdminAuditCases.ts                                               |    95 +
 fluxer_api/src/api/admin/tests/audit_coverage/FeedModerationAdminAuditCoverage.test.ts                                       |     6 +
 fluxer_api/src/api/admin/tests/audit_coverage/InstanceConfigAdminAuditCases.ts                                               |   157 +-
 fluxer_api/src/api/admin/tests/audit_coverage/MessageAdminAuditCases.ts                                                      |     2 +-
 fluxer_api/src/api/admin/tests/audit_coverage/PremiumLedgerAdminAuditCases.ts                                                |    31 +
 fluxer_api/src/api/admin/tests/audit_coverage/PremiumLedgerAdminAuditCoverage.test.ts                                        |     6 +
 fluxer_api/src/api/admin/tests/audit_coverage/ReferralAdminAuditCases.ts                                                     |   178 +
 fluxer_api/src/api/admin/tests/audit_coverage/ReferralAdminAuditCoverage.test.ts                                             |    33 +
 fluxer_api/src/api/admin/tests/audit_coverage/ShopAdminAuditCases.ts                                                         |   173 +
 fluxer_api/src/api/admin/tests/audit_coverage/ShopAdminAuditCoverage.test.ts                                                 |     6 +
 fluxer_api/src/api/admin/tests/audit_coverage/ShopOrderAdminAuditCases.ts                                                    |    59 +
 fluxer_api/src/api/admin/tests/audit_coverage/ShopOrderAdminAuditCoverage.test.ts                                            |     6 +
 fluxer_api/src/api/admin/tests/audit_coverage/UserAdminAuditCases.ts                                                         |   119 +-
 fluxer_api/src/api/admin/tests/audit_coverage/UserWriteAdminAuditCases.ts                                                    |    18 +
 fluxer_api/src/api/admin/tests/audit_coverage/VisionaryAdminAuditCases.ts                                                    |   101 +
 fluxer_api/src/api/admin/tests/audit_coverage/VisionaryAdminAuditCoverage.test.ts                                            |     6 +
 fluxer_api/src/api/app/APILifecycle.ts                                                                                       |     7 +
 fluxer_api/src/api/app/ControllerRegistry.ts                                                                                 |    58 +-
 fluxer_api/src/api/app/MiddlewarePipeline.ts                                                                                 |     5 +-
 fluxer_api/src/api/app/RequestLogRedaction.ts                                                                                |    11 +
 fluxer_api/src/api/app/tests/RequestLogRedaction.test.ts                                                                     |    45 +
 fluxer_api/src/api/auth/AuthController.ts                                                                                    |    18 +-
 fluxer_api/src/api/auth/AuthEmail.ts                                                                                         |    34 +-
 fluxer_api/src/api/auth/AuthRegistration.ts                                                                                  |   104 +-
 fluxer_api/src/api/auth/AuthRequestService.ts                                                                                |     6 +-
 fluxer_api/src/api/auth/OriginHandoffController.ts                                                                           |     3 +
 fluxer_api/src/api/auth/services/SsoAgeGate.test.ts                                                                          |    84 +
 fluxer_api/src/api/auth/services/SsoDisplayName.test.ts                                                                      |    73 +
 fluxer_api/src/api/auth/services/SsoLocale.test.ts                                                                           |    93 +
 fluxer_api/src/api/auth/services/SsoService.ts                                                                               |    57 +-
 fluxer_api/src/api/auth/tests/AuthTestUtils.ts                                                                               |    16 +-
 fluxer_api/src/api/auth/tests/CaptchaBypassFlags.test.ts                                                                     |    27 +-
 fluxer_api/src/api/auth/tests/CaptchaTurnstile.test.ts                                                                       |   258 +
 fluxer_api/src/api/auth/tests/LegacyEmailRecovery.test.ts                                                                    |   151 +
 fluxer_api/src/api/auth/tests/OriginHandoff.test.ts                                                                          |    20 +-
 fluxer_api/src/api/auth/tests/RegistrationProfilePrivacy.test.ts                                                             |   178 +
 fluxer_api/src/api/auth/tests/SettingsDefaults.test.ts                                                                       |     3 +-
 fluxer_api/src/api/auth/tests/UsernameMigrationRegistration.test.ts                                                          |   200 +
 fluxer_api/src/api/auth/tests/UsernameSignIn.test.ts                                                                         |    97 +-
 fluxer_api/src/api/badge/BadgeAdminController.ts                                                                             |   226 +
 fluxer_api/src/api/badge/BadgeProfileProvider.ts                                                                             |    12 +
 fluxer_api/src/api/badge/BadgeRepository.ts                                                                                  |    53 +
 fluxer_api/src/api/badge/BadgeService.ts                                                                                     |   177 +
 fluxer_api/src/api/badge/BadgeTables.ts                                                                                      |    53 +
 fluxer_api/src/api/badge/BadgeUserLifecycleHooks.ts                                                                          |    22 +
 fluxer_api/src/api/badge/PioneerRepository.ts                                                                                |   125 +
 fluxer_api/src/api/badge/PioneerService.ts                                                                                   |   494 +
 fluxer_api/src/api/badge/tests/BadgeRoutes.test.ts                                                                           |   400 +
 fluxer_api/src/api/badge/tests/PioneerClosure.test.ts                                                                        |    86 +
 fluxer_api/src/api/badge/tests/PioneerRoutes.test.ts                                                                         |   481 +
 fluxer_api/src/api/badge/tests/PioneerService.test.ts                                                                        |   706 +
 fluxer_api/src/api/badge/tests/PioneerSlotsCassandra.test.ts                                                                 |   144 +
 fluxer_api/src/api/ban/IpBanCgnatGuard.ts                                                                                    |    44 +
 fluxer_api/src/api/ban/IpInfoBudget.ts                                                                                       |   105 +
 fluxer_api/src/api/ban/__tests__/IpBanCgnatGuard.test.ts                                                                     |    89 +
 fluxer_api/src/api/ban/__tests__/IpInfoBudget.test.ts                                                                        |   134 +
 fluxer_api/src/api/ban/__tests__/IpInfoServiceCache.test.ts                                                                  |   276 +
 fluxer_api/src/api/blocklist/AccountPolicyMinimumAge.test.ts                                                                 |    28 +
 fluxer_api/src/api/blocklist/MicupAccountPolicy.test.ts                                                                      |    22 +
 fluxer_api/src/api/channel/AnnouncementChannelsRouteGuard.ts                                                                 |     8 +
 fluxer_api/src/api/channel/ChannelMappers.ts                                                                                 |     1 +
 fluxer_api/src/api/channel/ChannelRepository.ts                                                                              |    19 +
 fluxer_api/src/api/channel/IChannelRepository.ts                                                                             |    15 +
 fluxer_api/src/api/channel/controllers/ChannelFollowController.ts                                                            |     3 +
 fluxer_api/src/api/channel/controllers/MessageController.ts                                                                  |     3 +
 fluxer_api/src/api/channel/controllers/MessageInteractionController.ts                                                       |    42 +-
 fluxer_api/src/api/channel/repositories/ChannelDataRepository.test.ts                                                        |     1 +
 fluxer_api/src/api/channel/repositories/IMessageInteractionRepository.ts                                                     |    15 +
 fluxer_api/src/api/channel/repositories/IThreadRepository.ts                                                                 |    16 +
 fluxer_api/src/api/channel/repositories/MessageInteractionRepository.ts                                                      |    40 +
 fluxer_api/src/api/channel/repositories/ThreadAdminPagination.test.ts                                                        |   136 +
 fluxer_api/src/api/channel/repositories/ThreadRepository.test.ts                                                             |     2 +
 fluxer_api/src/api/channel/repositories/ThreadRepository.ts                                                                  |    67 +
 fluxer_api/src/api/channel/repositories/ThreadRepositoryPaging.test.ts                                                       |    44 +
 fluxer_api/src/api/channel/services/ChannelDataService.ts                                                                    |     3 +
 fluxer_api/src/api/channel/services/channel_data/ChannelOperationsService.ts                                                 |    23 +
 fluxer_api/src/api/channel/services/group_dm/GroupDmOperationsService.ts                                                     |     4 +
 fluxer_api/src/api/channel/services/interaction/MessageComponentService.ts                                                   |    83 +
 fluxer_api/src/api/channel/services/interaction/MessageInteractionBase.ts                                                    |    26 +-
 fluxer_api/src/api/channel/services/interaction/MessagePinService.ts                                                         |    19 -
 fluxer_api/src/api/channel/services/interaction/MessageReactionService.ts                                                    |    80 +-
 fluxer_api/src/api/channel/services/interaction/MessageReactionUserCounter.ts                                                |   146 +
 fluxer_api/src/api/channel/services/message/MessageComponentRules.ts                                                         |    76 +
 fluxer_api/src/api/channel/services/message/MessageCrosspostService.ts                                                       |     4 +
 fluxer_api/src/api/channel/services/message/MessageEditService.ts                                                            |    11 +
 fluxer_api/src/api/channel/services/message/MessageMentionService.everyone.test.ts                                           |    35 +
 fluxer_api/src/api/channel/services/message/MessagePersistenceService.ts                                                     |     8 +
 fluxer_api/src/api/channel/services/message/MessageRequestService.ts                                                         |     4 +
 fluxer_api/src/api/channel/services/message/MessageSendService.ts                                                            |    13 +-
 fluxer_api/src/api/channel/services/message/UsernameActionGates.test.ts                                                      |   475 +
 fluxer_api/src/api/channel/services/thread/ThreadAdminPageConcurrency.test.ts                                                |   140 +
 fluxer_api/src/api/channel/services/thread/ThreadListService.ts                                                              |    47 +-
 fluxer_api/src/api/channel/tests/AnnouncementChannelType.test.ts                                                             |    12 +-
 fluxer_api/src/api/channel/tests/AnnouncementChannelsClosed.test.ts                                                          |   177 +
 fluxer_api/src/api/channel/tests/AnnouncementTestUtils.ts                                                                    |     5 +
 fluxer_api/src/api/channel/tests/ChannelOperationPermissions.test.ts                                                         |     7 +-
 fluxer_api/src/api/channel/tests/ChannelPermissionOverwrites.test.ts                                                         |    77 +
 fluxer_api/src/api/channel/tests/CrosspostPropagation.test.ts                                                                |     2 +
 fluxer_api/src/api/channel/tests/ForumChannels.test.ts                                                                       |     8 +-
 fluxer_api/src/api/channel/tests/MatureContentSettingsGate.test.ts                                                           |   253 +
 fluxer_api/src/api/channel/tests/MessageComponentClick.test.ts                                                               |   102 +
 fluxer_api/src/api/channel/tests/MessageComponentForward.test.ts                                                             |    58 +
 fluxer_api/src/api/channel/tests/MessageComponentSecurity.test.ts                                                            |   229 +
 fluxer_api/src/api/channel/tests/MessageComponentTestUtils.ts                                                                |    99 +
 fluxer_api/src/api/channel/tests/MessageComponentsWrite.test.ts                                                              |   402 +
 fluxer_api/src/api/channel/tests/MessageCrosspostFanout.test.ts                                                              |     2 +
 fluxer_api/src/api/channel/tests/MessageReactionCount.test.ts                                                                |   236 +
 fluxer_api/src/api/channel/tests/ThreadNsfw.test.ts                                                                          |     6 +-
 fluxer_api/src/api/channel/tests/ThreadRoutes.test.ts                                                                        |    29 +-
 fluxer_api/src/api/channel/tests/VoiceRoomTheme.test.ts                                                                      |   154 +
 fluxer_api/src/api/channel/utils/MatureContentSettingsGate.ts                                                                |    51 +
 fluxer_api/src/api/config/APIConfig.ts                                                                                       |    66 +-
 fluxer_api/src/api/connection/ConnectionService.ts                                                                           |     3 +
 fluxer_api/src/api/constants/Gateway.ts                                                                                      |    10 +-
 fluxer_api/src/api/constants/LimitConfig.ts                                                                                  |    19 +
 fluxer_api/src/api/content_i18n/ContentI18nMessages.ts                                                                       |     9 +
 fluxer_api/src/api/content_i18n/locales/ar.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/bg.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/cs.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/da.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/de.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/el.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/en-GB.ts                                                                             |     9 +-
 fluxer_api/src/api/content_i18n/locales/es-419.ts                                                                            |     9 +-
 fluxer_api/src/api/content_i18n/locales/es-ES.ts                                                                             |     9 +-
 fluxer_api/src/api/content_i18n/locales/fi.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/fr.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/he.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/hi.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/hr.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/hu.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/id.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/it.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/ja.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/ko.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/lt.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/nl.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/no.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/pl.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/pt-BR.ts                                                                             |     9 +-
 fluxer_api/src/api/content_i18n/locales/ro.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/ru.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/sv-SE.ts                                                                             |     9 +-
 fluxer_api/src/api/content_i18n/locales/th.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/tr.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/uk.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/vi.ts                                                                                |     9 +-
 fluxer_api/src/api/content_i18n/locales/zh-CN.ts                                                                             |     9 +-
 fluxer_api/src/api/content_i18n/locales/zh-TW.ts                                                                             |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/ar.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/bg.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/cs.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/da.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/de.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/el.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/en-GB.json                                                                   |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/es-419.json                                                                  |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/es-ES.json                                                                   |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/fi.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/fr.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/he.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/hi.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/hr.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/hu.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/id.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/it.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/ja.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/ko.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/lt.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/nl.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/no.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/pl.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/pt-BR.json                                                                   |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/ro.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/ru.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/sv-SE.json                                                                   |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/th.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/tr.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/uk.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/vi.json                                                                      |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/zh-CN.json                                                                   |     9 +-
 fluxer_api/src/api/content_i18n/weblate/locales/zh-TW.json                                                                   |     9 +-
 fluxer_api/src/api/content_i18n/weblate/messages.json                                                                        |     9 +-
 fluxer_api/src/api/cosmetics/CosmeticAdminController.ts                                                                      |   200 +
 fluxer_api/src/api/cosmetics/CosmeticController.ts                                                                           |    99 +
 fluxer_api/src/api/cosmetics/CosmeticProfileProvider.test.ts                                                                 |    53 +
 fluxer_api/src/api/cosmetics/CosmeticProfileProvider.ts                                                                      |    15 +
 fluxer_api/src/api/cosmetics/CosmeticRepository.ts                                                                           |   146 +
 fluxer_api/src/api/cosmetics/CosmeticService.ts                                                                              |   629 +
 fluxer_api/src/api/cosmetics/CosmeticTables.ts                                                                               |    39 +
 fluxer_api/src/api/cosmetics/CosmeticUserLifecycleHooks.ts                                                                   |    11 +
 fluxer_api/src/api/cosmetics/tests/CosmeticAdminGrant.test.ts                                                                |   213 +
 fluxer_api/src/api/cosmetics/tests/CosmeticDelivery.test.ts                                                                  |   218 +
 fluxer_api/src/api/cosmetics/tests/CosmeticItemsById.test.ts                                                                 |   101 +
 fluxer_api/src/api/cosmetics/tests/CosmeticRoutes.test.ts                                                                    |   543 +
 fluxer_api/src/api/cosmetics/tests/CosmeticUltraFront.test.ts                                                                |   451 +
 fluxer_api/src/api/cosmetics/tests/CosmeticUltraLayout.test.ts                                                               |   124 +
 fluxer_api/src/api/cosmetics/tests/PartialUserCosmeticVectors.test.ts                                                        |    96 +
 fluxer_api/src/api/csam/NcmecReporter.ts                                                                                     |     2 +-
 fluxer_api/src/api/csam/NcmecSubmissionService.ts                                                                            |    45 +-
 fluxer_api/src/api/csam/tests/MicupNcmecServiceName.test.ts                                                                  |    51 +
 fluxer_api/src/api/csam/tests/NcmecBanHook.test.ts                                                                           |    67 +
 fluxer_api/src/api/csam/tests/NcmecReporter.test.ts                                                                          |     6 +-
 fluxer_api/src/api/csam/tests/NcmecSubmissionPurge.test.ts                                                                   |   140 +
 fluxer_api/src/api/database/CassandraConsistency.test.ts                                                                     |   167 +
 fluxer_api/src/api/database/CassandraConsistency.ts                                                                          |    16 +
 fluxer_api/src/api/database/CassandraDefaultTtlParity.test.ts                                                                |    16 +-
 fluxer_api/src/api/database/CassandraQueryExecution.ts                                                                       |    20 +-
 fluxer_api/src/api/database/CassandraTableDsl.test.ts                                                                        |    21 +
 fluxer_api/src/api/database/CassandraTableDsl.ts                                                                             |    59 +-
 fluxer_api/src/api/database/CassandraTargetSchemaColumns.test.ts                                                             |    63 +
 fluxer_api/src/api/database/CassandraTypes.ts                                                                                |    20 +-
 fluxer_api/src/api/database/MicupSchemaParity.test.ts                                                                        |   483 +
 fluxer_api/src/api/database/PostgresKvDefaultTtlExpiry.ts                                                                    |     3 +-
 fluxer_api/src/api/database/PostgresKvQueryExecutor.ts                                                                       |    56 +-
 fluxer_api/src/api/database/PostgresKvTokenRange.test.ts                                                                     |   191 +
 fluxer_api/src/api/database/TokenRangeScan.test.ts                                                                           |   238 +
 fluxer_api/src/api/database/TokenRangeScan.ts                                                                                |    84 +
 fluxer_api/src/api/database/types/AdminArchiveTypes.ts                                                                       |    19 +-
 fluxer_api/src/api/database/types/BadgeTypes.ts                                                                              |    92 +
 fluxer_api/src/api/database/types/ChannelTypes.ts                                                                            |     2 +
 fluxer_api/src/api/database/types/CosmeticTypes.ts                                                                           |    85 +
 fluxer_api/src/api/database/types/FeedTypes.ts                                                                               |   341 +
 fluxer_api/src/api/database/types/FollowTypes.ts                                                                             |    48 +
 fluxer_api/src/api/database/types/GuildBoostTypes.ts                                                                         |    99 +
 fluxer_api/src/api/database/types/GuildRosterTypes.ts                                                                        |    68 +
 fluxer_api/src/api/database/types/GuildTypes.ts                                                                              |     4 +
 fluxer_api/src/api/database/types/MessageTypes.ts                                                                            |    19 +
 fluxer_api/src/api/database/types/MicupBotTypes.ts                                                                           |   182 +
 fluxer_api/src/api/database/types/PaymentTypes.ts                                                                            |    10 +-
 fluxer_api/src/api/database/types/PremiumLedgerTypes.ts                                                                      |    49 +
 fluxer_api/src/api/database/types/PremiumTrialTypes.ts                                                                       |    13 +
 fluxer_api/src/api/database/types/ReferralTypes.ts                                                                           |   197 +
 fluxer_api/src/api/database/types/RiskTypes.ts                                                                               |    77 +
 fluxer_api/src/api/database/types/ShopTypes.ts                                                                               |   143 +
 fluxer_api/src/api/database/types/UserTypes.ts                                                                               |   192 +
 fluxer_api/src/api/donation/tests/DonationCheckout.test.ts                                                                   |     1 +
 fluxer_api/src/api/donation/tests/DonationManage.test.ts                                                                     |     1 +
 fluxer_api/src/api/download/DownloadRedirects.ts                                                                             |     2 +-
 fluxer_api/src/api/experiment/ExperimentController.ts                                                                        |    15 +-
 fluxer_api/src/api/experiment/tests/ChannelAuthViewerCoverage.test.ts                                                        |     5 +
 fluxer_api/src/api/experiment/tests/ChannelLoadGateCoverage.test.ts                                                          |     6 +-
 fluxer_api/src/api/experiment/tests/ExperimentController.test.ts                                                             |   534 +
 fluxer_api/src/api/feed/FeedAuthorDm.ts                                                                                      |    34 +
 fluxer_api/src/api/feed/FeedContentVisibility.ts                                                                             |    12 +
 fluxer_api/src/api/feed/FeedEmbedService.ts                                                                                  |   124 +
 fluxer_api/src/api/feed/FeedLinkPreview.ts                                                                                   |   197 +
 fluxer_api/src/api/feed/FeedMediaService.ts                                                                                  |   393 +
 fluxer_api/src/api/feed/FeedPostController.ts                                                                                |   313 +
 fluxer_api/src/api/feed/FeedPostService.ts                                                                                   |   363 +
 fluxer_api/src/api/feed/FeedRepository.ts                                                                                    |   417 +
 fluxer_api/src/api/feed/FeedTables.ts                                                                                        |   203 +
 fluxer_api/src/api/feed/FeedTimelineService.ts                                                                               |   685 +
 fluxer_api/src/api/feed/FeedUserLifecycleHooks.ts                                                                            |    63 +
 fluxer_api/src/api/feed/discover/FeedDiscoverCache.ts                                                                        |   118 +
 fluxer_api/src/api/feed/discover/FeedDiscoverRepository.ts                                                                   |   305 +
 fluxer_api/src/api/feed/discover/FeedDiscoverRules.ts                                                                        |   169 +
 fluxer_api/src/api/feed/discover/FeedDiscoverService.ts                                                                      |   386 +
 fluxer_api/src/api/feed/discover/FeedTrendService.ts                                                                         |   162 +
 fluxer_api/src/api/feed/discover/tests/FeedDiscoverFollowing.test.ts                                                         |   159 +
 fluxer_api/src/api/feed/discover/tests/FeedDiscoverRepository.test.ts                                                        |    35 +
 fluxer_api/src/api/feed/discover/tests/FeedDiscoverRoutes.test.ts                                                            |   518 +
 fluxer_api/src/api/feed/discover/tests/FeedDiscoverRules.test.ts                                                             |   130 +
 fluxer_api/src/api/feed/discover/tests/FeedTrendService.test.ts                                                              |   523 +
 fluxer_api/src/api/feed/interaction/FeedInteractionController.ts                                                             |   430 +
 fluxer_api/src/api/feed/interaction/FeedInteractionCounters.ts                                                               |   116 +
 fluxer_api/src/api/feed/interaction/FeedInteractionRepository.ts                                                             |   719 +
 fluxer_api/src/api/feed/interaction/FeedInteractionService.ts                                                                |   691 +
 fluxer_api/src/api/feed/interaction/FeedPollService.ts                                                                       |    96 +
 fluxer_api/src/api/feed/interaction/tests/FeedInteractionRoutes.test.ts                                                      |   341 +
 fluxer_api/src/api/feed/interaction/tests/FeedLikeConcurrency.test.ts                                                        |    76 +
 fluxer_api/src/api/feed/interaction/tests/FeedPollRoutes.test.ts                                                             |   344 +
 fluxer_api/src/api/feed/interaction/tests/FeedReplyRoutes.test.ts                                                            |   569 +
 fluxer_api/src/api/feed/interaction/tests/FeedViewCounter.test.ts                                                            |    99 +
 fluxer_api/src/api/feed/moderation/FeedModerationAdminController.ts                                                          |   182 +
 fluxer_api/src/api/feed/moderation/FeedReportController.ts                                                                   |   130 +
 fluxer_api/src/api/feed/moderation/tests/FeedModerationRoutes.test.ts                                                        |   836 ++
 fluxer_api/src/api/feed/moderation/tests/FeedReportSearch.test.ts                                                            |    61 +
 fluxer_api/src/api/feed/notification/FeedNotificationController.ts                                                           |    71 +
 fluxer_api/src/api/feed/notification/FeedNotificationRepository.ts                                                           |    74 +
 fluxer_api/src/api/feed/notification/FeedNotificationService.ts                                                              |   676 +
 fluxer_api/src/api/feed/notification/tests/FeedNotificationContentVisibility.test.ts                                         |   140 +
 fluxer_api/src/api/feed/notification/tests/FeedNotificationRoutes.test.ts                                                    |   276 +
 fluxer_api/src/api/feed/notification/tests/FeedNotificationUnread.test.ts                                                    |   510 +
 fluxer_api/src/api/feed/suggest/FeedSuggestionCache.ts                                                                       |   125 +
 fluxer_api/src/api/feed/suggest/FeedSuggestionController.ts                                                                  |    37 +
 fluxer_api/src/api/feed/suggest/FeedSuggestionRepository.ts                                                                  |    65 +
 fluxer_api/src/api/feed/suggest/FeedSuggestionService.ts                                                                     |   481 +
 fluxer_api/src/api/feed/suggest/tests/FeedSuggestionBuild.test.ts                                                            |   824 +
 fluxer_api/src/api/feed/suggest/tests/FeedSuggestionCache.test.ts                                                            |   297 +
 fluxer_api/src/api/feed/suggest/tests/FeedSuggestionRoutes.test.ts                                                           |   297 +
 fluxer_api/src/api/feed/suggest/tests/FeedSuggestionTestUtils.ts                                                             |    28 +
 fluxer_api/src/api/feed/tests/FeedAuthorFirstPage.test.ts                                                                    |   108 +
 fluxer_api/src/api/feed/tests/FeedCassandra.test.ts                                                                          |   267 +
 fluxer_api/src/api/feed/tests/FeedContentVisibility.test.ts                                                                  |   240 +
 fluxer_api/src/api/feed/tests/FeedEmbedRoutes.test.ts                                                                        |   402 +
 fluxer_api/src/api/feed/tests/FeedFanoutCelebrity.test.ts                                                                    |   423 +
 fluxer_api/src/api/feed/tests/FeedHomeFollowedStranger.test.ts                                                               |   361 +
 fluxer_api/src/api/feed/tests/FeedKillSwitch.test.ts                                                                         |   192 +
 fluxer_api/src/api/feed/tests/FeedLinkPreview.test.ts                                                                        |   144 +
 fluxer_api/src/api/feed/tests/FeedPostRoutes.test.ts                                                                         |   573 +
 fluxer_api/src/api/feed/tests/FeedProfileVisibility.test.ts                                                                  |   452 +
 fluxer_api/src/api/feed/tests/FeedPublicAccess.test.ts                                                                       |   224 +
 fluxer_api/src/api/feed/tests/FeedPublicUnknownLevel.test.ts                                                                 |    74 +
 fluxer_api/src/api/feed/tests/FeedTestUtils.ts                                                                               |   112 +
 fluxer_api/src/api/feed/tests/FeedTimelineBlocked.test.ts                                                                    |   102 +
 fluxer_api/src/api/feed/tests/FeedVideoRoutes.test.ts                                                                        |   200 +
 fluxer_api/src/api/feed/video/BunnyStreamClient.ts                                                                           |   201 +
 fluxer_api/src/api/feed/video/FeedVideoController.ts                                                                         |   150 +
 fluxer_api/src/api/feed/video/FeedVideoRepository.ts                                                                         |   364 +
 fluxer_api/src/api/feed/video/FeedVideoScanner.ts                                                                            |   306 +
 fluxer_api/src/api/feed/video/FeedVideoService.ts                                                                            |  1191 ++
 fluxer_api/src/api/feed/video/FeedVideoUrls.ts                                                                               |   140 +
 fluxer_api/src/api/feed/video/tests/BunnyStreamClient.test.ts                                                                |   191 +
 fluxer_api/src/api/feed/video/tests/FeedVideoPipeline.test.ts                                                                |   323 +
 fluxer_api/src/api/feed/video/tests/FeedVideoRepository.test.ts                                                              |   244 +
 fluxer_api/src/api/feed/video/tests/FeedVideoScanner.test.ts                                                                 |   357 +
 fluxer_api/src/api/feed/video/tests/FeedVideoService.test.ts                                                                 |  1636 ++
 fluxer_api/src/api/feed/video/tests/FeedVideoUploadRoutes.test.ts                                                            |   188 +
 fluxer_api/src/api/feed/video/tests/FeedVideoUrls.test.ts                                                                    |   174 +
 fluxer_api/src/api/feed/video/tests/FeedVideoVisibility.test.ts                                                              |   409 +
 fluxer_api/src/api/feed/video/tests/FeedVideoWebhook.test.ts                                                                 |   271 +
 fluxer_api/src/api/feed/views/FeedViewController.ts                                                                          |    37 +
 fluxer_api/src/api/feed/views/FeedViewService.ts                                                                             |   139 +
 fluxer_api/src/api/feed/views/FeedViews.ts                                                                                   |    58 +
 fluxer_api/src/api/feed/views/tests/FeedViewPipeline.test.ts                                                                 |   102 +
 fluxer_api/src/api/feed/views/tests/FeedViewRoutes.test.ts                                                                   |   379 +
 fluxer_api/src/api/feed/views/tests/FeedViewService.test.ts                                                                  |   255 +
 fluxer_api/src/api/feed/views/tests/FeedViewTickets.test.ts                                                                  |    71 +
 fluxer_api/src/api/follow/FollowController.ts                                                                                |   258 +
 fluxer_api/src/api/follow/FollowCounters.ts                                                                                  |    96 +
 fluxer_api/src/api/follow/FollowProfileProvider.ts                                                                           |    12 +
 fluxer_api/src/api/follow/FollowRepository.ts                                                                                |   393 +
 fluxer_api/src/api/follow/FollowService.ts                                                                                   |   263 +
 fluxer_api/src/api/follow/FollowTables.ts                                                                                    |    44 +
 fluxer_api/src/api/follow/FollowUserLifecycleHooks.ts                                                                        |    41 +
 fluxer_api/src/api/follow/tests/FollowBlocked.test.ts                                                                        |   156 +
 fluxer_api/src/api/follow/tests/FollowRanking.test.ts                                                                        |   302 +
 fluxer_api/src/api/follow/tests/FollowRoutes.test.ts                                                                         |   326 +
 fluxer_api/src/api/follow/tests/FollowThroughPool.test.ts                                                                    |   402 +
 fluxer_api/src/api/follow/tests/FollowThroughPost.test.ts                                                                    |   444 +
 fluxer_api/src/api/follow/tests/FollowVisibility.test.ts                                                                     |   227 +
 fluxer_api/src/api/follow/tests/FollowingSetCache.test.ts                                                                    |    39 +
 fluxer_api/src/api/guild/GuildModel.ts                                                                                       |     3 +
 fluxer_api/src/api/guild/OfficialBotComponentRouter.ts                                                                       |    44 +
 fluxer_api/src/api/guild/OfficialBotReactionHook.ts                                                                          |    27 +
 fluxer_api/src/api/guild/OfficialBots.ts                                                                                     |    36 +
 fluxer_api/src/api/guild/boost/GuildBoostController.ts                                                                       |   122 +
 fluxer_api/src/api/guild/boost/GuildBoostCounters.ts                                                                         |    55 +
 fluxer_api/src/api/guild/boost/GuildBoostLevels.ts                                                                           |    17 +
 fluxer_api/src/api/guild/boost/GuildBoostRepository.ts                                                                       |   205 +
 fluxer_api/src/api/guild/boost/GuildBoostService.ts                                                                          |   707 +
 fluxer_api/src/api/guild/boost/GuildBoostTables.ts                                                                           |    53 +
 fluxer_api/src/api/guild/boost/GuildBoostUserLifecycleHooks.ts                                                               |    11 +
 fluxer_api/src/api/guild/boost/tests/GuildBoostHotGuild.test.ts                                                              |   102 +
 fluxer_api/src/api/guild/boost/tests/GuildBoostLevels.test.ts                                                                |    73 +
 fluxer_api/src/api/guild/boost/tests/GuildBoostRoutes.test.ts                                                                |   736 +
 fluxer_api/src/api/guild/micupbot/MicupBotAutomod.ts                                                                         |   285 +
 fluxer_api/src/api/guild/micupbot/MicupBotBot.ts                                                                             |    28 +
 fluxer_api/src/api/guild/micupbot/MicupBotCommandParse.ts                                                                    |   137 +
 fluxer_api/src/api/guild/micupbot/MicupBotCommands.ts                                                                        |   426 +
 fluxer_api/src/api/guild/micupbot/MicupBotConstants.ts                                                                       |   145 +
 fluxer_api/src/api/guild/micupbot/MicupBotController.ts                                                                      |   421 +
 fluxer_api/src/api/guild/micupbot/MicupBotGuildFlags.ts                                                                      |    68 +
 fluxer_api/src/api/guild/micupbot/MicupBotLeaderboard.ts                                                                     |    80 +
 fluxer_api/src/api/guild/micupbot/MicupBotLevels.ts                                                                          |   279 +
 fluxer_api/src/api/guild/micupbot/MicupBotMemberEvents.ts                                                                    |   121 +
 fluxer_api/src/api/guild/micupbot/MicupBotMemberHooks.ts                                                                     |   111 +
 fluxer_api/src/api/guild/micupbot/MicupBotMessageHook.ts                                                                     |   184 +
 fluxer_api/src/api/guild/micupbot/MicupBotReactionHook.ts                                                                    |    35 +
 fluxer_api/src/api/guild/micupbot/MicupBotReactionRoles.ts                                                                   |    93 +
 fluxer_api/src/api/guild/micupbot/MicupBotRepository.ts                                                                      |   210 +
 fluxer_api/src/api/guild/micupbot/MicupBotRoleGrant.ts                                                                       |    97 +
 fluxer_api/src/api/guild/micupbot/MicupBotRoleRules.ts                                                                       |    12 +
 fluxer_api/src/api/guild/micupbot/MicupBotSettingsCache.ts                                                                   |    98 +
 fluxer_api/src/api/guild/micupbot/MicupBotSettingsService.ts                                                                 |   675 +
 fluxer_api/src/api/guild/micupbot/MicupBotTables.ts                                                                          |    83 +
 fluxer_api/src/api/guild/micupbot/MicupBotTemplate.ts                                                                        |    25 +
 fluxer_api/src/api/guild/micupbot/MicupBotUserLifecycleHooks.ts                                                              |    67 +
 fluxer_api/src/api/guild/micupbot/MicupBotVoice.ts                                                                           |   161 +
 fluxer_api/src/api/guild/micupbot/MicupBotXp.ts                                                                              |    25 +
 fluxer_api/src/api/guild/micupbot/MicupBotXpCounters.ts                                                                      |    40 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotAutomodAction.test.ts                                                        |   192 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotAutomodDetect.test.ts                                                        |   150 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotAutorole.test.ts                                                             |    68 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotBot.test.ts                                                                  |    45 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotCommandParse.test.ts                                                         |    63 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotCommandTestUtils.ts                                                          |   152 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotGuildFlags.test.ts                                                           |   143 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotHookTestUtils.ts                                                             |   148 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotInfoCommands.test.ts                                                         |   164 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotLeaderboard.test.ts                                                          |    90 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotLeaderboardRebuild.test.ts                                                   |    51 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotLeaderboardRoutes.test.ts                                                    |    95 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotLevelUp.test.ts                                                              |   150 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotLevels.test.ts                                                               |   168 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotLevelsTestUtils.ts                                                           |   165 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotMemberHooks.test.ts                                                          |   197 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotMemberTestUtils.ts                                                           |   182 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotMessageHook.test.ts                                                          |   456 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotModerationCommands.test.ts                                                   |   222 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotPanelRoutes.test.ts                                                          |   231 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotReactionHook.test.ts                                                         |   101 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotReactionRoles.test.ts                                                        |   242 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotReactionRoute.test.ts                                                        |   173 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotRepository.test.ts                                                           |   144 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotRoleGrant.test.ts                                                            |    91 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotRoleRules.test.ts                                                            |    15 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotSettingsCache.test.ts                                                        |   174 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotSettingsPermissions.test.ts                                                  |   322 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotSettingsRoutes.test.ts                                                       |   281 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotTemplate.test.ts                                                             |    28 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotTestUtils.ts                                                                 |   167 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotTypes.test.ts                                                                |    15 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotUserLifecycle.test.ts                                                        |   126 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotVoice.test.ts                                                                |   497 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotWarnCommands.test.ts                                                         |   101 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotWarningRoutes.test.ts                                                        |    99 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotWelcome.test.ts                                                              |    80 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotXp.test.ts                                                                   |    37 +
 fluxer_api/src/api/guild/micupbot/tests/MicupBotXpFlush.test.ts                                                              |   114 +
 fluxer_api/src/api/guild/repositories/GuildDataRepository.ts                                                                 |    20 +-
 fluxer_api/src/api/guild/repositories/GuildDiscoveryRepository.test.ts                                                       |    85 +
 fluxer_api/src/api/guild/repositories/GuildDiscoveryRepository.ts                                                            |     7 +-
 fluxer_api/src/api/guild/repositories/GuildMemberRepository.ts                                                               |     3 +
 fluxer_api/src/api/guild/roster/GuildRosterBot.ts                                                                            |    39 +
 fluxer_api/src/api/guild/roster/GuildRosterComponents.ts                                                                     |    87 +
 fluxer_api/src/api/guild/roster/GuildRosterConstants.ts                                                                      |    37 +
 fluxer_api/src/api/guild/roster/GuildRosterController.ts                                                                     |   147 +
 fluxer_api/src/api/guild/roster/GuildRosterEmbed.ts                                                                          |   122 +
 fluxer_api/src/api/guild/roster/GuildRosterReactionHook.ts                                                                   |    49 +
 fluxer_api/src/api/guild/roster/GuildRosterRepository.ts                                                                     |   106 +
 fluxer_api/src/api/guild/roster/GuildRosterRuntime.ts                                                                        |   547 +
 fluxer_api/src/api/guild/roster/GuildRosterService.ts                                                                        |   314 +
 fluxer_api/src/api/guild/roster/GuildRosterSettingsService.ts                                                                |   229 +
 fluxer_api/src/api/guild/roster/GuildRosterTables.ts                                                                         |    26 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterAnnounce.test.ts                                                            |   268 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterBot.test.ts                                                                 |    97 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterCheck.test.ts                                                               |   436 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterComponentTestUtils.ts                                                       |    39 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterComponents.test.ts                                                          |   142 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterEmbed.test.ts                                                               |    94 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterReactionHook.test.ts                                                        |   174 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterRepository.test.ts                                                          |   163 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterService.test.ts                                                             |   316 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterSettingsPermissions.test.ts                                                 |   123 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterSettingsRoutes.test.ts                                                      |   411 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterSettingsTestUtils.ts                                                        |    60 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterSync.test.ts                                                                |   376 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterTestUtils.ts                                                                |   150 +
 fluxer_api/src/api/guild/roster/tests/GuildRosterTypes.test.ts                                                               |    40 +
 fluxer_api/src/api/guild/services/GuildChannelService.ts                                                                     |     6 +-
 fluxer_api/src/api/guild/services/GuildDiscoveryService.ts                                                                   |    29 +-
 fluxer_api/src/api/guild/services/GuildMemberService.ts                                                                      |     4 +-
 fluxer_api/src/api/guild/services/GuildMfaEnforcement.ts                                                                     |     2 +-
 fluxer_api/src/api/guild/services/GuildModerationService.ts                                                                  |    22 +-
 fluxer_api/src/api/guild/services/GuildRoleService.ts                                                                        |     2 +-
 fluxer_api/src/api/guild/services/GuildService.ts                                                                            |    67 +-
 fluxer_api/src/api/guild/services/channel/ChannelOperationsService.ts                                                        |    28 +-
 fluxer_api/src/api/guild/services/data/GuildOperationsService.ts                                                             |    62 +-
 fluxer_api/src/api/guild/services/data/GuildVanityRace.test.ts                                                               |   476 +
 fluxer_api/src/api/guild/services/data/GuildVanityReserved.test.ts                                                           |    50 +
 fluxer_api/src/api/guild/services/data/GuildVanityService.ts                                                                 |   181 +-
 fluxer_api/src/api/guild/services/member/GuildMemberCountConcurrency.test.ts                                                 |   274 +
 fluxer_api/src/api/guild/services/member/GuildMemberOperationsService.ts                                                     |    65 +-
 fluxer_api/src/api/guild/services/member/GuildMemberValidationService.ts                                                     |    10 +-
 fluxer_api/src/api/guild/tests/GuildBoostChannelLimits.test.ts                                                               |   245 +
 fluxer_api/src/api/guild/tests/GuildBoostRoleLimits.test.ts                                                                  |   145 +
 fluxer_api/src/api/guild/tests/GuildCreationEmailVerification.test.ts                                                        |     5 +
 fluxer_api/src/api/guild/tests/GuildDeletionAttachmentPurgeTextChannels.test.ts                                              |    58 +
 fluxer_api/src/api/guild/tests/GuildOperationPermissions.test.ts                                                             |     7 +-
 fluxer_api/src/api/guild/tests/GuildTemplateImport.test.ts                                                                   |    33 +-
 fluxer_api/src/api/guild/tests/OfficialBotComponentRouter.test.ts                                                            |   145 +
 fluxer_api/src/api/guild/tests/OfficialBotReactionHook.test.ts                                                               |   132 +
 fluxer_api/src/api/infrastructure/BunnyCachePurgeAdapter.ts                                                                  |   143 +
 fluxer_api/src/api/infrastructure/CachePurgeAdapter.ts                                                                       |     8 +
 fluxer_api/src/api/infrastructure/CachePurgePaths.test.ts                                                                    |    33 +
 fluxer_api/src/api/infrastructure/CachePurgePaths.ts                                                                         |    12 +
 fluxer_api/src/api/infrastructure/CachePurgeQueue.ts                                                                         |    93 +-
 fluxer_api/src/api/infrastructure/DisabledLiveKitService.ts                                                                  |    10 +-
 fluxer_api/src/api/infrastructure/DiscriminatorService.ts                                                                    |     7 +
 fluxer_api/src/api/infrastructure/EntityAssetService.ts                                                                      |   109 +-
 fluxer_api/src/api/infrastructure/GatewayRpcClient.ts                                                                        |     9 +-
 fluxer_api/src/api/infrastructure/GatewayService.ts                                                                          |    83 +-
 fluxer_api/src/api/infrastructure/IGatewayService.ts                                                                         |     9 +
 fluxer_api/src/api/infrastructure/ILiveKitService.ts                                                                         |    13 +
 fluxer_api/src/api/infrastructure/KVCounterService.test.ts                                                                   |   618 +
 fluxer_api/src/api/infrastructure/KVCounterService.ts                                                                        |   260 +
 fluxer_api/src/api/infrastructure/KVCounterSliceFlush.ts                                                                     |    74 +
 fluxer_api/src/api/infrastructure/LiveKitService.ts                                                                          |    27 +-
 fluxer_api/src/api/infrastructure/LiveKitWebhookService.ts                                                                   |    64 +-
 fluxer_api/src/api/infrastructure/UserCacheService.test.ts                                                                   |     4 +
 fluxer_api/src/api/infrastructure/UserCacheService.ts                                                                        |    20 +
 fluxer_api/src/api/infrastructure/UsersContentVisibility.test.ts                                                             |    93 +
 fluxer_api/src/api/infrastructure/UsersServiceClient.ts                                                                      |   117 +-
 fluxer_api/src/api/infrastructure/activity/tests/ModerationEvents.test.ts                                                    |     1 +
 fluxer_api/src/api/infrastructure/tests/BunnyCachePurgeAdapter.test.ts                                                       |   653 +
 fluxer_api/src/api/infrastructure/tests/CachePurgeQueueOnly.test.ts                                                          |    43 +
 fluxer_api/src/api/infrastructure/tests/DiscriminatorServiceSelfHosted.test.ts                                               |    28 +
 fluxer_api/src/api/infrastructure/tests/GameActivityPolicyAck.test.ts                                                        |   200 +
 fluxer_api/src/api/infrastructure/tests/GatewayVoiceDisconnectParams.test.ts                                                 |    44 +
 fluxer_api/src/api/infrastructure/tests/LiveKitService.test.ts                                                               |   124 +-
 fluxer_api/src/api/infrastructure/tests/LiveKitWebhookService.test.ts                                                        |   299 +-
 fluxer_api/src/api/instance/AccountIdentityModeCache.ts                                                                      |    42 +-
 fluxer_api/src/api/instance/DateOfBirthCollectionCache.ts                                                                    |     4 +-
 fluxer_api/src/api/instance/GatewayRolloutConfigPublisher.test.ts                                                            |     3 +
 fluxer_api/src/api/instance/InstanceConfigCache.ts                                                                           |    51 +-
 fluxer_api/src/api/instance/InstanceConfigRepository.test.ts                                                                 |   453 +-
 fluxer_api/src/api/instance/InstanceConfigRepository.ts                                                                      |  1033 +-
 fluxer_api/src/api/instance/InstanceConfigRepositoryBilling.test.ts                                                          |     4 +-
 fluxer_api/src/api/instance/InstanceController.test.ts                                                                       |   281 +-
 fluxer_api/src/api/instance/InstanceController.ts                                                                            |   100 +-
 fluxer_api/src/api/instance/OfficialAppsConfig.test.ts                                                                       |   118 +
 fluxer_api/src/api/instance/OfficialAppsEligibilityCache.test.ts                                                             |   188 +
 fluxer_api/src/api/instance/OfficialAppsEligibilityCache.ts                                                                  |   134 +
 fluxer_api/src/api/instance/OfficialAppsEligibilityConstants.ts                                                              |     6 +
 fluxer_api/src/api/instance/tests/AccountIdentityMode.test.ts                                                                |    35 +-
 fluxer_api/src/api/instance/tests/InstanceLocalization.test.ts                                                               |   132 +
 fluxer_api/src/api/instance/tests/InstanceSourceUrl.test.ts                                                                  |   129 +
 fluxer_api/src/api/instance/tests/ReferralConfig.test.ts                                                                     |    85 +
 fluxer_api/src/api/instance/tests/VoiceRoomConfig.test.ts                                                                    |    89 +
 fluxer_api/src/api/invite/InviteRepository.ts                                                                                |   102 +-
 fluxer_api/src/api/invite/InviteRequestService.ts                                                                            |    15 +-
 fluxer_api/src/api/invite/InviteService.ts                                                                                   |    14 +-
 fluxer_api/src/api/invite/tests/InviteResponseCache.test.ts                                                                  |    83 +
 fluxer_api/src/api/invite/tests/InviteSecurityChecks.test.ts                                                                 |    63 +-
 fluxer_api/src/api/limits/tests/LimitConfigDefaults.test.ts                                                                  |    10 +-
 fluxer_api/src/api/middleware/AuthMiddleware.ts                                                                              |    13 +
 fluxer_api/src/api/middleware/CaptchaMiddleware.ts                                                                           |    32 +-
 fluxer_api/src/api/middleware/ContentFilterMiddleware.ts                                                                     |     5 +
 fluxer_api/src/api/middleware/IpBanMiddleware.ts                                                                             |    66 +-
 fluxer_api/src/api/middleware/ProfileSubstringBlocklistCache.ts                                                              |    60 +-
 fluxer_api/src/api/middleware/RequestCacheMiddleware.ts                                                                      |     3 +
 fluxer_api/src/api/middleware/ResponseTypeMiddleware.ts                                                                      |     3 +-
 fluxer_api/src/api/middleware/ServiceMiddleware.ts                                                                           |   133 +
 fluxer_api/src/api/middleware/ServiceRegistry.ts                                                                             |    70 +
 fluxer_api/src/api/middleware/ServiceSingletons.ts                                                                           |   617 +-
 fluxer_api/src/api/middleware/tests/CaptchaMiddleware.test.ts                                                                |     7 +-
 fluxer_api/src/api/middleware/tests/ContentFilterMiddleware.test.ts                                                          |     5 +
 fluxer_api/src/api/middleware/tests/IpBanMiddleware.test.ts                                                                  |    63 +
 fluxer_api/src/api/middleware/tests/LazyServiceProvider.test.ts                                                              |    22 +
 fluxer_api/src/api/middleware/tests/LegacyAccountLogin.test.ts                                                               |    51 +
 fluxer_api/src/api/middleware/tests/ResponseTypeMiddleware.test.ts                                                           |    18 +
 fluxer_api/src/api/middleware/tests/RuntimeEmailServiceHtml.test.ts                                                          |    86 +
 fluxer_api/src/api/middleware/tests/TurnstileProvider.test.ts                                                                |    63 +
 fluxer_api/src/api/models/Channel.ts                                                                                         |     3 +
 fluxer_api/src/api/models/GiftCode.ts                                                                                        |    29 +-
 fluxer_api/src/api/models/Guild.ts                                                                                           |     6 +
 fluxer_api/src/api/models/Message.ts                                                                                         |     5 +-
 fluxer_api/src/api/models/User.ts                                                                                            |    36 +
 fluxer_api/src/api/models/UserSettings.ts                                                                                    |    16 +-
 fluxer_api/src/api/models/tests/GiftCode.test.ts                                                                             |    17 +
 fluxer_api/src/api/models/tests/UserSettingsDefaultTheme.test.ts                                                             |    21 +
 fluxer_api/src/api/oauth/ApplicationService.ts                                                                               |     8 +-
 fluxer_api/src/api/oauth/BotAuthService.ts                                                                                   |     3 +
 fluxer_api/src/api/oauth/OAuth2ApplicationsController.ts                                                                     |    20 +-
 fluxer_api/src/api/oauth/OAuth2Controller.ts                                                                                 |    16 +-
 fluxer_api/src/api/oauth/OAuth2RequestService.ts                                                                             |     5 +
 fluxer_api/src/api/oauth/repositories/ApplicationRepository.test.ts                                                          |   158 +
 fluxer_api/src/api/oauth/repositories/ApplicationRepository.ts                                                               |   111 +-
 fluxer_api/src/api/oauth/tests/OAuth2ApplicationDelete.test.ts                                                               |    34 +
 fluxer_api/src/api/oauth/tests/UsernamePolicySharedFixtures.test.ts                                                          |    74 +
 fluxer_api/src/api/oauth/tests/UsernameSelectionOAuthGate.test.ts                                                            |   168 +
 fluxer_api/src/api/openapi/openapi.json                                                                                      | 15679 +++++++++++++++-----
 fluxer_api/src/api/openapi/tests/MicupOpenApiRoutes.test.ts                                                                  |   149 +
 fluxer_api/src/api/payriff/PayriffCallbackController.ts                                                                      |    92 +
 fluxer_api/src/api/payriff/PayriffCallbackToken.ts                                                                           |    27 +
 fluxer_api/src/api/payriff/PayriffClient.ts                                                                                  |   131 +
 fluxer_api/src/api/payriff/PayriffRateLimiter.ts                                                                             |    72 +
 fluxer_api/src/api/payriff/PayriffVerifyTrigger.ts                                                                           |    54 +
 fluxer_api/src/api/payriff/tests/PayriffCallback.test.ts                                                                     |   248 +
 fluxer_api/src/api/payriff/tests/PayriffCallbackToken.test.ts                                                                |    57 +
 fluxer_api/src/api/payriff/tests/PayriffClient.test.ts                                                                       |    97 +
 fluxer_api/src/api/payriff/tests/PayriffLogging.test.ts                                                                      |    61 +
 fluxer_api/src/api/payriff/tests/PayriffRateLimiter.test.ts                                                                  |   107 +
 fluxer_api/src/api/premium/PremiumController.ts                                                                              |    46 +
 fluxer_api/src/api/premium/ledger/PremiumLedger.test.ts                                                                      |   311 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerAdminController.ts                                                            |    46 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerDeletion.test.ts                                                              |   110 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerEnd.test.ts                                                                   |   219 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerGrantKeys.test.ts                                                             |   139 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerRaces.test.ts                                                                 |   541 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerRepository.ts                                                                 |   144 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerService.ts                                                                    |   381 +
 fluxer_api/src/api/premium/ledger/PremiumLedgerTables.ts                                                                     |    33 +
 fluxer_api/src/api/premium/trial/PremiumTrial.test.ts                                                                        |   441 +
 fluxer_api/src/api/premium/trial/PremiumTrialNetworkRateLimit.ts                                                             |    40 +
 fluxer_api/src/api/premium/trial/PremiumTrialRepository.ts                                                                   |    24 +
 fluxer_api/src/api/premium/trial/PremiumTrialService.ts                                                                      |   121 +
 fluxer_api/src/api/premium/trial/PremiumTrialTables.ts                                                                       |    10 +
 fluxer_api/src/api/premium/visionary/VisionaryAdminController.ts                                                             |   141 +
 fluxer_api/src/api/premium/visionary/VisionaryRepository.ts                                                                  |    58 +
 fluxer_api/src/api/premium/visionary/VisionaryService.ts                                                                     |   434 +
 fluxer_api/src/api/premium/visionary/tests/VisionaryAdminGrant.test.ts                                                       |   162 +
 fluxer_api/src/api/premium/visionary/tests/VisionaryAdminSlots.test.ts                                                       |    98 +
 fluxer_api/src/api/premium/visionary/tests/VisionaryDiscriminator.test.ts                                                    |    94 +
 fluxer_api/src/api/premium/visionary/tests/VisionaryLifetime.test.ts                                                         |   215 +
 fluxer_api/src/api/premium/visionary/tests/VisionaryRewards.test.ts                                                          |   226 +
 fluxer_api/src/api/premium/visionary/tests/VisionarySlots.test.ts                                                            |   323 +
 fluxer_api/src/api/premium/visionary/tests/VisionaryTestUtils.ts                                                             |    80 +
 fluxer_api/src/api/push/ApnsPushService.ts                                                                                   |     2 +-
 fluxer_api/src/api/push/tests/ApnsPushService.test.ts                                                                        |     8 +
 fluxer_api/src/api/rate_limit_configs/AuthRateLimitConfig.ts                                                                 |     2 +-
 fluxer_api/src/api/rate_limit_configs/BadgeRateLimitConfig.ts                                                                |    19 +
 fluxer_api/src/api/rate_limit_configs/CosmeticRateLimitConfig.ts                                                             |    32 +
 fluxer_api/src/api/rate_limit_configs/FeedRateLimitConfig.ts                                                                 |   115 +
 fluxer_api/src/api/rate_limit_configs/FollowRateLimitConfig.ts                                                               |    28 +
 fluxer_api/src/api/rate_limit_configs/GuildBoostRateLimitConfig.ts                                                           |    23 +
 fluxer_api/src/api/rate_limit_configs/GuildRosterRateLimitConfig.ts                                                          |    15 +
 fluxer_api/src/api/rate_limit_configs/MessageComponentRateLimitConfig.ts                                                     |    12 +
 fluxer_api/src/api/rate_limit_configs/MicupBotRateLimitConfig.ts                                                             |    17 +
 fluxer_api/src/api/rate_limit_configs/PremiumTrialRateLimitConfig.ts                                                         |    22 +
 fluxer_api/src/api/rate_limit_configs/ReferralRateLimitConfig.ts                                                             |    15 +
 fluxer_api/src/api/rate_limit_configs/ShopRateLimitConfig.ts                                                                 |    47 +
 fluxer_api/src/api/rate_limit_configs/UserRateLimitConfig.ts                                                                 |     6 +
 fluxer_api/src/api/rate_limit_configs/UsernameAvailabilityRateLimit.ts                                                       |    44 +
 fluxer_api/src/api/rate_limit_configs/VoiceRoomRateLimitConfig.ts                                                            |    32 +
 fluxer_api/src/api/referral/ReferralAdminController.ts                                                                       |   280 +
 fluxer_api/src/api/referral/ReferralAdminService.ts                                                                          |   296 +
 fluxer_api/src/api/referral/ReferralController.ts                                                                            |    33 +
 fluxer_api/src/api/referral/ReferralCounters.ts                                                                              |    56 +
 fluxer_api/src/api/referral/ReferralRepository.ts                                                                            |   512 +
 fluxer_api/src/api/referral/ReferralRewardService.ts                                                                         |   477 +
 fluxer_api/src/api/referral/ReferralRules.ts                                                                                 |   110 +
 fluxer_api/src/api/referral/ReferralService.ts                                                                               |   126 +
 fluxer_api/src/api/referral/ReferralTables.ts                                                                                |    93 +
 fluxer_api/src/api/referral/ReferralUserLifecycleHooks.ts                                                                    |    51 +
 fluxer_api/src/api/referral/tests/ReferralAdmin.test.ts                                                                      |   463 +
 fluxer_api/src/api/referral/tests/ReferralBackfill.test.ts                                                                   |   188 +
 fluxer_api/src/api/referral/tests/ReferralCassandra.test.ts                                                                  |   178 +
 fluxer_api/src/api/referral/tests/ReferralChecks.test.ts                                                                     |   153 +
 fluxer_api/src/api/referral/tests/ReferralCode.test.ts                                                                       |   104 +
 fluxer_api/src/api/referral/tests/ReferralCounters.test.ts                                                                   |    62 +
 fluxer_api/src/api/referral/tests/ReferralEvaluation.test.ts                                                                 |   447 +
 fluxer_api/src/api/referral/tests/ReferralGrant.test.ts                                                                      |   155 +
 fluxer_api/src/api/referral/tests/ReferralLifecycle.test.ts                                                                  |   195 +
 fluxer_api/src/api/referral/tests/ReferralMe.test.ts                                                                         |   164 +
 fluxer_api/src/api/referral/tests/ReferralRegistration.test.ts                                                               |   218 +
 fluxer_api/src/api/referral/tests/ReferralRepository.test.ts                                                                 |   339 +
 fluxer_api/src/api/referral/tests/ReferralRewardTestUtils.ts                                                                 |   190 +
 fluxer_api/src/api/referral/tests/ReferralRules.test.ts                                                                      |   159 +
 fluxer_api/src/api/report/IReportRepository.ts                                                                               |     2 +
 fluxer_api/src/api/report/ReportService.ts                                                                                   |   222 +-
 fluxer_api/src/api/risk/AccountPolicyEvaluator.ts                                                                            |  1066 ++
 fluxer_api/src/api/risk/PlusAddressUtils.ts                                                                                  |    19 +
 fluxer_api/src/api/risk/RegistrationEventsRepository.ts                                                                      |   173 +
 fluxer_api/src/api/risk/RiskTypes.ts                                                                                         |   246 +
 fluxer_api/src/api/risk/adapters/DisposableDomainChecker.ts                                                                  |    23 +
 fluxer_api/src/api/risk/adapters/VelocityAdapter.ts                                                                          |    26 +
 fluxer_api/src/api/rpc/RpcService.ts                                                                                         |   111 +-
 fluxer_api/src/api/rpc/RpcSessionStartService.ts                                                                             |   114 +-
 fluxer_api/src/api/rpc/tests/RpcGameActivityBootstrap.test.ts                                                                |   241 +
 fluxer_api/src/api/rpc/tests/RpcGuildMemberCountRepair.test.ts                                                               |    83 +-
 fluxer_api/src/api/rpc/tests/RpcGuildThreadSeedTrigger.test.ts                                                               |     4 +-
 fluxer_api/src/api/rpc/tests/RpcVoiceMembershipHooks.test.ts                                                                 |   162 +
 fluxer_api/src/api/rpc/tests/UsernameLegacySessionIdentity.test.ts                                                           |    81 +
 fluxer_api/src/api/rpc/tests/UsernameMigrationReady.test.ts                                                                  |    64 +
 fluxer_api/src/api/rpc/tests/UsernameMigrationSessionStart.test.ts                                                           |   295 +
 fluxer_api/src/api/search/ThreadSearchScope.test.ts                                                                          |     8 +-
 fluxer_api/src/api/search/tests/GuildSearchThreadScope.test.ts                                                               |     9 +-
 fluxer_api/src/api/search/tests/MessageSearchPermissions.test.ts                                                             |    13 +-
 fluxer_api/src/api/search/tests/ThreadSearchScopeCap.test.ts                                                                 |    13 +-
 fluxer_api/src/api/shop/ShopAdminController.ts                                                                               |   314 +
 fluxer_api/src/api/shop/ShopCatalogController.ts                                                                             |    62 +
 fluxer_api/src/api/shop/ShopCatalogService.ts                                                                                |   726 +
 fluxer_api/src/api/shop/ShopCodeController.ts                                                                                |    50 +
 fluxer_api/src/api/shop/ShopOrderAdminController.ts                                                                          |    44 +
 fluxer_api/src/api/shop/ShopOrderController.ts                                                                               |    64 +
 fluxer_api/src/api/shop/ShopOrderRepository.ts                                                                               |   129 +
 fluxer_api/src/api/shop/ShopOrderService.ts                                                                                  |   709 +
 fluxer_api/src/api/shop/ShopPriceRepository.ts                                                                               |    62 +
 fluxer_api/src/api/shop/ShopPricing.ts                                                                                       |   139 +
 fluxer_api/src/api/shop/ShopTables.ts                                                                                        |    48 +
 fluxer_api/src/api/shop/ShopTryRate.ts                                                                                       |    96 +
 fluxer_api/src/api/shop/ShopUserLifecycleHooks.ts                                                                            |    52 +
 fluxer_api/src/api/shop/tests/ShopAdminRoutes.test.ts                                                                        |   381 +
 fluxer_api/src/api/shop/tests/ShopBundleAdmin.test.ts                                                                        |   226 +
 fluxer_api/src/api/shop/tests/ShopBundleCassandra.test.ts                                                                    |   201 +
 fluxer_api/src/api/shop/tests/ShopBundleCatalog.test.ts                                                                      |   273 +
 fluxer_api/src/api/shop/tests/ShopBundleOrder.test.ts                                                                        |   425 +
 fluxer_api/src/api/shop/tests/ShopCatalogRoutes.test.ts                                                                      |   291 +
 fluxer_api/src/api/shop/tests/ShopCheckout.test.ts                                                                           |   340 +
 fluxer_api/src/api/shop/tests/ShopOrderAdmin.test.ts                                                                         |    96 +
 fluxer_api/src/api/shop/tests/ShopOrderConcurrency.test.ts                                                                   |   199 +
 fluxer_api/src/api/shop/tests/ShopOrderCreate.test.ts                                                                        |   652 +
 fluxer_api/src/api/shop/tests/ShopOrderExport.test.ts                                                                        |   236 +
 fluxer_api/src/api/shop/tests/ShopOrderReconcile.test.ts                                                                     |   619 +
 fluxer_api/src/api/shop/tests/ShopOrderRepository.test.ts                                                                    |   129 +
 fluxer_api/src/api/shop/tests/ShopOrderVerify.test.ts                                                                        |   445 +
 fluxer_api/src/api/shop/tests/ShopPricing.test.ts                                                                            |   234 +
 fluxer_api/src/api/shop/tests/ShopTestUtils.ts                                                                               |   101 +
 fluxer_api/src/api/shop/tests/ShopTryRate.test.ts                                                                            |   117 +
 fluxer_api/src/api/shop/tests/ShopTryRateConfig.test.ts                                                                      |    50 +
 fluxer_api/src/api/store_billing/StoreBillingController.ts                                                                   |     5 +
 fluxer_api/src/api/store_billing/StoreEntitlementService.ts                                                                  |     2 +
 fluxer_api/src/api/store_billing/StoreGiftFulfilment.ts                                                                      |    35 +-
 fluxer_api/src/api/store_billing/tests/StoreBillingAppStore.test.ts                                                          |   116 +-
 fluxer_api/src/api/store_billing/tests/StoreBillingStripeCoexistence.test.ts                                                 |     1 +
 fluxer_api/src/api/stripe/BillingConfigCache.ts                                                                              |    12 +-
 fluxer_api/src/api/stripe/StripeController.ts                                                                                |   124 +-
 fluxer_api/src/api/stripe/StripeModel.ts                                                                                     |     6 +-
 fluxer_api/src/api/stripe/StripeService.ts                                                                                   |     6 +-
 fluxer_api/src/api/stripe/services/PremiumStateService.ts                                                                    |    17 +-
 fluxer_api/src/api/stripe/services/StripeCheckoutService.ts                                                                  |   451 +-
 fluxer_api/src/api/stripe/services/StripeGiftReversalHandler.ts                                                              |    15 +-
 fluxer_api/src/api/stripe/services/StripeGiftService.ts                                                                      |   112 +-
 fluxer_api/src/api/stripe/tests/BillingConfigCache.test.ts                                                                   |    28 +-
 fluxer_api/src/api/stripe/tests/DormantStripeServiceTestUtils.ts                                                             |    20 +
 fluxer_api/src/api/stripe/tests/DormantStripeTestFixture.ts                                                                  |    19 +
 fluxer_api/src/api/stripe/tests/GiftCodeLogging.test.ts                                                                      |   121 +
 fluxer_api/src/api/stripe/tests/GiftCodesCosmetic.test.ts                                                                    |   305 +
 fluxer_api/src/api/stripe/tests/GiftCodesSelfHosted.test.ts                                                                  |   500 +
 fluxer_api/src/api/stripe/tests/OperatorBillingCatalog.test.ts                                                               |   274 +-
 fluxer_api/src/api/stripe/tests/PremiumStateService.test.ts                                                                  |     1 +
 fluxer_api/src/api/stripe/tests/SelfHostedPremiumRoutes.test.ts                                                              |    64 +-
 fluxer_api/src/api/stripe/tests/StripeCheckoutCountryEnforcement.test.ts                                                     |     1 +
 fluxer_api/src/api/stripe/tests/StripeCheckoutPreapprovalLog.test.ts                                                         |    41 +
 fluxer_api/src/api/stripe/tests/StripeCustomerEmailSync.test.ts                                                              |     1 +
 fluxer_api/src/api/stripe/tests/StripeNordicCurrencies.test.ts                                                               |     1 +
 fluxer_api/src/api/stripe/tests/StripePremiumService.test.ts                                                                 |    48 +-
 fluxer_api/src/api/stripe/tests/StripeRefundService.test.ts                                                                  |    90 +-
 fluxer_api/src/api/stripe/tests/StripeSubscriptionListPriceSwitch.test.ts                                                    |    21 +-
 fluxer_api/src/api/stripe/tests/StripeSubscriptionService.test.ts                                                            |     1 +
 fluxer_api/src/api/stripe/tests/StripeWebhookCheckout.test.ts                                                                |     1 +
 fluxer_api/src/api/stripe/tests/StripeWebhookCore.test.ts                                                                    |     1 +
 fluxer_api/src/api/stripe/tests/StripeWebhookDispute.test.ts                                                                 |     1 +
 fluxer_api/src/api/stripe/tests/StripeWebhookEarlyFraudWarning.test.ts                                                       |     1 +
 fluxer_api/src/api/stripe/tests/StripeWebhookInvoice.test.ts                                                                 |     1 +
 fluxer_api/src/api/stripe/tests/StripeWebhookRefund.test.ts                                                                  |     1 +
 fluxer_api/src/api/stripe/tests/StripeWebhookSubscription.test.ts                                                            |     1 +
 fluxer_api/src/api/table_game/TableGameController.ts                                                                         |   262 +
 fluxer_api/src/api/table_game/TableGameEngines.ts                                                                            |    22 +
 fluxer_api/src/api/table_game/TableGameLimits.ts                                                                             |    27 +
 fluxer_api/src/api/table_game/TableGameRepository.ts                                                                         |   214 +
 fluxer_api/src/api/table_game/TableGameService.ts                                                                            |   855 ++
 fluxer_api/src/api/table_game/engine/Rng.test.ts                                                                             |    25 +
 fluxer_api/src/api/table_game/engine/Rng.ts                                                                                  |    10 +
 fluxer_api/src/api/table_game/engine/SearchCache.ts                                                                          |    20 +
 fluxer_api/src/api/table_game/engine/TableGameEngine.ts                                                                      |    44 +
 fluxer_api/src/api/table_game/engine/chess/ChessGame.ts                                                                      |   193 +
 fluxer_api/src/api/table_game/engine/chess/tests/ChessGame.test.ts                                                           |   264 +
 fluxer_api/src/api/table_game/engine/chess/tests/ChessGameProperty.test.ts                                                   |   122 +
 fluxer_api/src/api/table_game/engine/dama/Dama.ts                                                                            |   201 +
 fluxer_api/src/api/table_game/engine/dama/DamaCore.ts                                                                        |   399 +
 fluxer_api/src/api/table_game/engine/dama/DamaNormal.ts                                                                      |     6 +
 fluxer_api/src/api/table_game/engine/dama/DamaRules.ts                                                                       |    32 +
 fluxer_api/src/api/table_game/engine/dama/tests/Dama.test.ts                                                                 |   260 +
 fluxer_api/src/api/table_game/engine/dama/tests/DamaCore.test.ts                                                             |   261 +
 fluxer_api/src/api/table_game/engine/dama/tests/DamaProperty.test.ts                                                         |   235 +
 fluxer_api/src/api/table_game/engine/okey/ClassicOkey.ts                                                                     |   245 +
 fluxer_api/src/api/table_game/engine/okey/Okey101.ts                                                                         |   405 +
 fluxer_api/src/api/table_game/engine/okey/Okey101Rules.ts                                                                    |    25 +
 fluxer_api/src/api/table_game/engine/okey/OkeyDeck.ts                                                                        |    58 +
 fluxer_api/src/api/table_game/engine/okey/OkeyMelds.ts                                                                       |    80 +
 fluxer_api/src/api/table_game/engine/okey/tests/ClassicOkey.test.ts                                                          |   394 +
 fluxer_api/src/api/table_game/engine/okey/tests/ClassicOkeyProperty.test.ts                                                  |   104 +
 fluxer_api/src/api/table_game/engine/okey/tests/Okey101.test.ts                                                              |   521 +
 fluxer_api/src/api/table_game/engine/okey/tests/Okey101Agents.ts                                                             |   184 +
 fluxer_api/src/api/table_game/engine/okey/tests/Okey101Property.test.ts                                                      |   159 +
 fluxer_api/src/api/table_game/engine/okey/tests/OkeyDeck.test.ts                                                             |    84 +
 fluxer_api/src/api/table_game/engine/okey/tests/OkeyMelds.test.ts                                                            |   100 +
 fluxer_api/src/api/table_game/engine/tavla/Tavla.ts                                                                          |   201 +
 fluxer_api/src/api/table_game/engine/tavla/TavlaCore.ts                                                                      |   209 +
 fluxer_api/src/api/table_game/engine/tavla/TavlaRules.ts                                                                     |    13 +
 fluxer_api/src/api/table_game/engine/tavla/tests/Tavla.test.ts                                                               |   368 +
 fluxer_api/src/api/table_game/engine/tavla/tests/TavlaCore.test.ts                                                           |   211 +
 fluxer_api/src/api/table_game/engine/tavla/tests/TavlaProperty.test.ts                                                       |   183 +
 fluxer_api/src/api/table_game/engine/tests/EngineInvariants.ts                                                               |    87 +
 fluxer_api/src/api/table_game/engine/tests/OkeyAgents.ts                                                                     |   206 +
 fluxer_api/src/api/table_game/engine/tests/SearchCache.test.ts                                                               |    19 +
 fluxer_api/src/api/table_game/engine/tests/SeededRng.ts                                                                      |    27 +
 fluxer_api/src/api/table_game/tests/TableGameController.test.ts                                                              |   276 +
 fluxer_api/src/api/table_game/tests/TableGameLeak.test.ts                                                                    |   192 +
 fluxer_api/src/api/table_game/tests/TableGameMockScripts.ts                                                                  |    48 +
 fluxer_api/src/api/table_game/tests/TableGameNewKinds.test.ts                                                                |   212 +
 fluxer_api/src/api/table_game/tests/TableGameRepository.test.ts                                                              |   166 +
 fluxer_api/src/api/table_game/tests/TableGameService.test.ts                                                                 |   619 +
 fluxer_api/src/api/table_game/tests/TableGameTestFixture.ts                                                                  |   259 +
 fluxer_api/src/api/test/ApiTestHarness.ts                                                                                    |    53 +-
 fluxer_api/src/api/test/InMemoryCassandraQueryExecutor.ts                                                                    |   226 +-
 fluxer_api/src/api/test/NoopGatewayService.ts                                                                                |    25 +
 fluxer_api/src/api/test/ResetServiceState.ts                                                                                 |     4 +
 fluxer_api/src/api/test/Setup.ts                                                                                             |    15 +-
 fluxer_api/src/api/test/TestHarnessController.ts                                                                             |     3 +
 fluxer_api/src/api/test/mocks/BatchRecordingKVProvider.ts                                                                    |    10 +
 fluxer_api/src/api/test/mocks/KVHashContract.test.ts                                                                         |   126 +
 fluxer_api/src/api/test/mocks/MockKVProvider.test.ts                                                                         |    21 +
 fluxer_api/src/api/test/mocks/MockKVProvider.ts                                                                              |   207 +
 fluxer_api/src/api/test/msw/handlers/BunnyStreamHandlers.ts                                                                  |   377 +
 fluxer_api/src/api/test/msw/handlers/PayriffHandlers.ts                                                                      |   141 +
 fluxer_api/src/api/test/msw/server.ts                                                                                        |     4 +
 fluxer_api/src/api/types/HonoEnv.ts                                                                                          |    48 +
 fluxer_api/src/api/user/AccountLimit.ts                                                                                      |    13 +-
 fluxer_api/src/api/user/DeferredPhoneGateCache.ts                                                                            |    22 +
 fluxer_api/src/api/user/LegacyAccountPolicy.ts                                                                               |    34 +
 fluxer_api/src/api/user/ProfileVisibility.ts                                                                                 |     6 +-
 fluxer_api/src/api/user/UniqueUsernames.ts                                                                                   |   194 +-
 fluxer_api/src/api/user/UserHelpers.ts                                                                                       |   179 +
 fluxer_api/src/api/user/UserMappers.ts                                                                                       |    52 +-
 fluxer_api/src/api/user/controllers/UserAccountController.ts                                                                 |    87 +-
 fluxer_api/src/api/user/entrance_sound/EntranceSoundController.ts                                                            |     6 +-
 fluxer_api/src/api/user/entrance_sound/EntranceSoundPlayController.ts                                                        |     4 +-
 fluxer_api/src/api/user/entrance_sound/EntranceSoundPlayService.ts                                                           |     9 +-
 fluxer_api/src/api/user/entrance_sound/EntranceSoundService.test.ts                                                          |    21 +-
 fluxer_api/src/api/user/entrance_sound/EntranceSoundService.ts                                                               |    31 +-
 fluxer_api/src/api/user/entrance_sound/tests/EntranceSoundEntitlement.test.ts                                                |   436 +
 fluxer_api/src/api/user/lifecycle/MicupUserLifecycleHooks.ts                                                                 |    25 +
 fluxer_api/src/api/user/lifecycle/UserAccountHookPoints.test.ts                                                              |   128 +
 fluxer_api/src/api/user/lifecycle/UserLifecycleHooks.test.ts                                                                 |   304 +
 fluxer_api/src/api/user/lifecycle/UserLifecycleHooks.ts                                                                      |   189 +
 fluxer_api/src/api/user/profile/ProfileAccessCache.test.ts                                                                   |   154 +
 fluxer_api/src/api/user/profile/ProfileAccessCache.ts                                                                        |   243 +
 fluxer_api/src/api/user/profile/ProfileAccessRules.test.ts                                                                   |    65 +
 fluxer_api/src/api/user/profile/ProfileAccessRules.ts                                                                        |    59 +
 fluxer_api/src/api/user/profile/ProfileExtensionProviders.test.ts                                                            |    97 +
 fluxer_api/src/api/user/profile/ProfileExtensionProviders.ts                                                                 |    71 +
 fluxer_api/src/api/user/profile/ProfilePrivacy.test.ts                                                                       |    26 +
 fluxer_api/src/api/user/profile/ProfilePrivacy.ts                                                                            |    35 +
 fluxer_api/src/api/user/profile/ProfileUserLifecycleHooks.ts                                                                 |    60 +
 fluxer_api/src/api/user/profile/ProfileViewProjection.test.ts                                                                |   225 +
 fluxer_api/src/api/user/profile/ProfileViewProjection.ts                                                                     |   122 +
 fluxer_api/src/api/user/profile/ProfileViewer.ts                                                                             |    14 +
 fluxer_api/src/api/user/repositories/GiftCodeRepository.ts                                                                   |   138 +-
 fluxer_api/src/api/user/repositories/IUserAccountRepository.ts                                                               |    16 +-
 fluxer_api/src/api/user/repositories/IUserContentRepository.ts                                                               |     1 +
 fluxer_api/src/api/user/repositories/IUserRelationshipRepository.ts                                                          |     9 +
 fluxer_api/src/api/user/repositories/IUserSettingsRepository.ts                                                              |    12 +-
 fluxer_api/src/api/user/repositories/UserAccountRepository.ts                                                                |    21 +-
 fluxer_api/src/api/user/repositories/UserChannelRepository.ts                                                                |     1 +
 fluxer_api/src/api/user/repositories/UserContentRepository.ts                                                                |     4 +
 fluxer_api/src/api/user/repositories/UserRelationshipRepository.ts                                                           |    42 +
 fluxer_api/src/api/user/repositories/UserRepository.ts                                                                       |    46 +-
 fluxer_api/src/api/user/repositories/UserSettingsRepository.ts                                                               |   101 +-
 fluxer_api/src/api/user/repositories/account/UserAccountIdentity.test.ts                                                     |   154 +
 fluxer_api/src/api/user/repositories/account/UserAccountRepository.ts                                                        |    55 +-
 fluxer_api/src/api/user/repositories/account/UserGuildRepository.ts                                                          |     2 +
 fluxer_api/src/api/user/repositories/account/crud/UserDataRepository.ts                                                      |   157 +-
 fluxer_api/src/api/user/repositories/account/crud/UserIdentityHydration.test.ts                                              |   127 +
 fluxer_api/src/api/user/repositories/account/crud/UserIdentityWriters.test.ts                                                |   181 +
 fluxer_api/src/api/user/repositories/account/crud/UserIndexRepository.ts                                                     |    36 +-
 fluxer_api/src/api/user/repositories/account/crud/UserReadQueryCount.test.ts                                                 |    46 +
 fluxer_api/src/api/user/services/AccountStateApplier.ts                                                                      |    34 +-
 fluxer_api/src/api/user/services/EmailChangeService.ts                                                                       |    13 +-
 fluxer_api/src/api/user/services/GameActivityPolicyService.ts                                                                |   218 +
 fluxer_api/src/api/user/services/PartialUserChangePropagation.test.ts                                                        |   191 +
 fluxer_api/src/api/user/services/PartialUserChangePropagation.ts                                                             |   181 +-
 fluxer_api/src/api/user/services/ProfileAccessService.ts                                                                     |   290 +
 fluxer_api/src/api/user/services/UserAccountLookupService.ts                                                                 |   261 +-
 fluxer_api/src/api/user/services/UserAccountRequestService.ts                                                                |   141 +-
 fluxer_api/src/api/user/services/UserAccountSecurityService.ts                                                               |   117 +-
 fluxer_api/src/api/user/services/UserAccountService.ts                                                                       |    62 +-
 fluxer_api/src/api/user/services/UserAccountSettingsService.ts                                                               |    71 +-
 fluxer_api/src/api/user/services/UserChannelService.ts                                                                       |    12 +
 fluxer_api/src/api/user/services/UserDeletionService.ts                                                                      |    57 +-
 fluxer_api/src/api/user/services/UserDeletionUsername.test.ts                                                                |    98 +
 fluxer_api/src/api/user/services/UserRelationshipService.ts                                                                  |    44 +-
 fluxer_api/src/api/user/services/__tests__/PartialUserChangePropagation.test.ts                                              |   118 +-
 fluxer_api/src/api/user/tests/FriendRequestSourceFlags.test.ts                                                               |     6 +-
 fluxer_api/src/api/user/tests/GameActivityPolicy.test.ts                                                                     |   176 +
 fluxer_api/src/api/user/tests/GameActivityRevocation.test.ts                                                                 |   287 +
 fluxer_api/src/api/user/tests/GameActivitySettings.test.ts                                                                   |   203 +
 fluxer_api/src/api/user/tests/GameActivitySettingsRecovery.test.ts                                                           |   129 +
 fluxer_api/src/api/user/tests/GiftCodeCreatorIndex.test.ts                                                                   |    61 +
 fluxer_api/src/api/user/tests/HiddenProfileRoutes.test.ts                                                                    |    16 +
 fluxer_api/src/api/user/tests/InactivityDeletion.test.ts                                                                     |    19 +-
 fluxer_api/src/api/user/tests/LegacyAccountPolicy.test.ts                                                                    |    53 +
 fluxer_api/src/api/user/tests/LegacyAccountRestriction.test.ts                                                               |   164 +
 fluxer_api/src/api/user/tests/LegacyRequiredActions.test.ts                                                                  |    91 +
 fluxer_api/src/api/user/tests/ListEndpointUserPartialPrefetch.test.ts                                                        |     4 +
 fluxer_api/src/api/user/tests/MicupWriteAccountLimit.test.ts                                                                 |   112 +
 fluxer_api/src/api/user/tests/PremiumBadgeFlag.test.ts                                                                       |   171 +
 fluxer_api/src/api/user/tests/PremiumBadgePropagation.test.ts                                                                |   637 +
 fluxer_api/src/api/user/tests/ProfileAccessBonds.test.ts                                                                     |   194 +
 fluxer_api/src/api/user/tests/ProfileAccessCaching.test.ts                                                                   |   274 +
 fluxer_api/src/api/user/tests/ProfilePrivacySettings.test.ts                                                                 |   151 +
 fluxer_api/src/api/user/tests/ProfilePrivacyUnknownLevel.test.ts                                                             |    59 +
 fluxer_api/src/api/user/tests/ProfileTestUtils.ts                                                                            |    46 +
 fluxer_api/src/api/user/tests/ProfileViewCaching.test.ts                                                                     |   277 +
 fluxer_api/src/api/user/tests/ProfileVisibility.test.ts                                                                      |    22 +-
 fluxer_api/src/api/user/tests/ProfileVisibilityMatrix.test.ts                                                                |   240 +
 fluxer_api/src/api/user/tests/SelectedUsernameFriendClient.test.ts                                                           |   199 +
 fluxer_api/src/api/user/tests/UserChannelService.test.ts                                                                     |    20 +-
 fluxer_api/src/api/user/tests/UserDiscriminator0000.test.ts                                                                  |    19 +-
 fluxer_api/src/api/user/tests/UserFindUniqueAssert.test.ts                                                                   |     2 +-
 fluxer_api/src/api/user/tests/UserFlagWriteCompatibility.test.ts                                                             |    65 +
 fluxer_api/src/api/user/tests/UserFlagsResponse.test.ts                                                                      |    32 +
 fluxer_api/src/api/user/tests/UserProfileGuildPropagation.test.ts                                                            |    16 +
 fluxer_api/src/api/user/tests/UsernameAccountPaths.test.ts                                                                   |   386 +
 fluxer_api/src/api/user/tests/UsernameAvailabilityPaths.test.ts                                                              |   411 +
 fluxer_api/src/api/user/tests/UsernameAvailabilityRateLimit.test.ts                                                          |    82 +
 fluxer_api/src/api/user/tests/UsernameBlocklistPartition.test.ts                                                             |    14 +
 fluxer_api/src/api/user/tests/UsernameIdentityPrivacy.test.ts                                                                |   105 +
 fluxer_api/src/api/user/tests/UsernameIdentityPrivacyRoutes.test.ts                                                          |    66 +
 fluxer_api/src/api/user/tests/UsernameLegacyHotPathReads.test.ts                                                             |    87 +
 fluxer_api/src/api/user/tests/UsernamePromptRetry.test.ts                                                                    |    65 +
 fluxer_api/src/api/user/tests/UsernameSelectionResponse.test.ts                                                              |    79 +
 fluxer_api/src/api/user/username/UsernameOwnershipRepository.ts                                                              |   312 +
 fluxer_api/src/api/user/username/UsernameOwnershipService.ts                                                                 |   772 +
 fluxer_api/src/api/user/username/UsernamePolicyService.ts                                                                    |   323 +
 fluxer_api/src/api/user/username/UsernameRepairSweeper.ts                                                                    |   271 +
 fluxer_api/src/api/user/username/UsernameSelectionGate.ts                                                                    |    45 +
 fluxer_api/src/api/user/username/tests/DriverExecution.test.ts                                                               |   162 +
 fluxer_api/src/api/user/username/tests/DriverTimestamp.test.ts                                                               |   156 +
 fluxer_api/src/api/user/username/tests/FakeUsernamePolicyService.ts                                                          |    49 +
 fluxer_api/src/api/user/username/tests/IntentBucket.test.ts                                                                  |    36 +
 fluxer_api/src/api/user/username/tests/Ownership.cassandra.test.ts                                                           |   121 +
 fluxer_api/src/api/user/username/tests/OwnershipCorrections.test.ts                                                          |   234 +
 fluxer_api/src/api/user/username/tests/OwnershipFaults.test.ts                                                               |   471 +
 fluxer_api/src/api/user/username/tests/OwnershipIndexTimestamp.test.ts                                                       |    82 +
 fluxer_api/src/api/user/username/tests/OwnershipInvariants.ts                                                                |   159 +
 fluxer_api/src/api/user/username/tests/OwnershipProtocol.test.ts                                                             |   155 +
 fluxer_api/src/api/user/username/tests/OwnershipReviewCorrections.test.ts                                                    |    82 +
 fluxer_api/src/api/user/username/tests/RepairHoldIndex.test.ts                                                               |   102 +
 fluxer_api/src/api/user/username/tests/RepairSweeper.test.ts                                                                 |   206 +
 fluxer_api/src/api/user/username/tests/SchemaUsername.test.ts                                                                |    83 +
 fluxer_api/src/api/user/username/tests/SelectionGate.test.ts                                                                 |   109 +
 fluxer_api/src/api/user/username/tests/UsernameAdminReadRoutes.test.ts                                                       |   180 +
 fluxer_api/src/api/user/username/tests/UsernameAdminReservationList.test.ts                                                  |   143 +
 fluxer_api/src/api/user/username/tests/UsernameAuditFixes.test.ts                                                            |   101 +
 fluxer_api/src/api/user/username/tests/UsernameClaimErrorCodes.test.ts                                                       |    29 +
 fluxer_api/src/api/user/username/tests/UsernameCoordinatorTime.test.ts                                                       |    33 +
 fluxer_api/src/api/user/username/tests/UsernameLegacyPolicy.test.ts                                                          |   172 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminAudit.test.ts                                                      |    37 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminContract.test.ts                                                   |    44 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminController.test.ts                                                 |    69 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminDictionaryController.test.ts                                       |   136 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminDictionaryPublisher.test.ts                                        |   134 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminDiscovery.test.ts                                                  |    25 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminLegacyProfiles.test.ts                                             |   110 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminMigration.test.ts                                                  |   204 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminProfile.test.ts                                                    |   221 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyAdminReserve.test.ts                                                    |   329 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyCache.test.ts                                                           |   123 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyConfig.test.ts                                                          |   760 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyDictionary.test.ts                                                      |   680 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyDictionaryCleanup.test.ts                                               |   128 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyRuntime.test.ts                                                         |    62 +
 fluxer_api/src/api/user/username/tests/UsernamePolicyService.test.ts                                                         |   215 +
 fluxer_api/src/api/utils/AuditSerializationUtils.ts                                                                          |     1 +
 fluxer_api/src/api/utils/ExternalResponseLimits.ts                                                                           |     1 +
 fluxer_api/src/api/utils/RefreshSubscription.ts                                                                              |     9 +
 fluxer_api/src/api/voice/VoiceService.ts                                                                                     |     2 +
 fluxer_api/src/api/voice_seat/VoiceMembershipHooks.ts                                                                        |   134 +
 fluxer_api/src/api/voice_seat/VoiceRoomTheme.ts                                                                              |    14 +
 fluxer_api/src/api/voice_seat/VoiceSeatController.ts                                                                         |    44 +
 fluxer_api/src/api/voice_seat/VoiceSeatLimits.ts                                                                             |    22 +
 fluxer_api/src/api/voice_seat/VoiceSeatRepository.ts                                                                         |   316 +
 fluxer_api/src/api/voice_seat/VoiceSeatService.ts                                                                            |   525 +
 fluxer_api/src/api/voice_seat/tests/LiveKitAttributeGrant.integration.test.ts                                                |    88 +
 fluxer_api/src/api/voice_seat/tests/VoiceMembershipHooks.test.ts                                                             |   228 +
 fluxer_api/src/api/voice_seat/tests/VoiceRoomTheme.test.ts                                                                   |    40 +
 fluxer_api/src/api/voice_seat/tests/VoiceSeatController.test.ts                                                              |   386 +
 fluxer_api/src/api/voice_seat/tests/VoiceSeatMockScripts.ts                                                                  |   145 +
 fluxer_api/src/api/voice_seat/tests/VoiceSeatRepository.test.ts                                                              |   372 +
 fluxer_api/src/api/voice_seat/tests/VoiceSeatService.test.ts                                                                 |   964 ++
 fluxer_api/src/api/voice_seat/tests/VoiceSeatTestThemes.ts                                                                   |    18 +
 fluxer_api/src/api/webhook/tests/ChannelFollowPermissions.test.ts                                                            |     8 +-
 fluxer_api/src/api/webhook/tests/FollowerWebhookManagement.test.ts                                                           |     2 +
 fluxer_api/src/api/words/Words.ts                                                                                            |     7 +-
 fluxer_api/src/api/words/tests/Words.test.ts                                                                                 |    41 +
 fluxer_api/src/api/worker/AccountActionConsumer.ts                                                                           |     2 +
 fluxer_api/src/api/worker/ShopTryRateStartup.ts                                                                              |    26 +
 fluxer_api/src/api/worker/WorkerLaneConfig.ts                                                                                |   233 +-
 fluxer_api/src/api/worker/WorkerMain.ts                                                                                      |    66 +-
 fluxer_api/src/api/worker/WorkerTaskRegistry.ts                                                                              |   111 +
 fluxer_api/src/api/worker/tasks/AggregateFeedNotification.ts                                                                 |    29 +
 fluxer_api/src/api/worker/tasks/ApplyMicupBotAutomodAction.ts                                                                |    27 +
 fluxer_api/src/api/worker/tasks/ApplyMicupBotReactionRole.ts                                                                 |    29 +
 fluxer_api/src/api/worker/tasks/AssignPioneerBadge.ts                                                                        |    16 +
 fluxer_api/src/api/worker/tasks/BackfillFeedSuggestionRanking.ts                                                             |    19 +
 fluxer_api/src/api/worker/tasks/BackfillPioneerBadges.ts                                                                     |    88 +
 fluxer_api/src/api/worker/tasks/BackfillReferralTier.ts                                                                      |    54 +
 fluxer_api/src/api/worker/tasks/DeleteFeedVideo.ts                                                                           |    21 +
 fluxer_api/src/api/worker/tasks/DrainFeedVideoJobs.ts                                                                        |    14 +
 fluxer_api/src/api/worker/tasks/EnsureUserPremium.ts                                                                         |    17 +
 fluxer_api/src/api/worker/tasks/EvaluateReferral.ts                                                                          |    25 +
 fluxer_api/src/api/worker/tasks/ExtractFeedPostEmbeds.ts                                                                     |    22 +
 fluxer_api/src/api/worker/tasks/FanoutFeedPost.ts                                                                            |    25 +
 fluxer_api/src/api/worker/tasks/FlushCounters.ts                                                                             |    44 +
 fluxer_api/src/api/worker/tasks/FlushFeedViewCounterSlice.ts                                                                 |    37 +
 fluxer_api/src/api/worker/tasks/FlushFeedViewCounters.ts                                                                     |    20 +
 fluxer_api/src/api/worker/tasks/FlushMicupBotXp.ts                                                                           |    18 +
 fluxer_api/src/api/worker/tasks/FlushMicupBotXpSlice.ts                                                                      |    13 +
 fluxer_api/src/api/worker/tasks/GrantReferralRewards.ts                                                                      |    22 +
 fluxer_api/src/api/worker/tasks/HandleMicupBotLevelUp.ts                                                                     |    26 +
 fluxer_api/src/api/worker/tasks/HandleMicupBotMemberEvent.ts                                                                 |    26 +
 fluxer_api/src/api/worker/tasks/HarvestUserData.test.ts                                                                      |   175 +-
 fluxer_api/src/api/worker/tasks/HarvestUserData.ts                                                                           |   112 +-
 fluxer_api/src/api/worker/tasks/KeepFeedVideoEvidence.ts                                                                     |    20 +
 fluxer_api/src/api/worker/tasks/ProcessCachePurgeQueue.ts                                                                    |    41 +-
 fluxer_api/src/api/worker/tasks/ProcessExpiredPremiumSweep.ts                                                                |    43 +-
 fluxer_api/src/api/worker/tasks/ProcessFeedVideoWebhook.ts                                                                   |    20 +
 fluxer_api/src/api/worker/tasks/ProcessGuildEntitlementExpirations.ts                                                        |    12 +
 fluxer_api/src/api/worker/tasks/ProcessInactivityDeletions.ts                                                                |    54 +-
 fluxer_api/src/api/worker/tasks/ProcessInactivityDeletionsCassandra.test.ts                                                  |   172 +
 fluxer_api/src/api/worker/tasks/ProcessPremiumExpirations.test.ts                                                            |   387 +
 fluxer_api/src/api/worker/tasks/ProcessPremiumExpirations.ts                                                                 |   166 +
 fluxer_api/src/api/worker/tasks/ProcessReferralChecks.ts                                                                     |    24 +
 fluxer_api/src/api/worker/tasks/ProcessTableGameTimers.test.ts                                                               |   128 +
 fluxer_api/src/api/worker/tasks/ProcessTableGameTimers.ts                                                                    |    21 +
 fluxer_api/src/api/worker/tasks/ProcessUserDeletionHook.ts                                                                   |    25 +
 fluxer_api/src/api/worker/tasks/PropagatePartialUserChange.ts                                                                |    18 +
 fluxer_api/src/api/worker/tasks/QueueGuildRosterSlots.ts                                                                     |    15 +
 fluxer_api/src/api/worker/tasks/QueueMicupBotVoiceSlots.ts                                                                   |    13 +
 fluxer_api/src/api/worker/tasks/RebuildCounter.ts                                                                            |    18 +
 fluxer_api/src/api/worker/tasks/RebuildMicupBotLeaderboard.ts                                                                |    14 +
 fluxer_api/src/api/worker/tasks/RecomputeGuildBoost.ts                                                                       |    19 +
 fluxer_api/src/api/worker/tasks/ReconcileFeedVideoBucket.ts                                                                  |    23 +
 fluxer_api/src/api/worker/tasks/ReconcileFeedVideos.ts                                                                       |    12 +
 fluxer_api/src/api/worker/tasks/ReconcileShopOrders.ts                                                                       |    24 +
 fluxer_api/src/api/worker/tasks/RefreshFeedDiscover.ts                                                                       |    11 +
 fluxer_api/src/api/worker/tasks/RefreshFeedSuggestions.ts                                                                    |    12 +
 fluxer_api/src/api/worker/tasks/ReindexUserGuildMembers.ts                                                                   |    50 +
 fluxer_api/src/api/worker/tasks/RemoveBlockedFollows.ts                                                                      |    19 +
 fluxer_api/src/api/worker/tasks/RemoveMemberBoosts.ts                                                                        |    25 +
 fluxer_api/src/api/worker/tasks/RenderGuildRosterMessage.ts                                                                  |    29 +
 fluxer_api/src/api/worker/tasks/ResetPremiumPerkSanitization.test.ts                                                         |   175 +
 fluxer_api/src/api/worker/tasks/ResetPremiumPerkSanitization.ts                                                              |    45 +
 fluxer_api/src/api/worker/tasks/RunGuildRosterSlots.ts                                                                       |    26 +
 fluxer_api/src/api/worker/tasks/RunMicupBotCommand.ts                                                                        |    26 +
 fluxer_api/src/api/worker/tasks/RunMicupBotVoiceSlots.ts                                                                     |    16 +
 fluxer_api/src/api/worker/tasks/ScanFeedVideo.ts                                                                             |    20 +
 fluxer_api/src/api/worker/tasks/SendSystemDm.ts                                                                              |    28 +
 fluxer_api/src/api/worker/tasks/SyncGuildRosterReaction.ts                                                                   |    23 +
 fluxer_api/src/api/worker/tasks/SyncShopTryRate.ts                                                                           |    34 +
 fluxer_api/src/api/worker/tasks/UsernameAdmission.ts                                                                         |   112 +
 fluxer_api/src/api/worker/tasks/UsernameCapacityMonitor.ts                                                                   |    16 +
 fluxer_api/src/api/worker/tasks/UsernameMigrationEvidence.ts                                                                 |   128 +
 fluxer_api/src/api/worker/tasks/UsernameMigrationTasks.ts                                                                    |   102 +
 fluxer_api/src/api/worker/tasks/UsernameRuntimeAdapters.ts                                                                   |    70 +
 fluxer_api/src/api/worker/tasks/UsernameWorkerTasks.ts                                                                       |    68 +
 fluxer_api/src/api/worker/tasks/VerifyShopOrder.ts                                                                           |    40 +
 fluxer_api/src/api/worker/tasks/utils/ReferralGrantAudit.ts                                                                  |    27 +
 fluxer_api/src/api/worker/tests/AccountActionConsumer.test.ts                                                                |    99 +-
 fluxer_api/src/api/worker/tests/FlushFeedViewCounters.test.ts                                                                |   280 +
 fluxer_api/src/api/worker/tests/JetStreamWorkerQueue.test.ts                                                                 |     2 +-
 fluxer_api/src/api/worker/tests/ProcessCachePurgeQueue.test.ts                                                               |   239 +-
 fluxer_api/src/api/worker/tests/ProcessExpiredPremiumSweep.test.ts                                                           |     6 +-
 fluxer_api/src/api/worker/tests/SendSystemDmCancel.test.ts                                                                   |    47 +-
 fluxer_api/src/api/worker/tests/ShopReconcileCron.test.ts                                                                    |    37 +
 fluxer_api/src/api/worker/tests/ShopTryRateStartup.test.ts                                                                   |    24 +
 fluxer_api/src/api/worker/tests/SyncShopTryRate.test.ts                                                                      |    88 +
 fluxer_api/src/api/worker/tests/ThreadMaintenanceSweeps.test.ts                                                              |     3 +-
 fluxer_api/src/api/worker/tests/UsernameAdmission.test.ts                                                                    |    93 +
 fluxer_api/src/api/worker/tests/UsernameC19Evidence.test.ts                                                                  |   117 +
 fluxer_api/src/api/worker/tests/UsernameGatewayParity.test.ts                                                                |    63 +
 fluxer_api/src/api/worker/tests/UsernameMigrationTasks.test.ts                                                               |   101 +
 fluxer_api/src/api/worker/tests/UsernameReindex.test.ts                                                                      |   122 +
 fluxer_api/src/api/worker/tests/UsernameRuntimeClaim.test.ts                                                                 |   135 +
 fluxer_api/src/api/worker/tests/UsernameRuntimeTasks.test.ts                                                                 |   144 +
 fluxer_api/src/api/worker/tests/UsernameWorkerWiring.test.ts                                                                 |    28 +
 fluxer_api/src/api/worker/tests/WorkerLaneConfig.test.ts                                                                     |   273 +-
 fluxer_api/src/api/worker/tests/WorkerMainStartup.test.ts                                                                    |   138 +
 fluxer_api/vitest.config.ts                                                                                                  |    77 +-
 fluxer_app/index.html                                                                                                        |    24 +-
 fluxer_app/package.json                                                                                                      |     6 +
 fluxer_app/pkgs/livekit-client/VENDORING.md                                                                                  |     6 +
 fluxer_app/pkgs/livekit-client/src/room/DeviceManager.test.ts                                                                |    52 +
 fluxer_app/pkgs/livekit-client/src/room/DeviceManager.ts                                                                     |    11 +-
 fluxer_app/pkgs/livekit-client/src/room/track/LocalAudioTrack.test.ts                                                        |    84 +-
 fluxer_app/pkgs/livekit-client/src/room/track/LocalAudioTrack.ts                                                             |     2 +-
 fluxer_app/pkgs/livekit-client/src/room/track/LocalTrack.ts                                                                  |     5 +-
 fluxer_app/pkgs/livekit-client/src/room/track/LocalVideoTrack.test.ts                                                        |   103 +
 fluxer_app/pkgs/livekit-client/src/room/track/LocalVideoTrack.ts                                                             |     1 +
 fluxer_app/postcss.config.js                                                                                                 |     2 +
 fluxer_app/rspack.config.mjs                                                                                                 |    30 +-
 fluxer_app/scripts/GenerateColorSystem.ts                                                                                    |   113 +-
 fluxer_app/scripts/GenerateThemeVariables.ts                                                                                 |     3 +-
 fluxer_app/scripts/build/check-voice-scene-bundle.mjs                                                                        |    76 +
 fluxer_app/scripts/build/check-voice-scene-bundle.test.mjs                                                                   |    88 +
 fluxer_app/scripts/build/postcss/micup-shrink-font-size.mjs                                                                  |    36 +
 fluxer_app/scripts/build/rspack/noise-suppressor-worklet-loader.cjs                                                          |    32 +-
 fluxer_app/scripts/build/rspack/static-files.mjs                                                                             |    15 +-
 fluxer_app/scripts/build/rspack/voice-vad-worklet-loader.cjs                                                                 |    13 +
 fluxer_app/src/app/App.tsx                                                                                                   |     5 +-
 fluxer_app/src/app/AppBootstrap.test.tsx                                                                                     |    97 +
 fluxer_app/src/app/AppBootstrap.tsx                                                                                          |     5 +-
 fluxer_app/src/app/BootShell.css                                                                                             |     4 +-
 fluxer_app/src/app/BootShellActiveNow.test.ts                                                                                |     2 +
 fluxer_app/src/app/I18n.test.ts                                                                                              |   199 +
 fluxer_app/src/app/I18n.ts                                                                                                   |    35 +
 fluxer_app/src/app/IndexRootRedirect.test.ts                                                                                 |    83 +
 fluxer_app/src/app/RamResourceArchitecture.test.ts                                                                           |    54 +
 fluxer_app/src/app/RootHasSelectorsCss.test.ts                                                                               |   111 +
 fluxer_app/src/app/Routes.ts                                                                                                 |    17 +-
 fluxer_app/src/app/SetupHttp.ts                                                                                              |     8 +
 fluxer_app/src/app/SetupHttpUsernameSelection.test.ts                                                                        |    46 +
 fluxer_app/src/app/ShrinkFontSize.test.ts                                                                                    |    53 +
 fluxer_app/src/app/globals.css                                                                                               |    22 +-
 fluxer_app/src/app/router/RouterConstants.test.ts                                                                            |    18 +
 fluxer_app/src/app/router/RouterConstants.ts                                                                                 |     2 +-
 fluxer_app/src/app/router/components/RootComponent.tsx                                                                       |     3 +-
 fluxer_app/src/app/router/routes/AppRoutes.test.ts                                                                           |   185 +
 fluxer_app/src/app/router/routes/AppRoutes.tsx                                                                               |   148 +-
 fluxer_app/src/app/router/routes/AuthRoutes.test.ts                                                                          |   138 +
 fluxer_app/src/app/router/routes/AuthRoutes.tsx                                                                              |    28 +-
 fluxer_app/src/assets/images/games/7-days-to-die-128.webp                                                                    |   Bin 0 -> 3100 bytes
 fluxer_app/src/assets/images/games/7-days-to-die-64.webp                                                                     |   Bin 0 -> 4022 bytes
 fluxer_app/src/assets/images/games/a-way-out-128.webp                                                                        |   Bin 0 -> 1896 bytes
 fluxer_app/src/assets/images/games/a-way-out-64.webp                                                                         |   Bin 0 -> 5556 bytes
 fluxer_app/src/assets/images/games/age-of-empires-2-de-128.webp                                                              |   Bin 0 -> 6746 bytes
 fluxer_app/src/assets/images/games/age-of-empires-2-de-64.webp                                                               |   Bin 0 -> 5938 bytes
 fluxer_app/src/assets/images/games/age-of-empires-4-128.webp                                                                 |   Bin 0 -> 2462 bytes
 fluxer_app/src/assets/images/games/age-of-empires-4-64.webp                                                                  |   Bin 0 -> 4748 bytes
 fluxer_app/src/assets/images/games/american-truck-simulator-128.webp                                                         |   Bin 0 -> 11844 bytes
 fluxer_app/src/assets/images/games/american-truck-simulator-64.webp                                                          |   Bin 0 -> 3618 bytes
 fluxer_app/src/assets/images/games/among-us-128.webp                                                                         |   Bin 0 -> 2350 bytes
 fluxer_app/src/assets/images/games/among-us-64.webp                                                                          |   Bin 0 -> 6960 bytes
 fluxer_app/src/assets/images/games/apex-legends-128.webp                                                                     |   Bin 0 -> 1300 bytes
 fluxer_app/src/assets/images/games/apex-legends-64.webp                                                                      |   Bin 0 -> 650 bytes
 fluxer_app/src/assets/images/games/arena-breakout-infinite-128.webp                                                          |   Bin 0 -> 4414 bytes
 fluxer_app/src/assets/images/games/arena-breakout-infinite-64.webp                                                           |   Bin 0 -> 5770 bytes
 fluxer_app/src/assets/images/games/ark-survival-ascended-128.webp                                                            |   Bin 0 -> 2426 bytes
 fluxer_app/src/assets/images/games/ark-survival-ascended-64.webp                                                             |   Bin 0 -> 5850 bytes
 fluxer_app/src/assets/images/games/ark-survival-evolved-128.webp                                                             |   Bin 0 -> 1860 bytes
 fluxer_app/src/assets/images/games/ark-survival-evolved-64.webp                                                              |   Bin 0 -> 5512 bytes
 fluxer_app/src/assets/images/games/arma-3-128.webp                                                                           |   Bin 0 -> 3208 bytes
 fluxer_app/src/assets/images/games/arma-3-64.webp                                                                            |   Bin 0 -> 1564 bytes
 fluxer_app/src/assets/images/games/assetto-corsa-128.webp                                                                    |   Bin 0 -> 8870 bytes
 fluxer_app/src/assets/images/games/assetto-corsa-64.webp                                                                     |   Bin 0 -> 3428 bytes
 fluxer_app/src/assets/images/games/assetto-corsa-competizione-128.webp                                                       |   Bin 0 -> 4728 bytes
 fluxer_app/src/assets/images/games/assetto-corsa-competizione-64.webp                                                        |   Bin 0 -> 1146 bytes
 fluxer_app/src/assets/images/games/balatro-128.webp                                                                          |   Bin 0 -> 2478 bytes
 fluxer_app/src/assets/images/games/balatro-64.webp                                                                           |   Bin 0 -> 6174 bytes
 fluxer_app/src/assets/images/games/baldurs-gate-3-128.webp                                                                   |   Bin 0 -> 10064 bytes
 fluxer_app/src/assets/images/games/baldurs-gate-3-64.webp                                                                    |   Bin 0 -> 7102 bytes
 fluxer_app/src/assets/images/games/battlefield-1-128.webp                                                                    |   Bin 0 -> 5040 bytes
 fluxer_app/src/assets/images/games/battlefield-1-64.webp                                                                     |   Bin 0 -> 8460 bytes
 fluxer_app/src/assets/images/games/battlefield-2042-128.webp                                                                 |   Bin 0 -> 2794 bytes
 fluxer_app/src/assets/images/games/battlefield-2042-64.webp                                                                  |   Bin 0 -> 1636 bytes
 fluxer_app/src/assets/images/games/battlefield-v-128.webp                                                                    |   Bin 0 -> 4806 bytes
 fluxer_app/src/assets/images/games/battlefield-v-64.webp                                                                     |   Bin 0 -> 8154 bytes
 fluxer_app/src/assets/images/games/beamng-drive-128.webp                                                                     |   Bin 0 -> 3738 bytes
 fluxer_app/src/assets/images/games/beamng-drive-64.webp                                                                      |   Bin 0 -> 1890 bytes
 fluxer_app/src/assets/images/games/black-desert-128.webp                                                                     |   Bin 0 -> 4304 bytes
 fluxer_app/src/assets/images/games/black-desert-64.webp                                                                      |   Bin 0 -> 5746 bytes
 fluxer_app/src/assets/images/games/black-myth-wukong-128.webp                                                                |   Bin 0 -> 4016 bytes
 fluxer_app/src/assets/images/games/black-myth-wukong-64.webp                                                                 |   Bin 0 -> 4862 bytes
 fluxer_app/src/assets/images/games/call-of-duty-128.webp                                                                     |   Bin 0 -> 1854 bytes
 fluxer_app/src/assets/images/games/call-of-duty-64.webp                                                                      |   Bin 0 -> 1208 bytes
 fluxer_app/src/assets/images/games/cities-skylines-128.webp                                                                  |   Bin 0 -> 4718 bytes
 fluxer_app/src/assets/images/games/cities-skylines-2-128.webp                                                                |   Bin 0 -> 7852 bytes
 fluxer_app/src/assets/images/games/cities-skylines-2-64.webp                                                                 |   Bin 0 -> 2876 bytes
 fluxer_app/src/assets/images/games/cities-skylines-64.webp                                                                   |   Bin 0 -> 6940 bytes
 fluxer_app/src/assets/images/games/civilization-6-128.webp                                                                   |   Bin 0 -> 4354 bytes
 fluxer_app/src/assets/images/games/civilization-6-64.webp                                                                    |   Bin 0 -> 2056 bytes
 fluxer_app/src/assets/images/games/civilization-7-128.webp                                                                   |   Bin 0 -> 4576 bytes
 fluxer_app/src/assets/images/games/civilization-7-64.webp                                                                    |   Bin 0 -> 1872 bytes
 fluxer_app/src/assets/images/games/content-warning-128.webp                                                                  |   Bin 0 -> 5934 bytes
 fluxer_app/src/assets/images/games/content-warning-64.webp                                                                   |   Bin 0 -> 2738 bytes
 fluxer_app/src/assets/images/games/counter-strike-2-128.webp                                                                 |   Bin 0 -> 4042 bytes
 fluxer_app/src/assets/images/games/counter-strike-2-64.webp                                                                  |   Bin 0 -> 2118 bytes
 fluxer_app/src/assets/images/games/crusader-kings-3-128.webp                                                                 |   Bin 0 -> 2742 bytes
 fluxer_app/src/assets/images/games/crusader-kings-3-64.webp                                                                  |   Bin 0 -> 4468 bytes
 fluxer_app/src/assets/images/games/cuphead-128.webp                                                                          |   Bin 0 -> 4106 bytes
 fluxer_app/src/assets/images/games/cuphead-64.webp                                                                           |   Bin 0 -> 8936 bytes
 fluxer_app/src/assets/images/games/cyberpunk-2077-128.webp                                                                   |   Bin 0 -> 5098 bytes
 fluxer_app/src/assets/images/games/cyberpunk-2077-64.webp                                                                    |   Bin 0 -> 7534 bytes
 fluxer_app/src/assets/images/games/dark-souls-3-128.webp                                                                     |   Bin 0 -> 4818 bytes
 fluxer_app/src/assets/images/games/dark-souls-3-64.webp                                                                      |   Bin 0 -> 6774 bytes
 fluxer_app/src/assets/images/games/dayz-128.webp                                                                             |   Bin 0 -> 4026 bytes
 fluxer_app/src/assets/images/games/dayz-64.webp                                                                              |   Bin 0 -> 4760 bytes
 fluxer_app/src/assets/images/games/dead-by-daylight-128.webp                                                                 |   Bin 0 -> 2676 bytes
 fluxer_app/src/assets/images/games/dead-by-daylight-64.webp                                                                  |   Bin 0 -> 5220 bytes
 fluxer_app/src/assets/images/games/dead-cells-128.webp                                                                       |   Bin 0 -> 6312 bytes
 fluxer_app/src/assets/images/games/dead-cells-64.webp                                                                        |   Bin 0 -> 2792 bytes
 fluxer_app/src/assets/images/games/deadlock-128.webp                                                                         |   Bin 0 -> 7618 bytes
 fluxer_app/src/assets/images/games/deadlock-64.webp                                                                          |   Bin 0 -> 3874 bytes
 fluxer_app/src/assets/images/games/deep-rock-galactic-128.webp                                                               |   Bin 0 -> 2586 bytes
 fluxer_app/src/assets/images/games/deep-rock-galactic-64.webp                                                                |   Bin 0 -> 7202 bytes
 fluxer_app/src/assets/images/games/delta-force-128.webp                                                                      |   Bin 0 -> 1948 bytes
 fluxer_app/src/assets/images/games/delta-force-64.webp                                                                       |   Bin 0 -> 4028 bytes
 fluxer_app/src/assets/images/games/destiny-2-128.webp                                                                        |   Bin 0 -> 3094 bytes
 fluxer_app/src/assets/images/games/destiny-2-64.webp                                                                         |   Bin 0 -> 1590 bytes
 fluxer_app/src/assets/images/games/devour-128.webp                                                                           |   Bin 0 -> 1816 bytes
 fluxer_app/src/assets/images/games/devour-64.webp                                                                            |   Bin 0 -> 5674 bytes
 fluxer_app/src/assets/images/games/diablo-iv-128.webp                                                                        |   Bin 0 -> 7496 bytes
 fluxer_app/src/assets/images/games/diablo-iv-64.webp                                                                         |   Bin 0 -> 4996 bytes
 fluxer_app/src/assets/images/games/dont-starve-together-128.webp                                                             |   Bin 0 -> 7864 bytes
 fluxer_app/src/assets/images/games/dont-starve-together-64.webp                                                              |   Bin 0 -> 8744 bytes
 fluxer_app/src/assets/images/games/dota-2-128.webp                                                                           |   Bin 0 -> 6818 bytes
 fluxer_app/src/assets/images/games/dota-2-64.webp                                                                            |   Bin 0 -> 6724 bytes
 fluxer_app/src/assets/images/games/dying-light-128.webp                                                                      |   Bin 0 -> 2222 bytes
 fluxer_app/src/assets/images/games/dying-light-2-128.webp                                                                    |   Bin 0 -> 1856 bytes
 fluxer_app/src/assets/images/games/dying-light-2-64.webp                                                                     |   Bin 0 -> 5212 bytes
 fluxer_app/src/assets/images/games/dying-light-64.webp                                                                       |   Bin 0 -> 5744 bytes
 fluxer_app/src/assets/images/games/dyson-sphere-program-128.webp                                                             |   Bin 0 -> 2820 bytes
 fluxer_app/src/assets/images/games/dyson-sphere-program-64.webp                                                              |   Bin 0 -> 2666 bytes
 fluxer_app/src/assets/images/games/ea-sports-fc-26-128.webp                                                                  |   Bin 0 -> 6862 bytes
 fluxer_app/src/assets/images/games/ea-sports-fc-26-64.webp                                                                   |   Bin 0 -> 8508 bytes
 fluxer_app/src/assets/images/games/efootball-128.webp                                                                        |   Bin 0 -> 6958 bytes
 fluxer_app/src/assets/images/games/efootball-64.webp                                                                         |   Bin 0 -> 9096 bytes
 fluxer_app/src/assets/images/games/elden-ring-128.webp                                                                       |   Bin 0 -> 3732 bytes
 fluxer_app/src/assets/images/games/elden-ring-64.webp                                                                        |   Bin 0 -> 6452 bytes
 fluxer_app/src/assets/images/games/escape-from-tarkov-128.webp                                                               |   Bin 0 -> 7886 bytes
 fluxer_app/src/assets/images/games/escape-from-tarkov-64.webp                                                                |   Bin 0 -> 3102 bytes
 fluxer_app/src/assets/images/games/escape-the-backrooms-128.webp                                                             |   Bin 0 -> 1794 bytes
 fluxer_app/src/assets/images/games/escape-the-backrooms-64.webp                                                              |   Bin 0 -> 5058 bytes
 fluxer_app/src/assets/images/games/euro-truck-simulator-2-128.webp                                                           |   Bin 0 -> 9002 bytes
 fluxer_app/src/assets/images/games/euro-truck-simulator-2-64.webp                                                            |   Bin 0 -> 4168 bytes
 fluxer_app/src/assets/images/games/europa-universalis-4-128.webp                                                             |   Bin 0 -> 7186 bytes
 fluxer_app/src/assets/images/games/europa-universalis-4-64.webp                                                              |   Bin 0 -> 6386 bytes
 fluxer_app/src/assets/images/games/f1-25-128.webp                                                                            |   Bin 0 -> 6584 bytes
 fluxer_app/src/assets/images/games/f1-25-64.webp                                                                             |   Bin 0 -> 7416 bytes
 fluxer_app/src/assets/images/games/factorio-128.webp                                                                         |   Bin 0 -> 8052 bytes
 fluxer_app/src/assets/images/games/factorio-64.webp                                                                          |   Bin 0 -> 7174 bytes
 fluxer_app/src/assets/images/games/fall-guys-128.webp                                                                        |   Bin 0 -> 2306 bytes
 fluxer_app/src/assets/images/games/fall-guys-64.webp                                                                         |   Bin 0 -> 4332 bytes
 fluxer_app/src/assets/images/games/farming-simulator-25-128.webp                                                             |   Bin 0 -> 6180 bytes
 fluxer_app/src/assets/images/games/farming-simulator-25-64.webp                                                              |   Bin 0 -> 8672 bytes
 fluxer_app/src/assets/images/games/football-manager-2024-128.webp                                                            |   Bin 0 -> 5372 bytes
 fluxer_app/src/assets/images/games/football-manager-2024-64.webp                                                             |   Bin 0 -> 6132 bytes
 fluxer_app/src/assets/images/games/fortnite-128.webp                                                                         |   Bin 0 -> 1866 bytes
 fluxer_app/src/assets/images/games/fortnite-64.webp                                                                          |   Bin 0 -> 876 bytes
 fluxer_app/src/assets/images/games/forza-horizon-4-128.webp                                                                  |   Bin 0 -> 11252 bytes
 fluxer_app/src/assets/images/games/forza-horizon-4-64.webp                                                                   |   Bin 0 -> 4748 bytes
 fluxer_app/src/assets/images/games/forza-horizon-5-128.webp                                                                  |   Bin 0 -> 9706 bytes
 fluxer_app/src/assets/images/games/forza-horizon-5-64.webp                                                                   |   Bin 0 -> 3894 bytes
 fluxer_app/src/assets/images/games/genshin-impact-128.webp                                                                   |   Bin 0 -> 5334 bytes
 fluxer_app/src/assets/images/games/genshin-impact-64.webp                                                                    |   Bin 0 -> 6454 bytes
 fluxer_app/src/assets/images/games/ghost-of-tsushima-128.webp                                                                |   Bin 0 -> 8070 bytes
 fluxer_app/src/assets/images/games/ghost-of-tsushima-64.webp                                                                 |   Bin 0 -> 2732 bytes
 fluxer_app/src/assets/images/games/god-of-war-128.webp                                                                       |   Bin 0 -> 12228 bytes
 fluxer_app/src/assets/images/games/god-of-war-64.webp                                                                        |   Bin 0 -> 4444 bytes
 fluxer_app/src/assets/images/games/god-of-war-ragnarok-128.webp                                                              |   Bin 0 -> 8242 bytes
 fluxer_app/src/assets/images/games/god-of-war-ragnarok-64.webp                                                               |   Bin 0 -> 4974 bytes
 fluxer_app/src/assets/images/games/grand-theft-auto-v-128.webp                                                               |   Bin 0 -> 8442 bytes
 fluxer_app/src/assets/images/games/grand-theft-auto-v-64.webp                                                                |   Bin 0 -> 3660 bytes
 fluxer_app/src/assets/images/games/gta-iv-128.webp                                                                           |   Bin 0 -> 8120 bytes
 fluxer_app/src/assets/images/games/gta-iv-64.webp                                                                            |   Bin 0 -> 3410 bytes
 fluxer_app/src/assets/images/games/hades-128.webp                                                                            |   Bin 0 -> 7108 bytes
 fluxer_app/src/assets/images/games/hades-2-128.webp                                                                          |   Bin 0 -> 6922 bytes
 fluxer_app/src/assets/images/games/hades-2-64.webp                                                                           |   Bin 0 -> 7192 bytes
 fluxer_app/src/assets/images/games/hades-64.webp                                                                             |   Bin 0 -> 7002 bytes
 fluxer_app/src/assets/images/games/half-life-2-128.webp                                                                      |   Bin 0 -> 8808 bytes
 fluxer_app/src/assets/images/games/half-life-2-64.webp                                                                       |   Bin 0 -> 4036 bytes
 fluxer_app/src/assets/images/games/hearthstone-128.webp                                                                      |   Bin 0 -> 6088 bytes
 fluxer_app/src/assets/images/games/hearthstone-64.webp                                                                       |   Bin 0 -> 3862 bytes
 fluxer_app/src/assets/images/games/hearts-of-iron-4-128.webp                                                                 |   Bin 0 -> 4178 bytes
 fluxer_app/src/assets/images/games/hearts-of-iron-4-64.webp                                                                  |   Bin 0 -> 6642 bytes
 fluxer_app/src/assets/images/games/hell-let-loose-128.webp                                                                   |   Bin 0 -> 1514 bytes
 fluxer_app/src/assets/images/games/hell-let-loose-64.webp                                                                    |   Bin 0 -> 918 bytes
 fluxer_app/src/assets/images/games/helldivers-2-128.webp                                                                     |   Bin 0 -> 1260 bytes
 fluxer_app/src/assets/images/games/helldivers-2-64.webp                                                                      |   Bin 0 -> 764 bytes
 fluxer_app/src/assets/images/games/hogwarts-legacy-128.webp                                                                  |   Bin 0 -> 2652 bytes
 fluxer_app/src/assets/images/games/hogwarts-legacy-64.webp                                                                   |   Bin 0 -> 5190 bytes
 fluxer_app/src/assets/images/games/hollow-knight-128.webp                                                                    |   Bin 0 -> 7206 bytes
 fluxer_app/src/assets/images/games/hollow-knight-64.webp                                                                     |   Bin 0 -> 2994 bytes
 fluxer_app/src/assets/images/games/hollow-knight-silksong-128.webp                                                           |   Bin 0 -> 7650 bytes
 fluxer_app/src/assets/images/games/hollow-knight-silksong-64.webp                                                            |   Bin 0 -> 3104 bytes
 fluxer_app/src/assets/images/games/insurgency-sandstorm-128.webp                                                             |   Bin 0 -> 3546 bytes
 fluxer_app/src/assets/images/games/insurgency-sandstorm-64.webp                                                              |   Bin 0 -> 7796 bytes
 fluxer_app/src/assets/images/games/it-takes-two-128.webp                                                                     |   Bin 0 -> 6914 bytes
 fluxer_app/src/assets/images/games/it-takes-two-64.webp                                                                      |   Bin 0 -> 3366 bytes
 fluxer_app/src/assets/images/games/knight-online-128.webp                                                                    |   Bin 0 -> 3378 bytes
 fluxer_app/src/assets/images/games/knight-online-64.webp                                                                     |   Bin 0 -> 8104 bytes
 fluxer_app/src/assets/images/games/league-of-legends-128.webp                                                                |   Bin 0 -> 7520 bytes
 fluxer_app/src/assets/images/games/league-of-legends-64.webp                                                                 |   Bin 0 -> 4542 bytes
 fluxer_app/src/assets/images/games/left-4-dead-2-128.webp                                                                    |   Bin 0 -> 5466 bytes
 fluxer_app/src/assets/images/games/left-4-dead-2-64.webp                                                                     |   Bin 0 -> 7272 bytes
 fluxer_app/src/assets/images/games/lethal-company-128.webp                                                                   |   Bin 0 -> 11128 bytes
 fluxer_app/src/assets/images/games/lethal-company-64.webp                                                                    |   Bin 0 -> 4648 bytes
 fluxer_app/src/assets/images/games/lies-of-p-128.webp                                                                        |   Bin 0 -> 4142 bytes
 fluxer_app/src/assets/images/games/lies-of-p-64.webp                                                                         |   Bin 0 -> 5906 bytes
 fluxer_app/src/assets/images/games/lost-ark-128.webp                                                                         |   Bin 0 -> 11068 bytes
 fluxer_app/src/assets/images/games/lost-ark-64.webp                                                                          |   Bin 0 -> 4520 bytes
 fluxer_app/src/assets/images/games/marvel-rivals-128.webp                                                                    |   Bin 0 -> 5054 bytes
 fluxer_app/src/assets/images/games/marvel-rivals-64.webp                                                                     |   Bin 0 -> 2762 bytes
 fluxer_app/src/assets/images/games/metin2-128.webp                                                                           |   Bin 0 -> 2800 bytes
 fluxer_app/src/assets/images/games/metin2-64.webp                                                                            |   Bin 0 -> 7444 bytes
 fluxer_app/src/assets/images/games/minecraft-bedrock-128.webp                                                                |   Bin 0 -> 2516 bytes
 fluxer_app/src/assets/images/games/minecraft-bedrock-64.webp                                                                 |   Bin 0 -> 1242 bytes
 fluxer_app/src/assets/images/games/minecraft-java-128.webp                                                                   |   Bin 0 -> 2516 bytes
 fluxer_app/src/assets/images/games/minecraft-java-64.webp                                                                    |   Bin 0 -> 1242 bytes
 fluxer_app/src/assets/images/games/monster-hunter-rise-128.webp                                                              |   Bin 0 -> 4988 bytes
 fluxer_app/src/assets/images/games/monster-hunter-rise-64.webp                                                               |   Bin 0 -> 5318 bytes
 fluxer_app/src/assets/images/games/monster-hunter-wilds-128.webp                                                             |   Bin 0 -> 3128 bytes
 fluxer_app/src/assets/images/games/monster-hunter-wilds-64.webp                                                              |   Bin 0 -> 3936 bytes
 fluxer_app/src/assets/images/games/monster-hunter-world-128.webp                                                             |   Bin 0 -> 6006 bytes
 fluxer_app/src/assets/images/games/monster-hunter-world-64.webp                                                              |   Bin 0 -> 6116 bytes
 fluxer_app/src/assets/images/games/mount-and-blade-2-bannerlord-128.webp                                                     |   Bin 0 -> 11574 bytes
 fluxer_app/src/assets/images/games/mount-and-blade-2-bannerlord-64.webp                                                      |   Bin 0 -> 4448 bytes
 fluxer_app/src/assets/images/games/mount-and-blade-warband-128.webp                                                          |   Bin 0 -> 2034 bytes
 fluxer_app/src/assets/images/games/mount-and-blade-warband-64.webp                                                           |   Bin 0 -> 5806 bytes
 fluxer_app/src/assets/images/games/nba-2k26-128.webp                                                                         |   Bin 0 -> 7348 bytes
 fluxer_app/src/assets/images/games/nba-2k26-64.webp                                                                          |   Bin 0 -> 2840 bytes
 fluxer_app/src/assets/images/games/need-for-speed-heat-128.webp                                                              |   Bin 0 -> 2634 bytes
 fluxer_app/src/assets/images/games/need-for-speed-heat-64.webp                                                               |   Bin 0 -> 7268 bytes
 fluxer_app/src/assets/images/games/need-for-speed-unbound-128.webp                                                           |   Bin 0 -> 6964 bytes
 fluxer_app/src/assets/images/games/need-for-speed-unbound-64.webp                                                            |   Bin 0 -> 7684 bytes
 fluxer_app/src/assets/images/games/no-mans-sky-128.webp                                                                      |   Bin 0 -> 2182 bytes
 fluxer_app/src/assets/images/games/no-mans-sky-64.webp                                                                       |   Bin 0 -> 5822 bytes
 fluxer_app/src/assets/images/games/osu-128.webp                                                                              |   Bin 0 -> 8844 bytes
 fluxer_app/src/assets/images/games/osu-64.webp                                                                               |   Bin 0 -> 4406 bytes
 fluxer_app/src/assets/images/games/overwatch-2-128.webp                                                                      |   Bin 0 -> 7788 bytes
 fluxer_app/src/assets/images/games/overwatch-2-64.webp                                                                       |   Bin 0 -> 3620 bytes
 fluxer_app/src/assets/images/games/oxygen-not-included-128.webp                                                              |   Bin 0 -> 8832 bytes
 fluxer_app/src/assets/images/games/oxygen-not-included-64.webp                                                               |   Bin 0 -> 3192 bytes
 fluxer_app/src/assets/images/games/palworld-128.webp                                                                         |   Bin 0 -> 8482 bytes
 fluxer_app/src/assets/images/games/palworld-64.webp                                                                          |   Bin 0 -> 4368 bytes
 fluxer_app/src/assets/images/games/path-of-exile-128.webp                                                                    |   Bin 0 -> 7048 bytes
 fluxer_app/src/assets/images/games/path-of-exile-2-128.webp                                                                  |   Bin 0 -> 7374 bytes
 fluxer_app/src/assets/images/games/path-of-exile-2-64.webp                                                                   |   Bin 0 -> 6746 bytes
 fluxer_app/src/assets/images/games/path-of-exile-64.webp                                                                     |   Bin 0 -> 6110 bytes
 fluxer_app/src/assets/images/games/payday-2-128.webp                                                                         |   Bin 0 -> 9740 bytes
 fluxer_app/src/assets/images/games/payday-2-64.webp                                                                          |   Bin 0 -> 3118 bytes
 fluxer_app/src/assets/images/games/payday-3-128.webp                                                                         |   Bin 0 -> 2336 bytes
 fluxer_app/src/assets/images/games/payday-3-64.webp                                                                          |   Bin 0 -> 1334 bytes
 fluxer_app/src/assets/images/games/phasmophobia-128.webp                                                                     |   Bin 0 -> 11896 bytes
 fluxer_app/src/assets/images/games/phasmophobia-64.webp                                                                      |   Bin 0 -> 4558 bytes
 fluxer_app/src/assets/images/games/point-blank-128.webp                                                                      |   Bin 0 -> 3626 bytes
 fluxer_app/src/assets/images/games/point-blank-64.webp                                                                       |   Bin 0 -> 1160 bytes
 fluxer_app/src/assets/images/games/portal-2-128.webp                                                                         |   Bin 0 -> 7432 bytes
 fluxer_app/src/assets/images/games/portal-2-64.webp                                                                          |   Bin 0 -> 3440 bytes
 fluxer_app/src/assets/images/games/project-zomboid-128.webp                                                                  |   Bin 0 -> 6662 bytes
 fluxer_app/src/assets/images/games/project-zomboid-64.webp                                                                   |   Bin 0 -> 7108 bytes
 fluxer_app/src/assets/images/games/pubg-128.webp                                                                             |   Bin 0 -> 5794 bytes
 fluxer_app/src/assets/images/games/pubg-64.webp                                                                              |   Bin 0 -> 5426 bytes
 fluxer_app/src/assets/images/games/raft-128.webp                                                                             |   Bin 0 -> 10962 bytes
 fluxer_app/src/assets/images/games/raft-64.webp                                                                              |   Bin 0 -> 5476 bytes
 fluxer_app/src/assets/images/games/rainbow-six-siege-128.webp                                                                |   Bin 0 -> 6686 bytes
 fluxer_app/src/assets/images/games/rainbow-six-siege-64.webp                                                                 |   Bin 0 -> 7166 bytes
 fluxer_app/src/assets/images/games/ready-or-not-128.webp                                                                     |   Bin 0 -> 5568 bytes
 fluxer_app/src/assets/images/games/ready-or-not-64.webp                                                                      |   Bin 0 -> 3230 bytes
 fluxer_app/src/assets/images/games/red-dead-redemption-2-128.webp                                                            |   Bin 0 -> 10662 bytes
 fluxer_app/src/assets/images/games/red-dead-redemption-2-64.webp                                                             |   Bin 0 -> 9320 bytes
 fluxer_app/src/assets/images/games/remnant-2-128.webp                                                                        |   Bin 0 -> 4212 bytes
 fluxer_app/src/assets/images/games/remnant-2-64.webp                                                                         |   Bin 0 -> 6976 bytes
 fluxer_app/src/assets/images/games/repo-128.webp                                                                             |   Bin 0 -> 1746 bytes
 fluxer_app/src/assets/images/games/repo-64.webp                                                                              |   Bin 0 -> 5370 bytes
 fluxer_app/src/assets/images/games/resident-evil-4-128.webp                                                                  |   Bin 0 -> 2464 bytes
 fluxer_app/src/assets/images/games/resident-evil-4-64.webp                                                                   |   Bin 0 -> 4778 bytes
 fluxer_app/src/assets/images/games/resident-evil-village-128.webp                                                            |   Bin 0 -> 2936 bytes
 fluxer_app/src/assets/images/games/resident-evil-village-64.webp                                                             |   Bin 0 -> 5004 bytes
 fluxer_app/src/assets/images/games/rimworld-128.webp                                                                         |   Bin 0 -> 2116 bytes
 fluxer_app/src/assets/images/games/rimworld-64.webp                                                                          |   Bin 0 -> 5216 bytes
 fluxer_app/src/assets/images/games/roblox-128.webp                                                                           |   Bin 0 -> 3902 bytes
 fluxer_app/src/assets/images/games/roblox-64.webp                                                                            |   Bin 0 -> 1816 bytes
 fluxer_app/src/assets/images/games/rocket-league-128.webp                                                                    |   Bin 0 -> 5174 bytes
 fluxer_app/src/assets/images/games/rocket-league-64.webp                                                                     |   Bin 0 -> 5408 bytes
 fluxer_app/src/assets/images/games/rust-128.webp                                                                             |   Bin 0 -> 2210 bytes
 fluxer_app/src/assets/images/games/rust-64.webp                                                                              |   Bin 0 -> 1108 bytes
 fluxer_app/src/assets/images/games/satisfactory-128.webp                                                                     |   Bin 0 -> 8574 bytes
 fluxer_app/src/assets/images/games/satisfactory-64.webp                                                                      |   Bin 0 -> 3546 bytes
 fluxer_app/src/assets/images/games/scum-128.webp                                                                             |   Bin 0 -> 7572 bytes
 fluxer_app/src/assets/images/games/scum-64.webp                                                                              |   Bin 0 -> 3218 bytes
 fluxer_app/src/assets/images/games/sea-of-thieves-128.webp                                                                   |   Bin 0 -> 8528 bytes
 fluxer_app/src/assets/images/games/sea-of-thieves-64.webp                                                                    |   Bin 0 -> 3726 bytes
 fluxer_app/src/assets/images/games/sekiro-128.webp                                                                           |   Bin 0 -> 3946 bytes
 fluxer_app/src/assets/images/games/sekiro-64.webp                                                                            |   Bin 0 -> 5912 bytes
 fluxer_app/src/assets/images/games/slay-the-spire-128.webp                                                                   |   Bin 0 -> 4556 bytes
 fluxer_app/src/assets/images/games/slay-the-spire-64.webp                                                                    |   Bin 0 -> 3080 bytes
 fluxer_app/src/assets/images/games/sons-of-the-forest-128.webp                                                               |   Bin 0 -> 2880 bytes
 fluxer_app/src/assets/images/games/sons-of-the-forest-64.webp                                                                |   Bin 0 -> 7808 bytes
 fluxer_app/src/assets/images/games/spider-man-remastered-128.webp                                                            |   Bin 0 -> 7172 bytes
 fluxer_app/src/assets/images/games/spider-man-remastered-64.webp                                                             |   Bin 0 -> 3038 bytes
 fluxer_app/src/assets/images/games/split-fiction-128.webp                                                                    |   Bin 0 -> 1922 bytes
 fluxer_app/src/assets/images/games/split-fiction-64.webp                                                                     |   Bin 0 -> 4330 bytes
 fluxer_app/src/assets/images/games/squad-128.webp                                                                            |   Bin 0 -> 6800 bytes
 fluxer_app/src/assets/images/games/squad-64.webp                                                                             |   Bin 0 -> 3390 bytes
 fluxer_app/src/assets/images/games/stardew-valley-128.webp                                                                   |   Bin 0 -> 2638 bytes
 fluxer_app/src/assets/images/games/stardew-valley-64.webp                                                                    |   Bin 0 -> 6978 bytes
 fluxer_app/src/assets/images/games/stellaris-128.webp                                                                        |   Bin 0 -> 2370 bytes
 fluxer_app/src/assets/images/games/stellaris-64.webp                                                                         |   Bin 0 -> 6018 bytes
 fluxer_app/src/assets/images/games/subnautica-128.webp                                                                       |   Bin 0 -> 5408 bytes
 fluxer_app/src/assets/images/games/subnautica-64.webp                                                                        |   Bin 0 -> 7814 bytes
 fluxer_app/src/assets/images/games/team-fortress-2-128.webp                                                                  |   Bin 0 -> 3986 bytes
 fluxer_app/src/assets/images/games/team-fortress-2-64.webp                                                                   |   Bin 0 -> 1722 bytes
 fluxer_app/src/assets/images/games/terraria-128.webp                                                                         |   Bin 0 -> 7466 bytes
 fluxer_app/src/assets/images/games/terraria-64.webp                                                                          |   Bin 0 -> 4594 bytes
 fluxer_app/src/assets/images/games/the-finals-128.webp                                                                       |   Bin 0 -> 2920 bytes
 fluxer_app/src/assets/images/games/the-finals-64.webp                                                                        |   Bin 0 -> 1598 bytes
 fluxer_app/src/assets/images/games/the-forest-128.webp                                                                       |   Bin 0 -> 1598 bytes
 fluxer_app/src/assets/images/games/the-forest-64.webp                                                                        |   Bin 0 -> 4782 bytes
 fluxer_app/src/assets/images/games/the-sims-4-128.webp                                                                       |   Bin 0 -> 4022 bytes
 fluxer_app/src/assets/images/games/the-sims-4-64.webp                                                                        |   Bin 0 -> 4690 bytes
 fluxer_app/src/assets/images/games/the-witcher-3-128.webp                                                                    |   Bin 0 -> 7736 bytes
 fluxer_app/src/assets/images/games/the-witcher-3-64.webp                                                                     |   Bin 0 -> 2610 bytes
 fluxer_app/src/assets/images/games/total-war-warhammer-3-128.webp                                                            |   Bin 0 -> 11358 bytes
 fluxer_app/src/assets/images/games/total-war-warhammer-3-64.webp                                                             |   Bin 0 -> 4198 bytes
 fluxer_app/src/assets/images/games/undertale-128.webp                                                                        |   Bin 0 -> 8106 bytes
 fluxer_app/src/assets/images/games/undertale-64.webp                                                                         |   Bin 0 -> 3772 bytes
 fluxer_app/src/assets/images/games/valheim-128.webp                                                                          |   Bin 0 -> 2088 bytes
 fluxer_app/src/assets/images/games/valheim-64.webp                                                                           |   Bin 0 -> 6158 bytes
 fluxer_app/src/assets/images/games/valorant-128.webp                                                                         |   Bin 0 -> 568 bytes
 fluxer_app/src/assets/images/games/valorant-64.webp                                                                          |   Bin 0 -> 1050 bytes
 fluxer_app/src/assets/images/games/vampire-survivors-128.webp                                                                |   Bin 0 -> 2950 bytes
 fluxer_app/src/assets/images/games/vampire-survivors-64.webp                                                                 |   Bin 0 -> 6454 bytes
 fluxer_app/src/assets/images/games/warframe-128.webp                                                                         |   Bin 0 -> 6066 bytes
 fluxer_app/src/assets/images/games/warframe-64.webp                                                                          |   Bin 0 -> 2608 bytes
 fluxer_app/src/assets/images/games/wolfteam-128.webp                                                                         |   Bin 0 -> 3066 bytes
 fluxer_app/src/assets/images/games/wolfteam-64.webp                                                                          |   Bin 0 -> 1120 bytes
 fluxer_app/src/assets/images/games/world-of-warcraft-128.webp                                                                |   Bin 0 -> 7188 bytes
 fluxer_app/src/assets/images/games/world-of-warcraft-64.webp                                                                 |   Bin 0 -> 8536 bytes
 fluxer_app/src/assets/images/games/zula-128.webp                                                                             |   Bin 0 -> 6946 bytes
 fluxer_app/src/assets/images/games/zula-64.webp                                                                              |   Bin 0 -> 2270 bytes
 fluxer_app/src/features/accessibility/state/Accessibility.test.ts                                                            |   329 +
 fluxer_app/src/features/accessibility/state/Accessibility.ts                                                                 |   136 +-
 fluxer_app/src/features/accessibility/state/AccessibilityFontSizeDefault.test.ts                                             |   119 +
 fluxer_app/src/features/analytics/commands/AnalyticsCommands.test.ts                                                         |   310 +
 fluxer_app/src/features/analytics/commands/AnalyticsCommands.ts                                                              |   191 +
 fluxer_app/src/features/analytics/components/AnalyticsConsentBanner.module.css                                               |    38 +
 fluxer_app/src/features/analytics/components/AnalyticsConsentBanner.test.tsx                                                 |    91 +
 fluxer_app/src/features/analytics/components/AnalyticsConsentBanner.tsx                                                      |    94 +
 fluxer_app/src/features/analytics/components/AnalyticsPreferencesLink.module.css                                             |    21 +
 fluxer_app/src/features/analytics/components/AnalyticsPreferencesLink.test.tsx                                               |    60 +
 fluxer_app/src/features/analytics/components/AnalyticsPreferencesLink.tsx                                                    |    32 +
 fluxer_app/src/features/analytics/components/AnalyticsSettingsSection.tsx                                                    |    46 +
 fluxer_app/src/features/analytics/state/AnalyticsConsent.test.ts                                                             |   101 +
 fluxer_app/src/features/analytics/state/AnalyticsConsent.ts                                                                  |    81 +
 fluxer_app/src/features/analytics/utils/AnalyticsPage.test.ts                                                                |    71 +
 fluxer_app/src/features/analytics/utils/AnalyticsPage.ts                                                                     |    38 +
 fluxer_app/src/features/app/components/BootstrapErrorScreen.test.tsx                                                         |     8 +
 fluxer_app/src/features/app/components/BootstrapErrorScreen.tsx                                                              |    17 +-
 fluxer_app/src/features/app/components/dialogs/Modal.module.css                                                              |     9 +
 fluxer_app/src/features/app/components/dialogs/components/DesktopSettingsView.tsx                                            |     2 +
 fluxer_app/src/features/app/components/dialogs/components/FeatureComparisonTable.tsx                                         |   101 +-
 fluxer_app/src/features/app/components/dialogs/components/MobileSettingsView.module.css                                      |     8 +
 fluxer_app/src/features/app/components/dialogs/components/MobileSettingsView.tsx                                             |     5 +
 fluxer_app/src/features/app/components/dialogs/components/PerksButton.tsx                                                    |     2 +-
 fluxer_app/src/features/app/components/dialogs/components/PricingCard.module.css                                             |    67 +-
 fluxer_app/src/features/app/components/dialogs/components/PricingCard.test.tsx                                               |    77 +
 fluxer_app/src/features/app/components/dialogs/components/PricingCard.tsx                                                    |    36 +-
 fluxer_app/src/features/app/components/dialogs/components/SourceCodeLink.test.tsx                                            |    53 +
 fluxer_app/src/features/app/components/dialogs/components/SourceCodeLink.tsx                                                 |    31 +
 fluxer_app/src/features/app/components/dialogs/components/plutonium/PurchaseHistorySection.tsx                               |     2 +-
 fluxer_app/src/features/app/components/dialogs/components/plutonium/SubscriptionCard.tsx                                     |    14 +-
 fluxer_app/src/features/app/components/dialogs/shared/SettingsModalLayout.module.css                                         |     9 -
 fluxer_app/src/features/app/components/floating/ColorPickerMath.ts                                                           |     6 +
 fluxer_app/src/features/app/components/floating/ColorPickerPopover.tsx                                                       |     9 +-
 fluxer_app/src/features/app/components/floating/UserAreaAccountSwitchMenu.module.css                                         |     2 +-
 fluxer_app/src/features/app/components/floating/UserAreaPopout.module.css                                                    |    77 +
 fluxer_app/src/features/app/components/floating/UserAreaPopout.tsx                                                           |    19 +-
 fluxer_app/src/features/app/components/layout/AppLayout.tsx                                                                  |     2 +
 fluxer_app/src/features/app/components/layout/AuthLayout.module.css                                                          |    11 +-
 fluxer_app/src/features/app/components/layout/AuthLayout.tsx                                                                 |     3 +
 fluxer_app/src/features/app/components/layout/ChannelItem.module.css                                                         |    19 +
 fluxer_app/src/features/app/components/layout/ChannelItem.tsx                                                                |    49 +-
 fluxer_app/src/features/app/components/layout/ChannelListContent.tsx                                                         |     6 +-
 fluxer_app/src/features/app/components/layout/ChannelRowCss.test.ts                                                          |   180 +
 fluxer_app/src/features/app/components/layout/ChannelUnreadMemo.test.tsx                                                     |   118 +
 fluxer_app/src/features/app/components/layout/CollapsedCategoryVoiceParticipants.test.tsx                                    |   103 +
 fluxer_app/src/features/app/components/layout/CollapsedCategoryVoiceParticipants.tsx                                         |    25 +-
 fluxer_app/src/features/app/components/layout/DiscoveryLayout.tsx                                                            |     6 +-
 fluxer_app/src/features/app/components/layout/FavoritesChannelListContent.tsx                                                |    21 +-
 fluxer_app/src/features/app/components/layout/FloatingPanelCss.test.ts                                                       |    96 +
 fluxer_app/src/features/app/components/layout/GlobalOverlays.tsx                                                             |     2 +
 fluxer_app/src/features/app/components/layout/GuildBoostBannerPlacement.test.tsx                                             |   177 +
 fluxer_app/src/features/app/components/layout/GuildDetachedBanner.test.tsx                                                   |   124 +
 fluxer_app/src/features/app/components/layout/GuildDetachedBanner.tsx                                                        |    21 +-
 fluxer_app/src/features/app/components/layout/GuildNavbar.module.css                                                         |     5 +
 fluxer_app/src/features/app/components/layout/GuildNavbar.tsx                                                                |     2 +-
 fluxer_app/src/features/app/components/layout/GuildRailOrder.test.ts                                                         |    47 +
 fluxer_app/src/features/app/components/layout/GuildsLayout.module.css                                                        |    60 +-
 fluxer_app/src/features/app/components/layout/GuildsLayout.tsx                                                               |    30 +-
 fluxer_app/src/features/app/components/layout/Nagbar.tsx                                                                     |     1 +
 fluxer_app/src/features/app/components/layout/NagbarButton.module.css                                                        |     6 +
 fluxer_app/src/features/app/components/layout/NagbarTones.ts                                                                 |     6 +-
 fluxer_app/src/features/app/components/layout/UserArea.tsx                                                                   |    27 +-
 fluxer_app/src/features/app/components/layout/UserAreaDeviceMenu.test.tsx                                                    |    68 +
 fluxer_app/src/features/app/components/layout/VoiceParticipantsList.module.css                                               |     5 +
 fluxer_app/src/features/app/components/layout/VoiceParticipantsList.tsx                                                      |    90 +-
 fluxer_app/src/features/app/components/layout/app_layout/AppLayoutHooks.ts                                                   |    49 +-
 fluxer_app/src/features/app/components/layout/app_layout/AppLayoutTypes.ts                                                   |     6 +
 fluxer_app/src/features/app/components/layout/app_layout/NagbarContainer.tsx                                                 |    27 +
 fluxer_app/src/features/app/components/layout/app_layout/ProfilePrivacyNagbars.test.tsx                                      |   172 +
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/DesktopDownloadNagbar.tsx                                   |     2 +
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/PremiumExpiredNagbar.tsx                                    |    10 +-
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/PremiumGracePeriodNagbar.tsx                                |     2 +-
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/PremiumOnboardingNagbar.tsx                                 |    14 +-
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/ProfilePrivacyChangedNagbar.tsx                             |    87 +
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/ProfilePublicOfferNagbar.tsx                                |    98 +
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/TaskbarPinNagbar.tsx                                        |    53 +
 fluxer_app/src/features/app/components/layout/app_layout/nagbars/VisionaryMfaNagbar.tsx                                      |     2 +-
 fluxer_app/src/features/app/components/layout/dnd/VoiceParticipantDrop.test.ts                                               |   177 +
 fluxer_app/src/features/app/components/layout/dnd/VoiceParticipantDrop.ts                                                    |    30 +
 fluxer_app/src/features/app/components/layout/sidebar_nav/AddGuildButton.module.css                                          |     5 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/AddGuildButton.tsx                                                 |     7 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/DiscoveryButton.module.css                                         |    12 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/DiscoveryButton.tsx                                                |    12 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/DownloadButton.module.css                                          |     5 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/DownloadButton.tsx                                                 |     9 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/FavoritesButton.tsx                                                |     3 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/FeedButton.module.css                                              |    59 +
 fluxer_app/src/features/app/components/layout/sidebar_nav/FeedButton.test.tsx                                                |   108 +
 fluxer_app/src/features/app/components/layout/sidebar_nav/FeedButton.tsx                                                     |   120 +
 fluxer_app/src/features/app/components/layout/sidebar_nav/FluxerButton.tsx                                                   |     3 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/GuildListDMItem.tsx                                                |    22 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/GuildListItemContent.tsx                                           |     9 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/GuildRailTileShape.test.ts                                         |    60 +
 fluxer_app/src/features/app/components/layout/sidebar_nav/HelpButton.module.css                                              |     5 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/HelpButton.tsx                                                     |     7 +-
 fluxer_app/src/features/app/components/layout/sidebar_nav/UseGuildListItemPreload.ts                                         |    24 +-
 fluxer_app/src/features/app/components/layout/utils/ChannelUnreadState.ts                                                    |     6 +
 fluxer_app/src/features/app/components/pages/YouPage.module.css                                                              |     4 +-
 fluxer_app/src/features/app/components/pages/YouPage.tsx                                                                     |     9 +
 fluxer_app/src/features/app/components/setup/SelfHostedSetupWizardGate.tsx                                                   |     5 +-
 fluxer_app/src/features/app/components/setup/SetupWizardSteps.tsx                                                            |    30 +-
 fluxer_app/src/features/app/components/shared/FriendSelector.module.css                                                      |     2 +-
 fluxer_app/src/features/app/components/skeleton/AppSkeleton.module.css                                                       |     7 +-
 fluxer_app/src/features/app/components/skeleton/AppSkeleton.tsx                                                              |     2 +
 fluxer_app/src/features/app/components/skeleton/ChatSkeleton.module.css                                                      |     9 +
 fluxer_app/src/features/app/components/skeleton/DMSidebarSkeleton.module.css                                                 |     5 +
 fluxer_app/src/features/app/components/skeleton/DMSidebarSkeleton.tsx                                                        |     4 +
 fluxer_app/src/features/app/components/skeleton/GuildRailSkeleton.feed.test.tsx                                              |    90 +
 fluxer_app/src/features/app/components/skeleton/GuildRailSkeleton.module.css                                                 |    65 +-
 fluxer_app/src/features/app/components/skeleton/GuildRailSkeleton.tsx                                                        |    60 +-
 fluxer_app/src/features/app/components/skeleton/GuildSidebarSkeleton.module.css                                              |    11 +
 fluxer_app/src/features/app/components/skeleton/ScrollFillerSkeleton.module.css                                              |     4 +
 fluxer_app/src/features/app/components/skeleton/SidebarShellSkeleton.module.css                                              |     5 +
 fluxer_app/src/features/app/components/skeleton/Skeleton.module.css                                                          |    18 +-
 fluxer_app/src/features/app/components/skeleton/SkeletonLayoutMemory.feed.test.ts                                            |    61 +
 fluxer_app/src/features/app/components/skeleton/SkeletonLayoutMemory.ts                                                      |     6 +
 fluxer_app/src/features/app/components/skeleton/SkeletonListCss.test.ts                                                      |    61 +
 fluxer_app/src/features/app/components/skeleton/UserAreaSkeleton.module.css                                                  |    12 +
 fluxer_app/src/features/app/config/Config.ts                                                                                 |     7 +
 fluxer_app/src/features/app/config/HostedMedia.ts                                                                            |     4 +-
 fluxer_app/src/features/app/config/I18nDisplayConstants.test.ts                                                              |    10 +
 fluxer_app/src/features/app/config/I18nDisplayConstants.ts                                                                   |    29 +-
 fluxer_app/src/features/app/config/MicupBrand.test.ts                                                                        |   216 +
 fluxer_app/src/features/app/config/ProductConstants.ts                                                                       |     7 +-
 fluxer_app/src/features/app/constants/Endpoints.test.ts                                                                      |    68 +
 fluxer_app/src/features/app/constants/Endpoints.ts                                                                           |    63 +
 fluxer_app/src/features/app/domain_migration/DomainMigration.test.ts                                                         |    24 +
 fluxer_app/src/features/app/domain_migration/DomainMigrationBrowser.ts                                                       |     7 +-
 fluxer_app/src/features/app/domain_migration/DomainMigrationCore.ts                                                          |     2 +
 fluxer_app/src/features/app/domain_migration/DomainMigrationDeviceRemap.ts                                                   |     3 +-
 fluxer_app/src/features/app/domain_migration/DomainMigrationPreMount.ts                                                      |     3 +-
 fluxer_app/src/features/app/domain_migration/DomainMigrationRollout.ts                                                       |     4 +-
 fluxer_app/src/features/app/hooks/HoverPreload.test.tsx                                                                      |   317 +
 fluxer_app/src/features/app/hooks/useChannelHoverPreload.ts                                                                  |    35 +-
 fluxer_app/src/features/app/hooks/useDesktopElectronBridges.test.ts                                                          |    38 +
 fluxer_app/src/features/app/hooks/useDesktopElectronBridges.tsx                                                              |     6 +-
 fluxer_app/src/features/app/hooks/useGuildBannerPlayback.test.tsx                                                            |   467 +
 fluxer_app/src/features/app/hooks/useGuildBannerPlayback.ts                                                                  |   189 +
 fluxer_app/src/features/app/hooks/useGuildBannerPresentation.test.tsx                                                        |   112 +
 fluxer_app/src/features/app/hooks/useGuildBannerPresentation.ts                                                              |    91 +-
 fluxer_app/src/features/app/hooks/useHoverPreload.ts                                                                         |    19 +
 fluxer_app/src/features/app/keybindings/keybind_manager/handlers/defaultHandlers.test.ts                                     |    85 +
 fluxer_app/src/features/app/keybindings/keybind_manager/handlers/defaultHandlers.ts                                          |     4 +-
 fluxer_app/src/features/app/keybindings/utils/PushToTalkModeReconcile.test.ts                                                |     2 +
 fluxer_app/src/features/app/state/DesktopRuntimeTransaction.test.ts                                                          |     3 +
 fluxer_app/src/features/app/state/HoverPreloadScheduler.ts                                                                   |    67 +
 fluxer_app/src/features/app/state/InstanceSnapshotStore.test.ts                                                              |     5 +-
 fluxer_app/src/features/app/state/InstanceSnapshotStore.ts                                                                   |     2 +
 fluxer_app/src/features/app/state/RuntimeConfig.test.ts                                                                      |    92 +-
 fluxer_app/src/features/app/state/RuntimeConfig.ts                                                                           |    56 +-
 fluxer_app/src/features/app/state/RuntimeConfigSnapshot.ts                                                                   |    51 +-
 fluxer_app/src/features/app/state/Updater.ts                                                                                 |     1 +
 fluxer_app/src/features/app/utils/AnimatedImageLoop.test.ts                                                                  |   179 +
 fluxer_app/src/features/app/utils/AnimatedImageLoop.ts                                                                       |   125 +
 fluxer_app/src/features/auth/altcha/CaptchaInterceptor.test.ts                                                               |    50 +
 fluxer_app/src/features/auth/altcha/CaptchaInterceptor.ts                                                                    |    23 +-
 fluxer_app/src/features/auth/commands/AuthenticationCommands.test.ts                                                         |    71 +
 fluxer_app/src/features/auth/commands/AuthenticationCommands.ts                                                              |     8 +-
 fluxer_app/src/features/auth/components/accounts/AccountRow.module.css                                                       |    18 +
 fluxer_app/src/features/auth/components/modals/BackupCodesModal.module.css                                                   |     2 +-
 fluxer_app/src/features/auth/components/modals/TurnstileModal.module.css                                                     |     8 +
 fluxer_app/src/features/auth/components/modals/TurnstileModal.tsx                                                            |   102 +
 fluxer_app/src/features/auth/flow/AuthLoginLayout.test.tsx                                                                   |   132 +
 fluxer_app/src/features/auth/flow/AuthMinimalRegisterFormCore.tsx                                                            |    30 +
 fluxer_app/src/features/auth/flow/AuthPageStyles.module.css                                                                  |    12 +-
 fluxer_app/src/features/auth/flow/AuthRegisterFormCore.tsx                                                                   |   178 +-
 fluxer_app/src/features/auth/flow/AuthRegisterReferral.test.tsx                                                              |   235 +
 fluxer_app/src/features/auth/flow/AuthRouterLink.tsx                                                                         |    28 +-
 fluxer_app/src/features/auth/flow/AuthRuntimeTargetBoundary.tsx                                                              |    11 +-
 fluxer_app/src/features/auth/flow/AuthRuntimeTargetBridgeless.test.tsx                                                       |    36 +
 fluxer_app/src/features/auth/flow/DateOfBirthField.tsx                                                                       |     4 +-
 fluxer_app/src/features/auth/flow/DesktopColdLogin.test.tsx                                                                  |    74 +
 fluxer_app/src/features/auth/flow/GiftHeader.tsx                                                                             |    10 +-
 fluxer_app/src/features/auth/flow/RegistrationLegalConsent.test.tsx                                                          |    76 +
 fluxer_app/src/features/auth/flow/RegistrationLegalConsent.tsx                                                               |    23 +-
 fluxer_app/src/features/auth/flow/auth_login_core/AuthLoginBrowserStep.tsx                                                   |     2 +-
 fluxer_app/src/features/auth/flow/auth_login_core/AuthLoginEmailPasswordForm.tsx                                             |     3 +
 fluxer_app/src/features/auth/flow/auth_login_core/AuthLoginMethodStep.tsx                                                    |     1 +
 fluxer_app/src/features/auth/flow/instance_selector/InstanceDiscoveryFailure.ts                                              |     4 +-
 fluxer_app/src/features/auth/flow/instance_selector/InstancePickerRows.tsx                                                   |   119 +-
 fluxer_app/src/features/auth/hooks/useLoginFlow.test.ts                                                                      |     2 +
 fluxer_app/src/features/auth/hooks/useLoginFormController.test.ts                                                            |     2 +
 fluxer_app/src/features/auth/passkey_migration/PasskeyMigrationOrigin.ts                                                     |     7 +-
 fluxer_app/src/features/auth/state/NewDeviceMonitoring.test.ts                                                               |    46 +
 fluxer_app/src/features/auth/state/NewDeviceMonitoring.tsx                                                                   |     2 +
 fluxer_app/src/features/auth/state/__fixtures__/AccountRecordFixtures.ts                                                     |     3 +
 fluxer_app/src/features/auth/utils/BotInviteUrl.test.ts                                                                      |    38 +
 fluxer_app/src/features/auth/utils/BotInviteUrl.ts                                                                           |    26 +
 fluxer_app/src/features/auth/utils/OldAppSignIn.test.ts                                                                      |    10 +-
 fluxer_app/src/features/auth/utils/OldAppSignIn.ts                                                                           |     3 +-
 fluxer_app/src/features/boost/commands/GuildBoostCommands.tsx                                                                |    56 +
 fluxer_app/src/features/boost/commands/GuildBoostPanelCommands.test.tsx                                                      |    45 +
 fluxer_app/src/features/boost/commands/GuildBoostPanelCommands.tsx                                                           |    37 +
 fluxer_app/src/features/boost/components/BoostGemIcon.tsx                                                                    |    27 +
 fluxer_app/src/features/boost/components/GuildBoostActionButton.tsx                                                          |    28 +
 fluxer_app/src/features/boost/components/GuildBoostGoalRow.module.css                                                        |    94 +
 fluxer_app/src/features/boost/components/GuildBoostGoalRow.tsx                                                               |    92 +
 fluxer_app/src/features/boost/components/GuildBoostPanel.module.css                                                          |   106 +
 fluxer_app/src/features/boost/components/GuildBoostPanel.tsx                                                                 |   140 +
 fluxer_app/src/features/boost/components/GuildBoostPerks.tsx                                                                 |    59 +
 fluxer_app/src/features/boost/components/GuildBoostSurfaces.test.tsx                                                         |   331 +
 fluxer_app/src/features/boost/components/GuildBoostTab.module.css                                                            |   120 +
 fluxer_app/src/features/boost/components/GuildBoostTab.tsx                                                                   |   221 +
 fluxer_app/src/features/boost/hooks/useGuildBoostAction.ts                                                                   |    37 +
 fluxer_app/src/features/boost/state/GuildBoosts.test.ts                                                                      |   223 +
 fluxer_app/src/features/boost/state/GuildBoosts.ts                                                                           |   163 +
 fluxer_app/src/features/boost/utils/GuildBoostLevels.test.ts                                                                 |    65 +
 fluxer_app/src/features/boost/utils/GuildBoostLevels.ts                                                                      |    61 +
 fluxer_app/src/features/boost/utils/GuildBoostMessages.ts                                                                    |    74 +
 fluxer_app/src/features/bots/components/DeveloperDocumentationButton.tsx                                                     |    24 +
 fluxer_app/src/features/bots/components/pages/BotsPage.module.css                                                            |    72 +
 fluxer_app/src/features/bots/components/pages/BotsPage.test.tsx                                                              |   162 +
 fluxer_app/src/features/bots/components/pages/BotsPage.tsx                                                                   |   151 +
 fluxer_app/src/features/bots/utils/BotMessageDescriptors.ts                                                                  |    16 +
 fluxer_app/src/features/channel/commands/ChannelCommands.ts                                                                  |     1 +
 fluxer_app/src/features/channel/components/AutocompleteEmoji.module.css                                                      |     2 +-
 fluxer_app/src/features/channel/components/ChannelHeader.module.css                                                          |     6 +
 fluxer_app/src/features/channel/components/ChannelHeader.tsx                                                                 |    11 +
 fluxer_app/src/features/channel/components/ChannelMessage.tsx                                                                |    13 +-
 fluxer_app/src/features/channel/components/ChannelMessages.module.css                                                        |     4 +-
 fluxer_app/src/features/channel/components/ChannelSearchResults.module.css                                                   |     2 +-
 fluxer_app/src/features/channel/components/CompactMessageLayout.tsx                                                          |    13 +
 fluxer_app/src/features/channel/components/GifPicker.module.css                                                              |    14 +
 fluxer_app/src/features/channel/components/GiftEmbed.test.tsx                                                                |   157 +
 fluxer_app/src/features/channel/components/GiftEmbed.tsx                                                                     |    30 +-
 fluxer_app/src/features/channel/components/GuildMembersPage.module.css                                                       |     2 +-
 fluxer_app/src/features/channel/components/MemberListContainer.module.css                                                    |     5 +
 fluxer_app/src/features/channel/components/MemberListItem.test.tsx                                                           |   111 +
 fluxer_app/src/features/channel/components/MemberListItem.tsx                                                                |   120 +-
 fluxer_app/src/features/channel/components/MemesPicker.module.css                                                            |     6 +-
 fluxer_app/src/features/channel/components/MessageAttachments.tsx                                                            |     6 +
 fluxer_app/src/features/channel/components/MessageAuthorInfo.tsx                                                             |    13 +
 fluxer_app/src/features/channel/components/MessageAvatar.tsx                                                                 |     1 +
 fluxer_app/src/features/channel/components/MessageComponents.module.css                                                      |    53 +
 fluxer_app/src/features/channel/components/MessageComponents.realButton.test.tsx                                             |    55 +
 fluxer_app/src/features/channel/components/MessageComponents.test.tsx                                                        |   242 +
 fluxer_app/src/features/channel/components/MessageComponents.tsx                                                             |   109 +
 fluxer_app/src/features/channel/components/MessageReactions.module.css                                                       |    20 +-
 fluxer_app/src/features/channel/components/MessageViewContext.ts                                                             |     5 +-
 fluxer_app/src/features/channel/components/PremiumUpsellBanner.tsx                                                           |     2 +-
 fluxer_app/src/features/channel/components/ReplyPreview.relationships.test.ts                                                |   285 +
 fluxer_app/src/features/channel/components/ReplyPreview.tsx                                                                  |    31 +-
 fluxer_app/src/features/channel/components/SearchResultMessageList.test.tsx                                                  |   228 +
 fluxer_app/src/features/channel/components/SearchResultMessageList.tsx                                                       |    28 +-
 fluxer_app/src/features/channel/components/UserMessage.previewAuthor.test.tsx                                                |   182 +
 fluxer_app/src/features/channel/components/UserMessage.tsx                                                                   |    32 +-
 fluxer_app/src/features/channel/components/VoiceMessageRecorder.teardown.test.tsx                                            |   442 +
 fluxer_app/src/features/channel/components/VoiceMessageRecorder.tsx                                                          |    88 +-
 fluxer_app/src/features/channel/components/bottomsheets/ChannelDetailsBottomSheet.module.css                                 |     9 +-
 fluxer_app/src/features/channel/components/bottomsheets/ChannelDetailsBottomSheetMemberList.tsx                              |     6 +
 fluxer_app/src/features/channel/components/bottomsheets/CreateDMBottomSheet.module.css                                       |     2 +-
 fluxer_app/src/features/channel/components/bottomsheets/channel_details_bottom_sheet/DMMembersList.tsx                       |     7 +-
 fluxer_app/src/features/channel/components/channel_header_components/ChannelHeaderIcon.tsx                                   |     5 +-
 fluxer_app/src/features/channel/components/channel_header_components/UtilityButtons.module.css                               |    12 +
 fluxer_app/src/features/channel/components/channel_header_components/UtilityButtons.test.tsx                                 |   229 +
 fluxer_app/src/features/channel/components/channel_header_components/UtilityButtons.tsx                                      |    66 +-
 fluxer_app/src/features/channel/components/channel_header_components/developer_tools/AccountPremiumMenu.tsx                  |     8 +-
 fluxer_app/src/features/channel/components/channel_header_components/developer_tools/DeveloperOptionLabels.ts                |     6 +-
 fluxer_app/src/features/channel/components/channel_header_components/developer_tools/OptionPresets.ts                        |     2 +-
 fluxer_app/src/features/channel/components/channel_header_components/developer_tools/StateSummaryMenu.tsx                    |     8 +-
 fluxer_app/src/features/channel/components/channel_header_components/developer_tools/ToolsMenu.tsx                           |    11 +-
 fluxer_app/src/features/channel/components/channel_view/GuildChannelView.tsx                                                 |     4 +-
 fluxer_app/src/features/channel/components/direct_message/AddFriendForm.tsx                                                  |    16 +-
 fluxer_app/src/features/channel/components/direct_message/DMChannelView.module.css                                           |     6 +-
 fluxer_app/src/features/channel/components/direct_message/DMListItem.tsx                                                     |   384 +-
 fluxer_app/src/features/channel/components/direct_message/DMListPageItems.module.css                                         |    69 +
 fluxer_app/src/features/channel/components/direct_message/DMListPageItems.test.tsx                                           |   125 +
 fluxer_app/src/features/channel/components/direct_message/DMListPageItems.tsx                                                |   102 +
 fluxer_app/src/features/channel/components/direct_message/DMListPageItemsCss.test.ts                                         |    52 +
 fluxer_app/src/features/channel/components/direct_message/DMPageFrame.module.css                                             |   119 +
 fluxer_app/src/features/channel/components/direct_message/DMPageFrame.tsx                                                    |   179 +
 fluxer_app/src/features/channel/components/direct_message/DMWelcomeSection.tsx                                               |    38 +-
 fluxer_app/src/features/channel/components/direct_message/DirectMessageList.module.css                                       |    11 +-
 fluxer_app/src/features/channel/components/direct_message/DirectMessageList.test.tsx                                         |   210 +
 fluxer_app/src/features/channel/components/direct_message/DirectMessageList.tsx                                              |   127 +-
 fluxer_app/src/features/channel/components/embeds/attachments/TextualAttachmentPreview.module.css                            |     2 +-
 fluxer_app/src/features/channel/components/embeds/media/EmbedVideo.module.css                                                |     2 +-
 fluxer_app/src/features/channel/components/embeds/media/GifIndicator.module.css                                              |     2 +-
 fluxer_app/src/features/channel/components/embeds/media/MediaButtons.module.css                                              |     4 +-
 fluxer_app/src/features/channel/components/emoji_picker/hooks/useEmojiCategories.test.tsx                                    |   197 +
 fluxer_app/src/features/channel/components/emoji_picker/hooks/useEmojiCategories.ts                                          |     4 +-
 fluxer_app/src/features/channel/components/emoji_picker/hooks/useVirtualRows.ts                                              |     2 +-
 fluxer_app/src/features/channel/components/modals/channel_tabs/ChannelOverviewTab.test.tsx                                   |   110 +
 fluxer_app/src/features/channel/components/modals/channel_tabs/ChannelOverviewTab.tsx                                        |    10 +-
 fluxer_app/src/features/channel/components/modals/channel_tabs/channel_overview_tab/ChannelOverviewTabMatureContent.test.tsx |   161 +
 fluxer_app/src/features/channel/components/modals/channel_tabs/channel_overview_tab/VoiceSettings.test.tsx                   |   242 +
 fluxer_app/src/features/channel/components/modals/channel_tabs/channel_overview_tab/VoiceSettings.tsx                        |    42 +-
 fluxer_app/src/features/channel/components/modals/channel_tabs/channel_overview_tab/shared.ts                                |     1 +
 fluxer_app/src/features/channel/components/pickers/gif/GifPickerLoadingSkeletonGrid.tsx                                      |     5 +-
 fluxer_app/src/features/channel/models/Channel.ts                                                                            |     5 +
 fluxer_app/src/features/channel/state/ChannelFrecency.ts                                                                     |     6 +-
 fluxer_app/src/features/channel/state/ChannelFrecencySync.test.ts                                                            |   182 +
 fluxer_app/src/features/channel/utils/ChannelCreateModalUtils.test.ts                                                        |    24 +
 fluxer_app/src/features/channel/utils/ChannelCreateModalUtils.ts                                                             |     4 +-
 fluxer_app/src/features/channel/utils/GroupDMColorUtils.ts                                                                   |    12 +-
 fluxer_app/src/features/connection/components/modals/EditConnectionModal.test.tsx                                            |    87 +
 fluxer_app/src/features/connection/components/modals/EditConnectionModal.tsx                                                 |    11 +-
 fluxer_app/src/features/cosmetics/commands/CosmeticCommands.ts                                                               |    38 +
 fluxer_app/src/features/cosmetics/components/AvatarDecorationLayer.module.css                                                |    14 +
 fluxer_app/src/features/cosmetics/components/AvatarDecorationLayer.test.tsx                                                  |    97 +
 fluxer_app/src/features/cosmetics/components/AvatarDecorationLayer.tsx                                                       |    54 +
 fluxer_app/src/features/cosmetics/components/AvatarUltraFront.module.css                                                     |    43 +
 fluxer_app/src/features/cosmetics/components/AvatarUltraFront.test.tsx                                                       |   926 ++
 fluxer_app/src/features/cosmetics/components/AvatarUltraFront.tsx                                                            |   419 +
 fluxer_app/src/features/cosmetics/components/AvatarUltraLayer.module.css                                                     |    50 +
 fluxer_app/src/features/cosmetics/components/AvatarUltraLayer.test.tsx                                                       |   230 +
 fluxer_app/src/features/cosmetics/components/AvatarUltraLayer.tsx                                                            |   127 +
 fluxer_app/src/features/cosmetics/components/AvatarUltraSurfaces.test.ts                                                     |   112 +
 fluxer_app/src/features/cosmetics/components/CosmeticsSettingsTab.module.css                                                 |   165 +
 fluxer_app/src/features/cosmetics/components/CosmeticsSettingsTab.test.tsx                                                   |   219 +
 fluxer_app/src/features/cosmetics/components/CosmeticsSettingsTab.tsx                                                        |   272 +
 fluxer_app/src/features/cosmetics/components/NameplateBackground.module.css                                                  |    41 +
 fluxer_app/src/features/cosmetics/components/NameplateBackground.test.tsx                                                    |    88 +
 fluxer_app/src/features/cosmetics/components/NameplateBackground.tsx                                                         |    67 +
 fluxer_app/src/features/cosmetics/components/ProfileEffectOverlay.module.css                                                 |    15 +
 fluxer_app/src/features/cosmetics/components/ProfileEffectOverlay.test.tsx                                                   |    70 +
 fluxer_app/src/features/cosmetics/components/ProfileEffectOverlay.tsx                                                        |    40 +
 fluxer_app/src/features/cosmetics/components/ProfileEffectSurfaces.test.ts                                                   |    69 +
 fluxer_app/src/features/cosmetics/constants/AvatarDecorationGeometry.ts                                                      |    11 +
 fluxer_app/src/features/cosmetics/state/Cosmetics.test.ts                                                                    |   176 +
 fluxer_app/src/features/cosmetics/state/Cosmetics.ts                                                                         |   134 +
 fluxer_app/src/features/cosmetics/state/UltraLayouts.test.ts                                                                 |   171 +
 fluxer_app/src/features/cosmetics/state/UltraLayouts.ts                                                                      |   114 +
 fluxer_app/src/features/cosmetics/utils/CosmeticAssetUtils.ts                                                                |    40 +
 fluxer_app/src/features/cosmetics/utils/CosmeticLabels.ts                                                                    |    45 +
 fluxer_app/src/features/cosmetics/utils/CosmeticsSettingsEntry.test.ts                                                       |    58 +
 fluxer_app/src/features/cosmetics/utils/UltraFrontAssets.test.ts                                                             |    99 +
 fluxer_app/src/features/cosmetics/utils/UltraFrontAssets.ts                                                                  |    38 +
 fluxer_app/src/features/cosmetics/utils/UltraFrontMotion.test.ts                                                             |    53 +
 fluxer_app/src/features/cosmetics/utils/UltraFrontMotion.ts                                                                  |    27 +
 fluxer_app/src/features/devtools/components/DeveloperOptionsToggleGroups.ts                                                  |     2 +-
 fluxer_app/src/features/devtools/components/NagbarControls.ts                                                                |    16 +-
 fluxer_app/src/features/devtools/components/PremiumScenarioOptions.ts                                                        |    32 +-
 fluxer_app/src/features/devtools/utils/CommandUtils.ts                                                                       |     5 +-
 fluxer_app/src/features/discovery/commands/DiscoveryCommands.ts                                                              |     2 +
 fluxer_app/src/features/discovery/commands/DiscoveryJoinCommands.test.ts                                                     |    62 +
 fluxer_app/src/features/discovery/commands/DiscoveryJoinCommands.tsx                                                         |     6 +-
 fluxer_app/src/features/discovery/discovery/DiscoveryApps.test.tsx                                                           |   110 +
 fluxer_app/src/features/discovery/discovery/DiscoveryGuildCard.module.css                                                    |    13 +
 fluxer_app/src/features/discovery/discovery/DiscoveryPage.tsx                                                                |    19 +-
 fluxer_app/src/features/discovery/discovery/DiscoverySidebar.tsx                                                             |    21 +-
 fluxer_app/src/features/discovery/state/Discovery.ts                                                                         |    10 +
 fluxer_app/src/features/emoji/components/stickers/StickerGridItem.module.css                                                 |     4 +-
 fluxer_app/src/features/experiment/state/ExperimentAssignments.test.ts                                                       |    22 +
 fluxer_app/src/features/expressions/components/modals/GiftAcceptModal.module.css                                             |    56 +
 fluxer_app/src/features/expressions/components/modals/GiftAcceptModal.test.tsx                                               |   195 +
 fluxer_app/src/features/expressions/components/modals/GiftAcceptModal.tsx                                                    |   140 +-
 fluxer_app/src/features/expressions/components/modals/GiftSendToFriendModal.tsx                                              |     2 +-
 fluxer_app/src/features/expressions/components/modals/meme_form/MemeFormFields.module.css                                    |     2 +-
 fluxer_app/src/features/expressions/components/modals/sticker_form/StickerFormFields.module.css                              |     2 +-
 fluxer_app/src/features/expressions/components/pages/GiftCodePages.test.tsx                                                  |   224 +
 fluxer_app/src/features/expressions/components/pages/GiftLoginPage.tsx                                                       |     8 +-
 fluxer_app/src/features/expressions/components/pages/GiftRegisterPage.tsx                                                    |     4 +-
 fluxer_app/src/features/expressions/utils/ExpressionPermissionUtils.ts                                                       |     8 +-
 fluxer_app/src/features/expressions/utils/UnicodeEmojis.test.ts                                                              |   127 +
 fluxer_app/src/features/expressions/utils/UnicodeEmojis.ts                                                                   |     4 +
 fluxer_app/src/features/feed/commands/FeedCommands.test.ts                                                                   |   697 +
 fluxer_app/src/features/feed/commands/FeedCommands.ts                                                                        |   340 +
 fluxer_app/src/features/feed/commands/FeedReplyCommands.test.ts                                                              |   235 +
 fluxer_app/src/features/feed/commands/FeedReplyCommands.ts                                                                   |   104 +
 fluxer_app/src/features/feed/commands/FeedSuggestionCommands.test.ts                                                         |   164 +
 fluxer_app/src/features/feed/commands/FeedSuggestionCommands.ts                                                              |    48 +
 fluxer_app/src/features/feed/commands/FeedVideoCommands.test.ts                                                              |   426 +
 fluxer_app/src/features/feed/commands/FeedVideoCommands.ts                                                                   |   224 +
 fluxer_app/src/features/feed/commands/FeedViewCommands.test.ts                                                               |   560 +
 fluxer_app/src/features/feed/commands/FeedViewCommands.ts                                                                    |   170 +
 fluxer_app/src/features/feed/components/FeedComments.test.tsx                                                                |   512 +
 fluxer_app/src/features/feed/components/FeedComments.tsx                                                                     |   486 +
 fluxer_app/src/features/feed/components/FeedCommentsCss.test.ts                                                              |   183 +
 fluxer_app/src/features/feed/components/FeedComposer.module.css                                                              |   163 +
 fluxer_app/src/features/feed/components/FeedComposer.test.tsx                                                                |   480 +
 fluxer_app/src/features/feed/components/FeedComposer.tsx                                                                     |   406 +
 fluxer_app/src/features/feed/components/FeedComposerCss.test.ts                                                              |   110 +
 fluxer_app/src/features/feed/components/FeedExpressionButtons.test.tsx                                                       |   210 +
 fluxer_app/src/features/feed/components/FeedExpressionButtons.tsx                                                            |   182 +
 fluxer_app/src/features/feed/components/FeedItemMenu.test.ts                                                                 |    33 +
 fluxer_app/src/features/feed/components/FeedItemMenu.tsx                                                                     |    73 +
 fluxer_app/src/features/feed/components/FeedLikers.module.css                                                                |    89 +
 fluxer_app/src/features/feed/components/FeedLikers.test.tsx                                                                  |   159 +
 fluxer_app/src/features/feed/components/FeedLikers.tsx                                                                       |   159 +
 fluxer_app/src/features/feed/components/FeedLinkPreview.module.css                                                           |   120 +
 fluxer_app/src/features/feed/components/FeedLinkPreview.test.tsx                                                             |   280 +
 fluxer_app/src/features/feed/components/FeedLinkPreview.tsx                                                                  |    78 +
 fluxer_app/src/features/feed/components/FeedNotificationsButton.module.css                                                   |    33 +
 fluxer_app/src/features/feed/components/FeedNotificationsButton.test.tsx                                                     |   289 +
 fluxer_app/src/features/feed/components/FeedNotificationsButton.tsx                                                          |   109 +
 fluxer_app/src/features/feed/components/FeedPendingVideos.module.css                                                         |   171 +
 fluxer_app/src/features/feed/components/FeedPendingVideos.test.tsx                                                           |   132 +
 fluxer_app/src/features/feed/components/FeedPendingVideos.tsx                                                                |   206 +
 fluxer_app/src/features/feed/components/FeedPollEditor.module.css                                                            |    91 +
 fluxer_app/src/features/feed/components/FeedPollEditor.test.tsx                                                              |   134 +
 fluxer_app/src/features/feed/components/FeedPollEditor.tsx                                                                   |   137 +
 fluxer_app/src/features/feed/components/FeedPollView.module.css                                                              |   170 +
 fluxer_app/src/features/feed/components/FeedPollView.test.tsx                                                                |   252 +
 fluxer_app/src/features/feed/components/FeedPollView.tsx                                                                     |   130 +
 fluxer_app/src/features/feed/components/FeedPostCard.module.css                                                              |   607 +
 fluxer_app/src/features/feed/components/FeedPostCard.test.tsx                                                                |   781 +
 fluxer_app/src/features/feed/components/FeedPostCard.tsx                                                                     |   451 +
 fluxer_app/src/features/feed/components/FeedPostCardCss.test.ts                                                              |   206 +
 fluxer_app/src/features/feed/components/FeedPostContent.module.css                                                           |     9 +
 fluxer_app/src/features/feed/components/FeedPostContent.test.tsx                                                             |   164 +
 fluxer_app/src/features/feed/components/FeedPostContent.tsx                                                                  |    57 +
 fluxer_app/src/features/feed/components/FeedProfileAside.module.css                                                          |   121 +
 fluxer_app/src/features/feed/components/FeedProfileAside.test.tsx                                                            |   231 +
 fluxer_app/src/features/feed/components/FeedProfileAside.tsx                                                                 |   100 +
 fluxer_app/src/features/feed/components/FeedReplies.module.css                                                               |   103 +
 fluxer_app/src/features/feed/components/FeedReplies.test.tsx                                                                 |   212 +
 fluxer_app/src/features/feed/components/FeedReplies.tsx                                                                      |   179 +
 fluxer_app/src/features/feed/components/FeedReportModal.tsx                                                                  |   210 +
 fluxer_app/src/features/feed/components/FeedSuggestions.module.css                                                           |    99 +
 fluxer_app/src/features/feed/components/FeedSuggestions.test.tsx                                                             |   469 +
 fluxer_app/src/features/feed/components/FeedSuggestions.tsx                                                                  |   274 +
 fluxer_app/src/features/feed/components/FeedSuggestionsCss.test.ts                                                           |    56 +
 fluxer_app/src/features/feed/components/FeedTimelineList.module.css                                                          |    97 +
 fluxer_app/src/features/feed/components/FeedTimelineList.test.tsx                                                            |   358 +
 fluxer_app/src/features/feed/components/FeedTimelineList.tsx                                                                 |   222 +
 fluxer_app/src/features/feed/components/FeedTimelineListCss.test.ts                                                          |    23 +
 fluxer_app/src/features/feed/components/FeedUserPostsModal.tsx                                                               |    57 +
 fluxer_app/src/features/feed/components/FeedVideo.module.css                                                                 |   112 +
 fluxer_app/src/features/feed/components/FeedVideo.test.tsx                                                                   |   211 +
 fluxer_app/src/features/feed/components/FeedVideo.tsx                                                                        |   166 +
 fluxer_app/src/features/feed/components/FeedVideoChunk.test.ts                                                               |    38 +
 fluxer_app/src/features/feed/components/FeedXLookCss.test.ts                                                                 |   125 +
 fluxer_app/src/features/feed/components/ProfilePostsButton.test.tsx                                                          |    75 +
 fluxer_app/src/features/feed/components/ProfilePostsButton.tsx                                                               |    50 +
 fluxer_app/src/features/feed/components/pages/FeedPage.module.css                                                            |   170 +
 fluxer_app/src/features/feed/components/pages/FeedPage.test.tsx                                                              |   676 +
 fluxer_app/src/features/feed/components/pages/FeedPage.tsx                                                                   |   388 +
 fluxer_app/src/features/feed/components/pages/FeedPageCss.test.ts                                                            |   139 +
 fluxer_app/src/features/feed/components/pages/FeedPostDetail.module.css                                                      |   135 +
 fluxer_app/src/features/feed/components/pages/FeedPostDetail.test.tsx                                                        |   259 +
 fluxer_app/src/features/feed/components/pages/FeedPostDetail.tsx                                                             |   180 +
 fluxer_app/src/features/feed/events/FeedNotificationAck.ts                                                                   |    11 +
 fluxer_app/src/features/feed/events/FeedNotificationCreate.ts                                                                |    13 +
 fluxer_app/src/features/feed/events/FeedNotificationEvents.test.ts                                                           |   403 +
 fluxer_app/src/features/feed/events/FeedNotificationReady.ts                                                                 |    97 +
 fluxer_app/src/features/feed/state/FeedPendingVideos.test.ts                                                                 |   105 +
 fluxer_app/src/features/feed/state/FeedPendingVideos.ts                                                                      |   130 +
 fluxer_app/src/features/feed/state/FeedSuggestionPicks.test.ts                                                               |    73 +
 fluxer_app/src/features/feed/state/FeedSuggestionPicks.ts                                                                    |    72 +
 fluxer_app/src/features/feed/state/FeedTabs.test.ts                                                                          |    30 +
 fluxer_app/src/features/feed/state/FeedTabs.ts                                                                               |    54 +
 fluxer_app/src/features/feed/state/FeedTimeline.test.ts                                                                      |   442 +
 fluxer_app/src/features/feed/state/FeedTimeline.ts                                                                           |   558 +
 fluxer_app/src/features/feed/utils/FeedExpressionUtils.test.ts                                                               |    43 +
 fluxer_app/src/features/feed/utils/FeedExpressionUtils.ts                                                                    |    26 +
 fluxer_app/src/features/feed/utils/FeedGifUtils.test.ts                                                                      |    80 +
 fluxer_app/src/features/feed/utils/FeedGifUtils.ts                                                                           |    75 +
 fluxer_app/src/features/feed/utils/FeedPrivacyUtils.test.ts                                                                  |    50 +
 fluxer_app/src/features/feed/utils/FeedPrivacyUtils.ts                                                                       |    17 +
 fluxer_app/src/features/feed/utils/FeedUtils.test.ts                                                                         |   145 +
 fluxer_app/src/features/feed/utils/FeedUtils.ts                                                                              |    96 +
 fluxer_app/src/features/feed/utils/FeedVideoUpload.test.ts                                                                   |   386 +
 fluxer_app/src/features/feed/utils/FeedVideoUpload.ts                                                                        |   251 +
 fluxer_app/src/features/follow/commands/FollowCommands.test.ts                                                               |   394 +
 fluxer_app/src/features/follow/commands/FollowCommands.ts                                                                    |   113 +
 fluxer_app/src/features/follow/components/FollowListModal.module.css                                                         |   114 +
 fluxer_app/src/features/follow/components/FollowListModal.test.tsx                                                           |   181 +
 fluxer_app/src/features/follow/components/FollowListModal.tsx                                                                |   326 +
 fluxer_app/src/features/follow/components/ProfileFollowActions.module.css                                                    |    56 +
 fluxer_app/src/features/follow/components/ProfileFollowActions.test.tsx                                                      |   216 +
 fluxer_app/src/features/follow/components/ProfileFollowActions.tsx                                                           |   200 +
 fluxer_app/src/features/follow/events/FollowCreate.ts                                                                        |    10 +
 fluxer_app/src/features/follow/events/FollowDelete.ts                                                                        |    13 +
 fluxer_app/src/features/follow/events/FollowEvents.test.ts                                                                   |   141 +
 fluxer_app/src/features/follow/state/FollowLists.ts                                                                          |   138 +
 fluxer_app/src/features/follow/utils/FollowProfileUtils.test.ts                                                              |   187 +
 fluxer_app/src/features/follow/utils/FollowProfileUtils.ts                                                                   |    95 +
 fluxer_app/src/features/forum/components/settings/ForumOverviewTab.test.tsx                                                  |   108 +
 fluxer_app/src/features/forum/components/settings/ForumOverviewTab.tsx                                                       |    26 +-
 fluxer_app/src/features/game_activity/components/GameActivityDisplay.module.css                                              |    29 +
 fluxer_app/src/features/game_activity/components/GameActivityDisplay.tsx                                                     |   109 +
 fluxer_app/src/features/game_activity/components/GameActivitySettingsTab.module.css                                          |    44 +
 fluxer_app/src/features/game_activity/components/GameActivitySettingsTab.tsx                                                 |   274 +
 fluxer_app/src/features/game_activity/hooks/useGameActivity.ts                                                               |    20 +
 fluxer_app/src/features/game_activity/state/GameActivityMinuteClock.ts                                                       |    58 +
 fluxer_app/src/features/game_activity/state/GameActivitySettings.ts                                                          |    55 +
 fluxer_app/src/features/game_activity/state/GameActivityStore.ts                                                             |   114 +
 fluxer_app/src/features/game_activity/tests/DesktopGameActivityBridge.test.ts                                                |   465 +
 fluxer_app/src/features/game_activity/tests/GameActivityClock.test.ts                                                        |   136 +
 fluxer_app/src/features/game_activity/tests/GameActivityDisplay.test.tsx                                                     |   157 +
 fluxer_app/src/features/game_activity/tests/GameActivityProducer.test.ts                                                     |   161 +
 fluxer_app/src/features/game_activity/tests/GameActivitySettings.test.tsx                                                    |   410 +
 fluxer_app/src/features/game_activity/tests/GameActivitySettingsSnapshot.test.ts                                             |   222 +
 fluxer_app/src/features/game_activity/tests/GameActivityStore.test.ts                                                        |   243 +
 fluxer_app/src/features/game_activity/tests/ProfileGameActivitySharing.test.ts                                               |   185 +
 fluxer_app/src/features/game_activity/tests/useGameActivity.test.tsx                                                         |    61 +
 fluxer_app/src/features/game_activity/utils/DesktopGameActivityBridge.ts                                                     |   451 +
 fluxer_app/src/features/game_activity/utils/GameIconAssets.ts                                                                |   455 +
 fluxer_app/src/features/game_activity/utils/GameIconUrls.test.ts                                                             |    46 +
 fluxer_app/src/features/game_activity/utils/GameIconUrls.ts                                                                  |    10 +
 fluxer_app/src/features/game_overlay/GameOverlaySettingsEntry.test.ts                                                        |   104 +
 fluxer_app/src/features/game_overlay/components/GameOverlayHost.module.css                                                   |   130 +
 fluxer_app/src/features/game_overlay/components/GameOverlayHost.test.tsx                                                     |   129 +
 fluxer_app/src/features/game_overlay/components/GameOverlayHost.tsx                                                          |   187 +
 fluxer_app/src/features/game_overlay/components/GameOverlaySettingsTab.tsx                                                   |   104 +
 fluxer_app/src/features/game_overlay/state/GameOverlaySettings.ts                                                            |    31 +
 fluxer_app/src/features/game_overlay/utils/GameOverlayMessageDescriptors.ts                                                  |     9 +
 fluxer_app/src/features/game_overlay/utils/GameOverlayModel.test.ts                                                          |   102 +
 fluxer_app/src/features/game_overlay/utils/GameOverlayModel.ts                                                               |    63 +
 fluxer_app/src/features/game_overlay/utils/GameOverlaySupport.ts                                                             |     8 +
 fluxer_app/src/features/gateway/events/EventRouter.test.ts                                                                   |    33 +
 fluxer_app/src/features/gateway/events/EventRouter.ts                                                                        |    13 +
 fluxer_app/src/features/gateway/events/GatewayReady.ts                                                                       |    23 +-
 fluxer_app/src/features/gateway/events/GatewayReadyUsernameConfig.test.ts                                                    |   221 +
 fluxer_app/src/features/gateway/events/GatewayRolloutUpdate.test.ts                                                          |   133 +
 fluxer_app/src/features/gateway/events/GatewayRolloutUpdate.ts                                                               |    10 +
 fluxer_app/src/features/gateway/snapshot/FeedSnapshot.test.ts                                                                |   843 ++
 fluxer_app/src/features/gateway/snapshot/SnapshotAccountReducer.ts                                                           |   106 +
 fluxer_app/src/features/gateway/snapshot/SnapshotDispatchEvent.ts                                                            |     8 +
 fluxer_app/src/features/gateway/snapshot/SnapshotEntities.ts                                                                 |     9 +
 fluxer_app/src/features/gateway/snapshot/SnapshotHydration.ts                                                                |    44 +-
 fluxer_app/src/features/gateway/snapshot/SnapshotReducer.ts                                                                  |    19 +
 fluxer_app/src/features/gateway/snapshot/SnapshotSync.ts                                                                     |    20 +
 fluxer_app/src/features/gateway/transport/ForegroundGatewayDispatchProcessor.ts                                              |     2 +
 fluxer_app/src/features/gateway/transport/GatewayConnectionAuthFailure.test.ts                                               |    25 +-
 fluxer_app/src/features/gateway/transport/GatewayDispatchScheduling.test.ts                                                  |    24 +
 fluxer_app/src/features/gateway/transport/GatewayDispatchScheduling.ts                                                       |     4 +-
 fluxer_app/src/features/gateway/transport/GatewayGameActivityIntegration.test.ts                                             |   264 +
 fluxer_app/src/features/gateway/transport/GatewaySessionPool.test.ts                                                         |    15 +-
 fluxer_app/src/features/gateway/transport/GatewaySessionPool.ts                                                              |    43 +-
 fluxer_app/src/features/gateway/transport/GatewaySocket.test.ts                                                              |    84 +
 fluxer_app/src/features/gateway/transport/GatewaySocket.ts                                                                   |    13 +-
 fluxer_app/src/features/gateway/transport/GatewaySocketUsernameError.test.ts                                                 |    66 +
 fluxer_app/src/features/gateway/transport/PooledGatewayConnection.ts                                                         |    24 +-
 fluxer_app/src/features/gateway/transport/PooledGatewayConnectionDispatch.test.ts                                            |     4 +-
 fluxer_app/src/features/gateway/types/GatewayPresenceTypes.ts                                                                |     5 +
 fluxer_app/src/features/gateway/types/GatewayRolloutTypes.ts                                                                 |     6 +
 fluxer_app/src/features/gift/commands/GiftCommands.test.ts                                                                   |   158 +
 fluxer_app/src/features/gift/commands/GiftCommands.tsx                                                                       |    80 +-
 fluxer_app/src/features/gift/state/Gifts.ts                                                                                  |    24 +-
 fluxer_app/src/features/gift/utils/GiftCodeUtils.test.ts                                                                     |    21 +
 fluxer_app/src/features/gift/utils/GiftCodeUtils.ts                                                                          |    21 +-
 fluxer_app/src/features/gift/utils/GiftUtils.ts                                                                              |    26 +-
 fluxer_app/src/features/guild/commands/GuildCommands.ts                                                                      |     2 +
 fluxer_app/src/features/guild/components/GuildBadge.module.css                                                               |     9 +
 fluxer_app/src/features/guild/components/modals/AddGuildModal.tsx                                                            |     5 +-
 fluxer_app/src/features/guild/components/modals/guild_tabs/GuildModerationTab.test.tsx                                       |   135 +
 fluxer_app/src/features/guild/components/modals/guild_tabs/GuildModerationTab.tsx                                            |   109 +-
 fluxer_app/src/features/guild/components/popouts/GuildHeaderPopout.module.css                                                |     5 +
 fluxer_app/src/features/guild/components/popouts/GuildHeaderPopout.tsx                                                       |    16 +
 fluxer_app/src/features/guild/models/Guild.test.ts                                                                           |    46 +
 fluxer_app/src/features/guild/models/Guild.ts                                                                                |    14 +
 fluxer_app/src/features/guild/state/GuildMatureContentAgree.test.ts                                                          |    25 +-
 fluxer_app/src/features/guild/state/GuildMatureContentAgree.ts                                                               |    18 +-
 fluxer_app/src/features/i18n/locales/ar/messages.po                                                                          |  6466 ++++++--
 fluxer_app/src/features/i18n/locales/auto-i18n-reviewed-unchanged.json                                                       |  3821 +----
 fluxer_app/src/features/i18n/locales/bg/messages.po                                                                          |  6468 ++++++--
 fluxer_app/src/features/i18n/locales/cs/messages.po                                                                          |  6466 ++++++--
 fluxer_app/src/features/i18n/locales/da/messages.po                                                                          |  6464 ++++++--
 fluxer_app/src/features/i18n/locales/de/messages.po                                                                          |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/el/messages.po                                                                          |  6466 ++++++--
 fluxer_app/src/features/i18n/locales/en-GB/messages.po                                                                       |  6460 ++++++--
 fluxer_app/src/features/i18n/locales/en-US/messages.po                                                                       |  6460 ++++++--
 fluxer_app/src/features/i18n/locales/es-419/messages.po                                                                      |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/es-ES/messages.po                                                                       |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/fi/messages.po                                                                          |  6460 ++++++--
 fluxer_app/src/features/i18n/locales/fr/messages.po                                                                          |  6464 ++++++--
 fluxer_app/src/features/i18n/locales/he/messages.po                                                                          |  6472 ++++++--
 fluxer_app/src/features/i18n/locales/hi/messages.po                                                                          |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/hr/messages.po                                                                          |  6466 ++++++--
 fluxer_app/src/features/i18n/locales/hu/messages.po                                                                          |  6468 ++++++--
 fluxer_app/src/features/i18n/locales/id/messages.po                                                                          |  6464 ++++++--
 fluxer_app/src/features/i18n/locales/it/messages.po                                                                          |  6466 ++++++--
 fluxer_app/src/features/i18n/locales/ja/messages.po                                                                          |  6468 ++++++--
 fluxer_app/src/features/i18n/locales/ko/messages.po                                                                          |  6466 ++++++--
 fluxer_app/src/features/i18n/locales/lt/messages.po                                                                          |  6468 ++++++--
 fluxer_app/src/features/i18n/locales/nl/messages.po                                                                          |  6464 ++++++--
 fluxer_app/src/features/i18n/locales/no/messages.po                                                                          |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/pl/messages.po                                                                          |  6468 ++++++--
 fluxer_app/src/features/i18n/locales/pt-BR/messages.po                                                                       |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/ro/messages.po                                                                          |  6464 ++++++--
 fluxer_app/src/features/i18n/locales/ru/messages.po                                                                          |  6460 ++++++--
 fluxer_app/src/features/i18n/locales/sv-SE/messages.po                                                                       |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/th/messages.po                                                                          |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/tr/messages.po                                                                          |  6500 ++++++--
 fluxer_app/src/features/i18n/locales/uk/messages.po                                                                          |  6466 ++++++--
 fluxer_app/src/features/i18n/locales/vi/messages.po                                                                          |  6458 ++++++--
 fluxer_app/src/features/i18n/locales/zh-CN/messages.po                                                                       |  6462 ++++++--
 fluxer_app/src/features/i18n/locales/zh-TW/messages.po                                                                       |  6458 ++++++--
 fluxer_app/src/features/inbox/commands/FeedNotificationCommands.test.ts                                                      |   412 +
 fluxer_app/src/features/inbox/commands/FeedNotificationCommands.ts                                                           |   119 +
 fluxer_app/src/features/inbox/components/FeedActivityContent.module.css                                                      |   128 +
 fluxer_app/src/features/inbox/components/FeedActivityContent.tsx                                                             |   239 +
 fluxer_app/src/features/inbox/components/FeedNotificationPostModal.tsx                                                       |    68 +
 fluxer_app/src/features/inbox/state/FeedNotifications.test.ts                                                                |   618 +
 fluxer_app/src/features/inbox/state/FeedNotifications.ts                                                                     |   299 +
 fluxer_app/src/features/inbox/state/Inbox.ts                                                                                 |     2 +-
 fluxer_app/src/features/inbox/utils/FeedNotificationText.test.ts                                                             |    32 +
 fluxer_app/src/features/inbox/utils/FeedNotificationText.ts                                                                  |    42 +
 fluxer_app/src/features/inbox/utils/InboxBadge.ts                                                                            |    28 +
 fluxer_app/src/features/invite/commands/InviteCommands.tsx                                                                   |     2 +
 fluxer_app/src/features/invite/components/modals/InviteAcceptModal.module.css                                                |     5 +
 fluxer_app/src/features/invite/components/modals/InvitePagePreviewModal.module.css                                           |     6 +
 fluxer_app/src/features/invite/utils/InviteUtils.ts                                                                          |    12 +-
 fluxer_app/src/features/mature_content/utils/MatureContentSettingsUtils.test.ts                                              |    96 +
 fluxer_app/src/features/mature_content/utils/MatureContentSettingsUtils.ts                                                   |    29 +
 fluxer_app/src/features/member/state/GuildMembers.eviction.test.ts                                                           |   481 +
 fluxer_app/src/features/member/state/GuildMembers.ts                                                                         |   248 +-
 fluxer_app/src/features/messaging/commands/MessageCommands.tsx                                                               |     2 +
 fluxer_app/src/features/messaging/commands/MessageComponentCommands.test.ts                                                  |   111 +
 fluxer_app/src/features/messaging/commands/MessageComponentCommands.ts                                                       |    32 +
 fluxer_app/src/features/messaging/components/alerts/FileSizeTooLargeModal.tsx                                                |     4 +-
 fluxer_app/src/features/messaging/components/modals/ForwardMessagePreview.module.css                                         |     2 +-
 fluxer_app/src/features/messaging/components/modals/media_modal/pan_zoom/usePanZoomSurface.ts                                |     8 +-
 fluxer_app/src/features/messaging/components/popouts/InboxPopout.test.tsx                                                    |    93 +
 fluxer_app/src/features/messaging/components/popouts/InboxPopout.tsx                                                         |    29 +
 fluxer_app/src/features/messaging/models/MessagingMessage.test.ts                                                            |   109 +
 fluxer_app/src/features/messaging/models/MessagingMessage.ts                                                                 |    21 +-
 fluxer_app/src/features/messaging/state/MessageQueueAccountTransition.test.ts                                                |    14 +-
 fluxer_app/src/features/messaging/state/MessageReferences.test.ts                                                            |   916 ++
 fluxer_app/src/features/messaging/state/MessageReferences.ts                                                                 |   295 +-
 fluxer_app/src/features/messaging/state/MessagingMessagesAccountTransition.test.ts                                           |     2 +
 fluxer_app/src/features/messaging/state/MessagingMessagesViewGeneration.test.ts                                              |     2 +
 fluxer_app/src/features/messaging/utils/MessageComponentReplies.test.ts                                                      |    20 +
 fluxer_app/src/features/messaging/utils/MessageComponentReplies.ts                                                           |    45 +
 fluxer_app/src/features/messaging/utils/MessageGroupingUtils.ts                                                              |     4 +-
 fluxer_app/src/features/micupbot/commands/MicupBotCommands.ts                                                                |    71 +
 fluxer_app/src/features/micupbot/components/MicupBotAutomod.tsx                                                              |   262 +
 fluxer_app/src/features/micupbot/components/MicupBotControls.tsx                                                             |   192 +
 fluxer_app/src/features/micupbot/components/MicupBotLevels.tsx                                                               |   204 +
 fluxer_app/src/features/micupbot/components/MicupBotRoles.tsx                                                                |   269 +
 fluxer_app/src/features/micupbot/components/MicupBotTab.module.css                                                           |    64 +
 fluxer_app/src/features/micupbot/components/MicupBotTab.test.tsx                                                             |   649 +
 fluxer_app/src/features/micupbot/components/MicupBotTab.tsx                                                                  |   262 +
 fluxer_app/src/features/micupbot/components/MicupBotWarnings.tsx                                                             |   205 +
 fluxer_app/src/features/micupbot/components/MicupBotWelcome.tsx                                                              |   109 +
 fluxer_app/src/features/micupbot/state/MicupBotSettings.test.ts                                                              |   190 +
 fluxer_app/src/features/micupbot/state/MicupBotSettings.ts                                                                   |   259 +
 fluxer_app/src/features/micupbot/testing/MicupBotTestData.ts                                                                 |    67 +
 fluxer_app/src/features/moderation/components/modals/BanMemberModal.tsx                                                      |    29 +-
 fluxer_app/src/features/moderation/components/pages/ReportPage.module.css                                                    |     2 +-
 fluxer_app/src/features/moderation/constants/BanModalMedia.ts                                                                |     6 +-
 fluxer_app/src/features/navigation/utils/DeepLinkUtils.profilePage.test.ts                                                   |    84 +
 fluxer_app/src/features/navigation/utils/DeepLinkUtils.ts                                                                    |    31 +-
 fluxer_app/src/features/navigation/utils/FeedSectionPages.test.ts                                                            |    37 +
 fluxer_app/src/features/navigation/utils/FeedSectionPages.ts                                                                 |    20 +
 fluxer_app/src/features/navigation/utils/RouterUtils.test.ts                                                                 |    51 +
 fluxer_app/src/features/navigation/utils/RouterUtils.ts                                                                      |    13 +-
 fluxer_app/src/features/notification/components/pages/NotificationsPage.test.tsx                                             |    99 +
 fluxer_app/src/features/notification/components/pages/NotificationsPage.tsx                                                  |    21 +-
 fluxer_app/src/features/notification/utils/SoundLabels.ts                                                                    |     2 +
 fluxer_app/src/features/notification/utils/SoundUtils.test.ts                                                                |   243 +
 fluxer_app/src/features/notification/utils/SoundUtils.ts                                                                     |    93 +-
 fluxer_app/src/features/platform/components/StoreAutostartPromptManager.test.tsx                                             |   187 +
 fluxer_app/src/features/platform/components/StoreAutostartPromptManager.tsx                                                  |    59 +
 fluxer_app/src/features/platform/components/TaskbarPinUi.test.tsx                                                            |   129 +
 fluxer_app/src/features/platform/hooks/useTaskbarPinNagbar.test.tsx                                                          |   127 +
 fluxer_app/src/features/platform/hooks/useTaskbarPinNagbar.ts                                                                |    42 +
 fluxer_app/src/features/platform/state/AuthSession.logout.test.ts                                                            |   128 +
 fluxer_app/src/features/platform/state/AuthSession.test.ts                                                                   |    58 +
 fluxer_app/src/features/platform/state/AuthSession.ts                                                                        |    69 +-
 fluxer_app/src/features/platform/state/FrozenStorageRegistry.test.ts                                                         |     4 +-
 fluxer_app/src/features/platform/state/LegacyAppStorageKeyMap.test.ts                                                        |    21 +-
 fluxer_app/src/features/platform/state/LegacyAppStorageKeyMap.ts                                                             |    12 +-
 fluxer_app/src/features/platform/state/LegacyAppStorageMigration.test.ts                                                     |    50 +
 fluxer_app/src/features/platform/state/LegacyAppStorageMigration.ts                                                          |    28 +
 fluxer_app/src/features/platform/state/LegacyStorageContinuity.test.ts                                                       |    23 +-
 fluxer_app/src/features/platform/state/PersistentStorage.test.ts                                                             |    83 +
 fluxer_app/src/features/platform/state/PersistentStorage.ts                                                                  |    38 +-
 fluxer_app/src/features/platform/state/ResetClientState.ts                                                                   |     5 +-
 fluxer_app/src/features/platform/state/TaskbarPin.persistence.test.ts                                                        |   106 +
 fluxer_app/src/features/platform/state/TaskbarPin.test.ts                                                                    |   129 +
 fluxer_app/src/features/platform/state/TaskbarPin.ts                                                                         |    84 +
 fluxer_app/src/features/platform/state/__fixtures__/LegacyStorageFixtures.ts                                                 |    44 +-
 fluxer_app/src/features/platform/state/__fixtures__/PersistedStoreNames.ts                                                   |    27 +-
 fluxer_app/src/features/platform/state/__fixtures__/RuntimeBootstrapFixture.ts                                               |     5 +-
 fluxer_app/src/features/platform/state/auth_session/AuthSessionDependencies.ts                                               |     7 +
 fluxer_app/src/features/platform/state/auth_session/AuthSessionLifecycle.ts                                                  |     7 +
 fluxer_app/src/features/platform/state/auth_session/AuthSessionStoredAccountResolver.ts                                      |    46 +
 fluxer_app/src/features/platform/state/auth_session/DeployedWebSessionRestore.test.ts                                        |   619 +
 fluxer_app/src/features/platform/transport/RestTransport.test.ts                                                             |    59 +
 fluxer_app/src/features/platform/transport/RestTransport.ts                                                                  |     8 +
 fluxer_app/src/features/platform/types/Electron.ts                                                                           |    45 +
 fluxer_app/src/features/platform/utils/Autostart.ts                                                                          |    12 +
 fluxer_app/src/features/platform/utils/DesktopLocaleBridge.ts                                                                |    16 +-
 fluxer_app/src/features/platform/utils/WorkerAssetUrl.ts                                                                     |     1 +
 fluxer_app/src/features/premium/commands/PlutoniumPageCommands.tsx                                                           |    13 +
 fluxer_app/src/features/premium/commands/PremiumCommands.ts                                                                  |    31 +-
 fluxer_app/src/features/premium/commands/PremiumModalCommands.test.tsx                                                       |   132 +
 fluxer_app/src/features/premium/commands/PremiumModalCommands.tsx                                                            |    26 +-
 fluxer_app/src/features/premium/components/PremiumCompareTable.module.css                                                    |   241 +
 fluxer_app/src/features/premium/components/PremiumCompareTable.test.tsx                                                      |   182 +
 fluxer_app/src/features/premium/components/PremiumCompareTable.tsx                                                           |   227 +
 fluxer_app/src/features/premium/components/PremiumFaq.module.css                                                             |    78 +
 fluxer_app/src/features/premium/components/PremiumFaq.tsx                                                                    |    71 +
 fluxer_app/src/features/premium/components/PremiumFloatingBuy.module.css                                                     |    55 +
 fluxer_app/src/features/premium/components/PremiumFloatingBuy.test.tsx                                                       |   131 +
 fluxer_app/src/features/premium/components/PremiumFloatingBuy.tsx                                                            |    66 +
 fluxer_app/src/features/premium/components/PremiumHalo.module.css                                                            |   133 +
 fluxer_app/src/features/premium/components/PremiumHalo.tsx                                                                   |    32 +
 fluxer_app/src/features/premium/components/PremiumPackages.module.css                                                        |    77 +
 fluxer_app/src/features/premium/components/PremiumPackages.test.tsx                                                          |   175 +
 fluxer_app/src/features/premium/components/PremiumPackages.tsx                                                               |    94 +
 fluxer_app/src/features/premium/components/PremiumPerkTiles.module.css                                                       |   387 +
 fluxer_app/src/features/premium/components/PremiumPerkTiles.test.tsx                                                         |   354 +
 fluxer_app/src/features/premium/components/PremiumPerkTiles.tsx                                                              |   374 +
 fluxer_app/src/features/premium/components/PremiumPlanCard.module.css                                                        |   176 +
 fluxer_app/src/features/premium/components/PremiumPlanCard.test.tsx                                                          |   222 +
 fluxer_app/src/features/premium/components/PremiumPlanCard.tsx                                                               |   173 +
 fluxer_app/src/features/premium/components/PremiumStatusCard.module.css                                                      |    58 +
 fluxer_app/src/features/premium/components/PremiumStatusCard.test.tsx                                                        |   122 +
 fluxer_app/src/features/premium/components/PremiumStatusCard.tsx                                                             |    77 +
 fluxer_app/src/features/premium/components/PremiumSurface.module.css                                                         |   110 +
 fluxer_app/src/features/premium/components/pages/PremiumCallbackPage.test.tsx                                                |   130 +
 fluxer_app/src/features/premium/components/pages/PremiumCallbackPage.tsx                                                     |    46 +-
 fluxer_app/src/features/premium/components/pages/PremiumPage.module.css                                                      |   227 +
 fluxer_app/src/features/premium/components/pages/PremiumPage.test.tsx                                                        |   401 +
 fluxer_app/src/features/premium/components/pages/PremiumPage.tsx                                                             |   233 +
 fluxer_app/src/features/premium/components/pages/PremiumPageSections.tsx                                                     |   191 +
 fluxer_app/src/features/premium/components/plutonium_page/PlutoniumPage.tsx                                                  |    41 +-
 fluxer_app/src/features/premium/components/plutonium_page/PlutoniumPageComparison.tsx                                        |   204 +-
 fluxer_app/src/features/premium/components/plutonium_page/PlutoniumPageMedia.ts                                              |    89 +-
 fluxer_app/src/features/premium/components/plutonium_page/PlutoniumPageMessages.ts                                           |    27 +-
 fluxer_app/src/features/premium/components/plutonium_page/PlutoniumPageShowcase.tsx                                          |    54 +-
 fluxer_app/src/features/premium/hooks/usePremiumTrial.test.tsx                                                               |   190 +
 fluxer_app/src/features/premium/hooks/usePremiumTrial.ts                                                                     |    80 +
 fluxer_app/src/features/premium/utils/PremiumBadgeAsset.test.ts                                                              |    21 +
 fluxer_app/src/features/premium/utils/PremiumBadgeAsset.ts                                                                   |     7 +
 fluxer_app/src/features/premium/utils/PremiumCompareRows.test.ts                                                             |   101 +
 fluxer_app/src/features/premium/utils/PremiumCompareRows.ts                                                                  |   171 +
 fluxer_app/src/features/premium/utils/PremiumMessageDescriptors.ts                                                           |    20 +-
 fluxer_app/src/features/premium/utils/PremiumPlanSavings.test.ts                                                             |    62 +
 fluxer_app/src/features/premium/utils/PremiumPlanSavings.ts                                                                  |    29 +
 fluxer_app/src/features/premium/utils/PremiumUtils.test.ts                                                                   |    16 +-
 fluxer_app/src/features/premium/utils/PremiumUtils.ts                                                                        |    13 +-
 fluxer_app/src/features/presence/events/PresenceUpdateBulk.ts                                                                |     7 +-
 fluxer_app/src/features/presence/state/Presence.ts                                                                           |     8 +
 fluxer_app/src/features/presence/state/PresenceGameActivity.test.ts                                                          |    96 +
 fluxer_app/src/features/read_state/state/EveryoneMentionPath.test.ts                                                         |   375 +
 fluxer_app/src/features/read_state/state/ReadStates.ts                                                                       |    28 +-
 fluxer_app/src/features/referral/commands/ReferralCommands.ts                                                                |    11 +
 fluxer_app/src/features/referral/components/ReferralSettingsTab.module.css                                                   |   119 +
 fluxer_app/src/features/referral/components/ReferralSettingsTab.test.tsx                                                     |   210 +
 fluxer_app/src/features/referral/components/ReferralSettingsTab.tsx                                                          |   339 +
 fluxer_app/src/features/referral/utils/ReferralCodeStorage.test.ts                                                           |    46 +
 fluxer_app/src/features/referral/utils/ReferralCodeStorage.ts                                                                |    46 +
 fluxer_app/src/features/relationship/commands/RelationshipCommands.ts                                                        |     9 +-
 fluxer_app/src/features/relationship/events/RelationshipAdd.ts                                                               |     2 +
 fluxer_app/src/features/relationship/events/RelationshipRemove.ts                                                            |     2 +
 fluxer_app/src/features/relationship/events/RelationshipUpdate.ts                                                            |     2 +
 fluxer_app/src/features/relationship/state/Relationships.ts                                                                  |     6 +-
 fluxer_app/src/features/roster/commands/GuildRosterCommands.ts                                                               |    36 +
 fluxer_app/src/features/roster/components/GuildRosterTab.module.css                                                          |    68 +
 fluxer_app/src/features/roster/components/GuildRosterTab.test.tsx                                                            |   452 +
 fluxer_app/src/features/roster/components/GuildRosterTab.tsx                                                                 |   465 +
 fluxer_app/src/features/roster/state/GuildRosterEvents.test.ts                                                               |   121 +
 fluxer_app/src/features/roster/state/GuildRosterEvents.ts                                                                    |   138 +
 fluxer_app/src/features/search/components/quick_switcher/QuickSwitcherModal.module.css                                       |     8 +-
 fluxer_app/src/features/shop/ShopSettingsEntry.test.ts                                                                       |    99 +
 fluxer_app/src/features/shop/commands/ShopCommands.test.ts                                                                   |    33 +
 fluxer_app/src/features/shop/commands/ShopCommands.ts                                                                        |    39 +
 fluxer_app/src/features/shop/components/ShopBundleCard.test.tsx                                                              |   461 +
 fluxer_app/src/features/shop/components/ShopBundleCard.tsx                                                                   |   251 +
 fluxer_app/src/features/shop/components/ShopCollectionSection.test.tsx                                                       |   161 +
 fluxer_app/src/features/shop/components/ShopCollectionSection.tsx                                                            |   137 +
 fluxer_app/src/features/shop/components/ShopCountdown.module.css                                                             |    32 +
 fluxer_app/src/features/shop/components/ShopCountdown.test.tsx                                                               |   104 +
 fluxer_app/src/features/shop/components/ShopCountdown.tsx                                                                    |    57 +
 fluxer_app/src/features/shop/components/ShopCurrencyNote.tsx                                                                 |    26 +
 fluxer_app/src/features/shop/components/ShopEquippedSuccess.module.css                                                       |    78 +
 fluxer_app/src/features/shop/components/ShopEquippedSuccess.tsx                                                              |    96 +
 fluxer_app/src/features/shop/components/ShopItemCard.module.css                                                              |   300 +
 fluxer_app/src/features/shop/components/ShopItemCard.test.tsx                                                                |   413 +
 fluxer_app/src/features/shop/components/ShopItemCard.tsx                                                                     |   236 +
 fluxer_app/src/features/shop/components/ShopItemStage.module.css                                                             |   262 +
 fluxer_app/src/features/shop/components/ShopItemStage.test.tsx                                                               |   411 +
 fluxer_app/src/features/shop/components/ShopItemStage.tsx                                                                    |   231 +
 fluxer_app/src/features/shop/components/ShopPrice.module.css                                                                 |    13 +
 fluxer_app/src/features/shop/components/ShopPrice.tsx                                                                        |    84 +
 fluxer_app/src/features/shop/components/ShopPriceLine.module.css                                                             |   146 +
 fluxer_app/src/features/shop/components/ShopPriceLine.test.tsx                                                               |   346 +
 fluxer_app/src/features/shop/components/ShopPriceLine.tsx                                                                    |   244 +
 fluxer_app/src/features/shop/components/ShopRedeemField.module.css                                                           |    96 +
 fluxer_app/src/features/shop/components/ShopRedeemField.test.tsx                                                             |   134 +
 fluxer_app/src/features/shop/components/ShopRedeemField.tsx                                                                  |   165 +
 fluxer_app/src/features/shop/components/ShopSetArt.module.css                                                                |   121 +
 fluxer_app/src/features/shop/components/ShopSetArt.tsx                                                                       |   132 +
 fluxer_app/src/features/shop/components/ShopSetView.test.tsx                                                                 |   112 +
 fluxer_app/src/features/shop/components/ShopSetView.tsx                                                                      |   115 +
 fluxer_app/src/features/shop/components/ShopTab.module.css                                                                   |   348 +
 fluxer_app/src/features/shop/components/ShopTab.test.tsx                                                                     |   404 +
 fluxer_app/src/features/shop/components/ShopTab.tsx                                                                          |   237 +
 fluxer_app/src/features/shop/components/modals/ShopBundleDetailModal.test.tsx                                                |   184 +
 fluxer_app/src/features/shop/components/modals/ShopBundleDetailModal.tsx                                                     |   137 +
 fluxer_app/src/features/shop/components/modals/ShopCheckoutModal.module.css                                                  |   339 +
 fluxer_app/src/features/shop/components/modals/ShopCheckoutModal.test.tsx                                                    |   632 +
 fluxer_app/src/features/shop/components/modals/ShopCheckoutModal.tsx                                                         |   842 ++
 fluxer_app/src/features/shop/components/modals/ShopItemDetailModal.module.css                                                |   202 +
 fluxer_app/src/features/shop/components/modals/ShopItemDetailModal.test.tsx                                                  |   247 +
 fluxer_app/src/features/shop/components/modals/ShopItemDetailModal.tsx                                                       |   239 +
 fluxer_app/src/features/shop/components/pages/ShopPage.module.css                                                            |     8 +
 fluxer_app/src/features/shop/components/pages/ShopPage.test.tsx                                                              |   159 +
 fluxer_app/src/features/shop/components/pages/ShopPage.tsx                                                                   |    59 +
 fluxer_app/src/features/shop/components/previews/ShopDetailPreview.test.tsx                                                  |   137 +
 fluxer_app/src/features/shop/components/previews/ShopDetailPreview.tsx                                                       |   152 +
 fluxer_app/src/features/shop/components/previews/ShopMemberRowPreview.test.tsx                                               |   133 +
 fluxer_app/src/features/shop/components/previews/ShopMemberRowPreview.tsx                                                    |    29 +
 fluxer_app/src/features/shop/components/previews/ShopMessagePreview.module.css                                               |     8 +
 fluxer_app/src/features/shop/components/previews/ShopMessagePreview.test.tsx                                                 |    84 +
 fluxer_app/src/features/shop/components/previews/ShopMessagePreview.tsx                                                      |    93 +
 fluxer_app/src/features/shop/components/previews/ShopVoiceTilePreview.module.css                                             |    37 +
 fluxer_app/src/features/shop/components/previews/ShopVoiceTilePreview.test.tsx                                               |    82 +
 fluxer_app/src/features/shop/components/previews/ShopVoiceTilePreview.tsx                                                    |    38 +
 fluxer_app/src/features/shop/hooks/useShopCheckout.test.ts                                                                   |   588 +
 fluxer_app/src/features/shop/hooks/useShopCheckout.ts                                                                        |   387 +
 fluxer_app/src/features/shop/state/ShopCatalog.test.ts                                                                       |   323 +
 fluxer_app/src/features/shop/state/ShopCatalog.ts                                                                            |   198 +
 fluxer_app/src/features/shop/utils/ShopAvailability.ts                                                                       |     9 +
 fluxer_app/src/features/shop/utils/ShopCollections.test.ts                                                                   |   118 +
 fluxer_app/src/features/shop/utils/ShopCollections.ts                                                                        |    42 +
 fluxer_app/src/features/shop/utils/ShopEntries.ts                                                                            |    21 +
 fluxer_app/src/features/shop/utils/ShopItemAction.test.ts                                                                    |   136 +
 fluxer_app/src/features/shop/utils/ShopItemAction.ts                                                                         |    80 +
 fluxer_app/src/features/shop/utils/ShopMessageDescriptors.ts                                                                 |   409 +
 fluxer_app/src/features/shop/utils/ShopPreviewUser.test.ts                                                                   |   101 +
 fluxer_app/src/features/shop/utils/ShopPreviewUser.ts                                                                        |    43 +
 fluxer_app/src/features/shop/utils/ShopPriceFormat.test.ts                                                                   |    47 +
 fluxer_app/src/features/shop/utils/ShopPriceFormat.ts                                                                        |    55 +
 fluxer_app/src/features/shop/utils/ShopSetNavigation.test.ts                                                                 |    49 +
 fluxer_app/src/features/shop/utils/ShopSetNavigation.ts                                                                      |    22 +
 fluxer_app/src/features/shop/utils/ShopSets.test.ts                                                                          |   117 +
 fluxer_app/src/features/shop/utils/ShopSets.ts                                                                               |    84 +
 fluxer_app/src/features/shop/utils/ShopStageLayout.test.ts                                                                   |    54 +
 fluxer_app/src/features/shop/utils/ShopStageLayout.ts                                                                        |    38 +
 fluxer_app/src/features/shop/utils/ShopSurfaces.test.ts                                                                      |    83 +
 fluxer_app/src/features/shop/utils/ShopSurfaces.ts                                                                           |    23 +
 fluxer_app/src/features/shop/utils/ShopTimeLeft.ts                                                                           |    25 +
 fluxer_app/src/features/streamer_mode/components/StreamerModeGate.module.css                                                 |     7 +
 fluxer_app/src/features/table_game/commands/TableGameCommands.test.ts                                                        |   313 +
 fluxer_app/src/features/table_game/commands/TableGameCommands.ts                                                             |   308 +
 fluxer_app/src/features/table_game/components/ChessBoard.module.css                                                          |   141 +
 fluxer_app/src/features/table_game/components/ChessBoard.test.tsx                                                            |   191 +
 fluxer_app/src/features/table_game/components/ChessBoard.tsx                                                                 |   212 +
 fluxer_app/src/features/table_game/components/ChessPromotionPicker.module.css                                                |    58 +
 fluxer_app/src/features/table_game/components/ChessPromotionPicker.test.tsx                                                  |    31 +
 fluxer_app/src/features/table_game/components/ChessPromotionPicker.tsx                                                       |    53 +
 fluxer_app/src/features/table_game/components/DamaBoard.module.css                                                           |   172 +
 fluxer_app/src/features/table_game/components/DamaBoard.test.tsx                                                             |   268 +
 fluxer_app/src/features/table_game/components/DamaBoard.tsx                                                                  |   327 +
 fluxer_app/src/features/table_game/components/TableGamePanel.module.css                                                      |   108 +
 fluxer_app/src/features/table_game/components/TableGamePanel.test.tsx                                                        |   202 +
 fluxer_app/src/features/table_game/components/TableGamePanel.tsx                                                             |   179 +
 fluxer_app/src/features/table_game/components/TableGameResult.module.css                                                     |    31 +
 fluxer_app/src/features/table_game/components/TableGameResult.test.tsx                                                       |    59 +
 fluxer_app/src/features/table_game/components/TableGameResult.tsx                                                            |   134 +
 fluxer_app/src/features/table_game/components/TableGamesEntry.module.css                                                     |    86 +
 fluxer_app/src/features/table_game/components/TableGamesEntry.test.tsx                                                       |   286 +
 fluxer_app/src/features/table_game/components/TableGamesEntry.tsx                                                            |   248 +
 fluxer_app/src/features/table_game/components/TableLobby.module.css                                                          |   178 +
 fluxer_app/src/features/table_game/components/TableLobby.test.tsx                                                            |   264 +
 fluxer_app/src/features/table_game/components/TableLobby.tsx                                                                 |   334 +
 fluxer_app/src/features/table_game/components/TavlaBoard.tsx                                                                 |     3 +
 fluxer_app/src/features/table_game/components/okey/Okey101Melds.module.css                                                   |    96 +
 fluxer_app/src/features/table_game/components/okey/Okey101Melds.test.tsx                                                     |   276 +
 fluxer_app/src/features/table_game/components/okey/Okey101Melds.tsx                                                          |   185 +
 fluxer_app/src/features/table_game/components/okey/Okey101Staging.test.ts                                                    |    38 +
 fluxer_app/src/features/table_game/components/okey/Okey101Staging.ts                                                         |    29 +
 fluxer_app/src/features/table_game/components/okey/OkeyBoard.module.css                                                      |   163 +
 fluxer_app/src/features/table_game/components/okey/OkeyBoard.test.tsx                                                        |   161 +
 fluxer_app/src/features/table_game/components/okey/OkeyBoard.tsx                                                             |   520 +
 fluxer_app/src/features/table_game/components/okey/OkeyRack.module.css                                                       |    79 +
 fluxer_app/src/features/table_game/components/okey/OkeyRack.test.tsx                                                         |   319 +
 fluxer_app/src/features/table_game/components/okey/OkeyRack.tsx                                                              |   185 +
 fluxer_app/src/features/table_game/components/okey/OkeyRackModel.ts                                                          |    79 +
 fluxer_app/src/features/table_game/components/okey/OkeyTestHarness.ts                                                        |    99 +
 fluxer_app/src/features/table_game/components/okey/OkeyTile.module.css                                                       |    83 +
 fluxer_app/src/features/table_game/components/okey/OkeyTile.tsx                                                              |    76 +
 fluxer_app/src/features/table_game/components/tavla/TavlaBoard.module.css                                                    |   171 +
 fluxer_app/src/features/table_game/components/tavla/TavlaBoard.test.tsx                                                      |   323 +
 fluxer_app/src/features/table_game/components/tavla/TavlaBoard.tsx                                                           |   332 +
 fluxer_app/src/features/table_game/components/tavla/TavlaBoardModel.test.ts                                                  |    61 +
 fluxer_app/src/features/table_game/components/tavla/TavlaBoardModel.ts                                                       |    28 +
 fluxer_app/src/features/table_game/events/TableGameUpdate.ts                                                                 |    10 +
 fluxer_app/src/features/table_game/hooks/useTableDeadlineTick.test.ts                                                        |   125 +
 fluxer_app/src/features/table_game/hooks/useTableDeadlineTick.ts                                                             |    54 +
 fluxer_app/src/features/table_game/sound/TableGameActionSound.test.ts                                                        |   137 +
 fluxer_app/src/features/table_game/sound/TableGameSoundFiles.ts                                                              |   103 +
 fluxer_app/src/features/table_game/sound/TableGameSoundLabels.ts                                                             |   101 +
 fluxer_app/src/features/table_game/sound/TableGameSoundPolicy.test.ts                                                        |    97 +
 fluxer_app/src/features/table_game/sound/TableGameSoundRouting.test.ts                                                       |   130 +
 fluxer_app/src/features/table_game/sound/TableGameSoundSettings.tsx                                                          |    57 +
 fluxer_app/src/features/table_game/sound/TableGameSounds.test.ts                                                             |   461 +
 fluxer_app/src/features/table_game/sound/TableGameSounds.ts                                                                  |   277 +
 fluxer_app/src/features/table_game/state/TableGameTestViews.ts                                                               |   172 +
 fluxer_app/src/features/table_game/state/TableGameTiming.test.ts                                                             |    11 +
 fluxer_app/src/features/table_game/state/TableGameTiming.ts                                                                  |    18 +
 fluxer_app/src/features/table_game/state/TableGames.test.ts                                                                  |   214 +
 fluxer_app/src/features/table_game/state/TableGames.ts                                                                       |   183 +
 fluxer_app/src/features/table_game/utils/ChessFen.ts                                                                         |    31 +
 fluxer_app/src/features/table_game/utils/DamaPaths.test.ts                                                                   |    26 +
 fluxer_app/src/features/table_game/utils/DamaPaths.ts                                                                        |    16 +
 fluxer_app/src/features/table_game/utils/TableDraftKey.test.ts                                                               |    89 +
 fluxer_app/src/features/table_game/utils/TableDraftKey.ts                                                                    |    36 +
 fluxer_app/src/features/table_game/utils/TableDrop.test.ts                                                                   |   505 +
 fluxer_app/src/features/table_game/utils/TableDrop.ts                                                                        |   301 +
 fluxer_app/src/features/table_game/utils/TableGameDeadline.test.ts                                                           |    52 +
 fluxer_app/src/features/table_game/utils/TableGameDeadline.ts                                                                |    33 +
 fluxer_app/src/features/table_game/utils/TableGameMessages.ts                                                                |   117 +
 fluxer_app/src/features/table_game/utils/TavlaSteps.test.ts                                                                  |   127 +
 fluxer_app/src/features/table_game/utils/TavlaSteps.ts                                                                       |    73 +
 fluxer_app/src/features/table_game/utils/drawTableTop.test.ts                                                                |   168 +
 fluxer_app/src/features/table_game/utils/drawTableTop.ts                                                                     |   257 +
 fluxer_app/src/features/theme/components/modals/BackgroundImageGalleryModal.module.css                                       |     2 +-
 fluxer_app/src/features/theme/components/modals/BackgroundImageGalleryModal.tsx                                              |     2 +-
 fluxer_app/src/features/theme/state/Theme.test.ts                                                                            |    59 +
 fluxer_app/src/features/theme/state/Theme.ts                                                                                 |    14 +-
 fluxer_app/src/features/theme/styles/AttachmentFile.module.css                                                               |     2 +-
 fluxer_app/src/features/theme/styles/AttachmentGridItem.module.css                                                           |     4 +-
 fluxer_app/src/features/theme/styles/AttachmentMosaic.module.css                                                             |     4 +-
 fluxer_app/src/features/theme/styles/AttachmentSingleMedia.module.css                                                        |     2 +-
 fluxer_app/src/features/theme/styles/Markup.module.css                                                                       |     7 +
 fluxer_app/src/features/theme/styles/MarkupAnsiBlinkCss.test.ts                                                              |    29 +
 fluxer_app/src/features/theme/styles/MicupV1Palette.test.ts                                                                  |   188 +
 fluxer_app/src/features/theme/styles/MicupV1Surfaces.test.ts                                                                 |   226 +
 fluxer_app/src/features/theme/styles/OnBrandText.test.ts                                                                     |    77 +
 fluxer_app/src/features/theme/utils/ThemeUtils.ts                                                                            |    10 +-
 fluxer_app/src/features/theme/variables/ThemeVariableManifest.ts                                                             |    19 +-
 fluxer_app/src/features/threads/state/ChannelThreads.test.ts                                                                 |     2 +
 fluxer_app/src/features/trusted_domain/state/TrustedDomain.ts                                                                |    13 +-
 fluxer_app/src/features/ui/action_menu/ContextMenu.module.css                                                                |     7 +-
 fluxer_app/src/features/ui/action_menu/ContextMenuIcons.tsx                                                                  |     8 +
 fluxer_app/src/features/ui/action_menu/MenuItemRadio.module.css                                                              |     2 +-
 fluxer_app/src/features/ui/action_menu/items/GuildMenuData.test.tsx                                                          |   161 +
 fluxer_app/src/features/ui/action_menu/items/GuildMenuData.tsx                                                               |    19 +
 fluxer_app/src/features/ui/action_menu/items/VoiceParticipantStreamMenuBuilder.tsx                                           |     5 +-
 fluxer_app/src/features/ui/action_menu/items/voice_participant_menu_data/shared.ts                                           |     5 +-
 fluxer_app/src/features/ui/avatars/AvatarWithPresence.test.tsx                                                               |    85 +
 fluxer_app/src/features/ui/avatars/AvatarWithPresence.tsx                                                                    |     9 +
 fluxer_app/src/features/ui/button/Button.module.css                                                                          |    36 +-
 fluxer_app/src/features/ui/button/Button.test.tsx                                                                            |    65 +
 fluxer_app/src/features/ui/button/Button.tsx                                                                                 |    21 +-
 fluxer_app/src/features/ui/character_counter/CharacterCountMessages.ts                                                       |     2 +-
 fluxer_app/src/features/ui/checkbox/Checkbox.module.css                                                                      |     4 +-
 fluxer_app/src/features/ui/checkbox/Checkbox.tsx                                                                             |     4 +-
 fluxer_app/src/features/ui/components/Avatar.test.tsx                                                                        |   114 +
 fluxer_app/src/features/ui/components/Avatar.tsx                                                                             |    33 +
 fluxer_app/src/features/ui/components/BaseAvatar.test.tsx                                                                    |    69 +
 fluxer_app/src/features/ui/components/BaseAvatar.tsx                                                                         |     7 +
 fluxer_app/src/features/ui/components/MentionBadge.test.tsx                                                                  |    39 +
 fluxer_app/src/features/ui/components/MentionBadge.tsx                                                                       |     9 +-
 fluxer_app/src/features/ui/components/Spinner.module.css                                                                     |     8 +-
 fluxer_app/src/features/ui/components/StatusAwareAvatar.test.tsx                                                             |    27 +
 fluxer_app/src/features/ui/components/StatusAwareAvatar.tsx                                                                  |     4 +
 fluxer_app/src/features/ui/components/form/DateTimePickerField.module.css                                                    |     2 +-
 fluxer_app/src/features/ui/components/form/FormCombobox.module.css                                                           |     7 +-
 fluxer_app/src/features/ui/components/form/FormSwitch.module.css                                                             |     1 +
 fluxer_app/src/features/ui/menu_bottom_sheet/MenuBottomSheet.module.css                                                      |     2 +-
 fluxer_app/src/features/ui/plutonium_upsell/PlutoniumUpsell.module.css                                                       |     8 +-
 fluxer_app/src/features/ui/popover/searchable_list_popout/SearchableListPopout.module.css                                    |     5 +
 fluxer_app/src/features/ui/radio_group/RadioGroup.module.css                                                                 |     6 +
 fluxer_app/src/features/ui/sheet/Sheet.module.css                                                                            |     6 +-
 fluxer_app/src/features/ui/sheet/Sheet.tsx                                                                                   |     3 +-
 fluxer_app/src/features/ui/space_background/SpaceBackground.module.css                                                       |     7 -
 fluxer_app/src/features/ui/state/Nagbar.ts                                                                                   |    12 +
 fluxer_app/src/features/ui/state/Notification.test.ts                                                                        |   183 +
 fluxer_app/src/features/ui/state/Notification.ts                                                                             |    27 +-
 fluxer_app/src/features/ui/state/OverlayAccountTransition.test.ts                                                            |     2 +
 fluxer_app/src/features/ui/state/Sound.test.ts                                                                               |    75 +
 fluxer_app/src/features/ui/state/Sound.ts                                                                                    |    11 +-
 fluxer_app/src/features/ui/stepped_carousel/SteppedCarousel.test.tsx                                                         |    67 +
 fluxer_app/src/features/ui/stepped_carousel/SteppedCarousel.tsx                                                              |     5 +-
 fluxer_app/src/features/ui/tooltip/TooltipScrollCoordinator.ts                                                               |     8 +
 fluxer_app/src/features/ui/utils/AppZoomUtils.ts                                                                             |     8 +-
 fluxer_app/src/features/updater/commands/UpdaterModalCommands.test.tsx                                                       |    55 +
 fluxer_app/src/features/updater/commands/UpdaterModalCommands.tsx                                                            |    11 +-
 fluxer_app/src/features/updater/utils/LinuxManualUpdateOptions.ts                                                            |     2 +-
 fluxer_app/src/features/user/commands/UserProfileCommands.profilePage.test.ts                                                |   164 +
 fluxer_app/src/features/user/commands/UserProfileCommands.tsx                                                                |    91 +-
 fluxer_app/src/features/user/commands/UserSettingsCommands.ts                                                                |   110 +-
 fluxer_app/src/features/user/commands/UsernameCommands.test.ts                                                               |    42 +
 fluxer_app/src/features/user/commands/UsernameCommands.ts                                                                    |    43 +
 fluxer_app/src/features/user/components/PremiumUserBadge.module.css                                                          |     6 +
 fluxer_app/src/features/user/components/PremiumUserBadge.test.tsx                                                            |   221 +
 fluxer_app/src/features/user/components/PremiumUserBadge.tsx                                                                 |    89 +
 fluxer_app/src/features/user/components/PremiumUserBadgePlacement.test.ts                                                    |   119 +
 fluxer_app/src/features/user/components/UsernamePicker.test.tsx                                                              |    65 +
 fluxer_app/src/features/user/components/UsernamePicker.tsx                                                                   |    95 +
 fluxer_app/src/features/user/components/UsernameSelectionGate.module.css                                                     |    46 +
 fluxer_app/src/features/user/components/UsernameSelectionGate.test.tsx                                                       |   281 +
 fluxer_app/src/features/user/components/UsernameSelectionGate.tsx                                                            |   221 +
 fluxer_app/src/features/user/components/VerifiedUserBadge.test.tsx                                                           |    92 +
 fluxer_app/src/features/user/components/VerifiedUserBadge.tsx                                                                |    45 +
 fluxer_app/src/features/user/components/modals/CustomStatusModal.tsx                                                         |     1 +
 fluxer_app/src/features/user/components/modals/FluxerTagChangeModal.tsx                                                      |    21 +-
 fluxer_app/src/features/user/components/modals/StatusChangeBottomSheet.module.css                                            |     4 +-
 fluxer_app/src/features/user/components/modals/UserProfileMobileSheet.module.css                                             |    11 +-
 fluxer_app/src/features/user/components/modals/UserProfileMobileSheet.tsx                                                    |   114 +-
 fluxer_app/src/features/user/components/modals/UserProfileModal.module.css                                                   |    31 +-
 fluxer_app/src/features/user/components/modals/UserProfileModal.tsx                                                          |    54 +-
 fluxer_app/src/features/user/components/modals/UserProfileModalFollow.test.ts                                                |    39 +
 fluxer_app/src/features/user/components/modals/UserProfileOpenPage.test.ts                                                   |    45 +
 fluxer_app/src/features/user/components/modals/UserSettingsModal.test.tsx                                                    |   158 +
 fluxer_app/src/features/user/components/modals/UserSettingsModal.tsx                                                         |    36 +-
 fluxer_app/src/features/user/components/modals/UsernamePickerModal.test.tsx                                                  |   259 +
 fluxer_app/src/features/user/components/modals/UsernamePickerModal.tsx                                                       |   207 +
 fluxer_app/src/features/user/components/modals/tabs/DesktopSettingsTab.tsx                                                   |    18 +
 fluxer_app/src/features/user/components/modals/tabs/GiftInventoryTab.module.css                                              |    10 +
 fluxer_app/src/features/user/components/modals/tabs/GiftInventoryTab.tsx                                                     |     6 +-
 fluxer_app/src/features/user/components/modals/tabs/LanguageTab.tsx                                                          |    25 +-
 fluxer_app/src/features/user/components/modals/tabs/MyProfileTab.tsx                                                         |     2 -
 fluxer_app/src/features/user/components/modals/tabs/PlutoniumTab.test.tsx                                                    |    92 +
 fluxer_app/src/features/user/components/modals/tabs/UserVideoTab.tsx                                                         |     4 +-
 fluxer_app/src/features/user/components/modals/tabs/UserVoiceTab.tsx                                                         |    40 +-
 fluxer_app/src/features/user/components/modals/tabs/account_security_tab/AccountTab.tsx                                      |     7 +
 fluxer_app/src/features/user/components/modals/tabs/appearance_tab/ScalingTab.tsx                                            |     9 +-
 fluxer_app/src/features/user/components/modals/tabs/appearance_tab/ThemeTab.module.css                                       |     2 +-
 fluxer_app/src/features/user/components/modals/tabs/appearance_tab/theme/CoalThemeLabel.test.ts                              |    30 +
 fluxer_app/src/features/user/components/modals/tabs/appearance_tab/theme/ThemeTabContent.tsx                                 |    15 +-
 fluxer_app/src/features/user/components/modals/tabs/applications_tab/ApplicationsTab.module.css                              |    23 +-
 fluxer_app/src/features/user/components/modals/tabs/applications_tab/ApplicationsTab.test.tsx                                |    97 +
 fluxer_app/src/features/user/components/modals/tabs/applications_tab/application_detail/ApplicationDetail.module.css         |     2 +-
 fluxer_app/src/features/user/components/modals/tabs/applications_tab/index.tsx                                               |    24 +-
 fluxer_app/src/features/user/components/modals/tabs/components/EntranceSoundSection.tsx                                      |     2 +-
 fluxer_app/src/features/user/components/modals/tabs/components/SystemShortcutsSection.tsx                                    |   120 +-
 fluxer_app/src/features/user/components/modals/tabs/hooks/useMicTest.test.tsx                                                |   225 +
 fluxer_app/src/features/user/components/modals/tabs/hooks/useMicTest.tsx                                                     |    56 +-
 fluxer_app/src/features/user/components/modals/tabs/my_profile_tab/AccentColorPicker.tsx                                     |     9 +-
 fluxer_app/src/features/user/components/modals/tabs/my_profile_tab/BannerUploader.tsx                                        |     2 +-
 fluxer_app/src/features/user/components/modals/tabs/my_profile_tab/MyProfileTabUsernameSection.tsx                           |    97 +-
 fluxer_app/src/features/user/components/modals/tabs/my_profile_tab/PremiumBadgeSettings.test.tsx                             |    72 +
 fluxer_app/src/features/user/components/modals/tabs/my_profile_tab/PremiumBadgeSettings.tsx                                  |    64 +-
 fluxer_app/src/features/user/components/modals/tabs/notifications_tab/NotificationsTabSounds.test.tsx                        |   149 +
 fluxer_app/src/features/user/components/modals/tabs/notifications_tab/NotificationsTabSounds.tsx                             |    19 +-
 fluxer_app/src/features/user/components/modals/tabs/privacy_safety_tab/PrivacyGameActivityIntegration.test.tsx               |    68 +
 fluxer_app/src/features/user/components/modals/tabs/privacy_safety_tab/PrivacySafetyTabInline.tsx                            |    15 +
 fluxer_app/src/features/user/components/modals/tabs/privacy_safety_tab/ProfilePrivacyTab.test.tsx                            |   128 +
 fluxer_app/src/features/user/components/modals/tabs/privacy_safety_tab/ProfilePrivacyTab.tsx                                 |   107 +-
 fluxer_app/src/features/user/components/modals/user_profile_modal/ProfileBody.page.test.tsx                                  |   159 +
 fluxer_app/src/features/user/components/modals/user_profile_modal/ProfileBody.tsx                                            |    63 +-
 fluxer_app/src/features/user/components/modals/user_profile_modal/ProfileContent.tsx                                         |     9 +-
 fluxer_app/src/features/user/components/modals/user_profile_modal/ProfileMediaHeader.tsx                                     |    67 +-
 fluxer_app/src/features/user/components/modals/user_profile_modal/ProfileModalContent.tsx                                    |     2 +
 fluxer_app/src/features/user/components/modals/user_profile_modal/UserProfileModalShared.ts                                  |    15 +
 fluxer_app/src/features/user/components/modals/user_profile_modal/UserProfileModalUserInfo.test.tsx                          |    72 +
 fluxer_app/src/features/user/components/modals/user_profile_modal/UserProfileModalUserInfo.tsx                               |    62 +-
 fluxer_app/src/features/user/components/pages/ProfileMediaGrid.module.css                                                    |    57 +
 fluxer_app/src/features/user/components/pages/ProfileMediaGrid.test.tsx                                                      |   155 +
 fluxer_app/src/features/user/components/pages/ProfileMediaGrid.tsx                                                           |   135 +
 fluxer_app/src/features/user/components/pages/UserProfilePage.module.css                                                     |   127 +
 fluxer_app/src/features/user/components/pages/UserProfilePage.test.tsx                                                       |   464 +
 fluxer_app/src/features/user/components/pages/UserProfilePage.tsx                                                            |   661 +
 fluxer_app/src/features/user/components/popouts/UserProfileBadges.module.css                                                 |    34 +-
 fluxer_app/src/features/user/components/popouts/UserProfileBadges.test.tsx                                                   |   306 +
 fluxer_app/src/features/user/components/popouts/UserProfileBadges.tsx                                                        |   224 +-
 fluxer_app/src/features/user/components/popouts/UserProfilePopout.test.tsx                                                   |   174 +
 fluxer_app/src/features/user/components/popouts/UserProfilePopout.tsx                                                        |   113 +-
 fluxer_app/src/features/user/components/profile/ProfilePreview.test.tsx                                                      |   174 +
 fluxer_app/src/features/user/components/profile/ProfilePreview.tsx                                                           |    44 +-
 fluxer_app/src/features/user/components/profile/profile_card/ProfileCardBanner.test.tsx                                      |    69 +
 fluxer_app/src/features/user/components/profile/profile_card/ProfileCardBanner.tsx                                           |    46 +-
 fluxer_app/src/features/user/components/profile/profile_card/ProfileCardLayout.tsx                                           |     9 +-
 fluxer_app/src/features/user/components/profile/profile_card/ProfileCardUserInfo.module.css                                  |     9 +
 fluxer_app/src/features/user/components/profile/profile_card/ProfileCardUserInfo.tsx                                         |    19 +-
 fluxer_app/src/features/user/components/settings_utils/AppZoomLevelUtils.test.ts                                             |    32 +
 fluxer_app/src/features/user/components/settings_utils/AppZoomLevelUtils.ts                                                  |     2 +-
 fluxer_app/src/features/user/components/settings_utils/DesktopSettingsTabs.ts                                                |     6 +
 fluxer_app/src/features/user/components/settings_utils/GuildSettingsConstants.test.ts                                        |    83 +
 fluxer_app/src/features/user/components/settings_utils/GuildSettingsConstants.ts                                             |    42 +
 fluxer_app/src/features/user/components/settings_utils/GuildSettingsTabComponents.ts                                         |     6 +
 fluxer_app/src/features/user/components/settings_utils/SettingsConstants.tsx                                                 |    37 +-
 fluxer_app/src/features/user/components/settings_utils/SettingsSearchIndex.ts                                                |     4 +
 fluxer_app/src/features/user/components/settings_utils/SettingsStatusBadge.module.css                                        |     2 +-
 fluxer_app/src/features/user/components/settings_utils/UserSettingsDeepLinks.ts                                              |     3 +
 fluxer_app/src/features/user/components/settings_utils/search_index/GameOverlayIndex.ts                                      |    26 +
 fluxer_app/src/features/user/components/settings_utils/search_index/MyProfileIndex.ts                                        |     2 +-
 fluxer_app/src/features/user/components/settings_utils/search_index/PlutoniumIndex.ts                                        |     4 +-
 fluxer_app/src/features/user/components/settings_utils/search_index/ProfileCosmeticsIndex.ts                                 |    53 +
 fluxer_app/src/features/user/components/settings_utils/section_registry/PrivacySafetySections.ts                             |    27 +
 fluxer_app/src/features/user/components/settings_utils/section_registry/SectionRegistryTypes.ts                              |     4 +
 fluxer_app/src/features/user/constants/UserProfileSurfaceGeometry.test.ts                                                    |    77 +
 fluxer_app/src/features/user/constants/UserProfileSurfaceGeometry.ts                                                         |    52 +
 fluxer_app/src/features/user/events/UserSettingsUpdate.ts                                                                    |     5 +-
 fluxer_app/src/features/user/hooks/useProfileBadgeMetrics.test.tsx                                                           |   133 +
 fluxer_app/src/features/user/hooks/useProfileBadgeMetrics.ts                                                                 |    66 +
 fluxer_app/src/features/user/hooks/useUserProfileHoverPreload.ts                                                             |    33 +-
 fluxer_app/src/features/user/hooks/useUserProfileSurfaceState.ts                                                             |    27 +-
 fluxer_app/src/features/user/hooks/useUsernameSelectionAvailability.test.ts                                                  |   100 +
 fluxer_app/src/features/user/hooks/useUsernameSelectionAvailability.ts                                                       |    66 +
 fluxer_app/src/features/user/models/Profile.test.ts                                                                          |    71 +
 fluxer_app/src/features/user/models/Profile.ts                                                                               |    43 +-
 fluxer_app/src/features/user/models/User.test.ts                                                                             |   131 +
 fluxer_app/src/features/user/models/User.ts                                                                                  |    73 +-
 fluxer_app/src/features/user/state/SyncedField.ts                                                                            |    29 +-
 fluxer_app/src/features/user/state/SyncedFieldAccountTransition.test.ts                                                      |   771 +
 fluxer_app/src/features/user/state/UserSettings.ts                                                                           |   159 +-
 fluxer_app/src/features/user/state/UserSettingsReadyWithoutSettings.test.ts                                                  |   363 +
 fluxer_app/src/features/user/state/UserSettingsTransitionFlush.test.ts                                                       |    31 +-
 fluxer_app/src/features/user/state/UsernameSelection.test.ts                                                                 |    74 +
 fluxer_app/src/features/user/state/UsernameSelection.ts                                                                      |    73 +
 fluxer_app/src/features/user/state/Users.eviction.test.ts                                                                    |   106 +
 fluxer_app/src/features/user/state/Users.identity.test.ts                                                                    |    76 +
 fluxer_app/src/features/user/state/Users.ts                                                                                  |    68 +-
 fluxer_app/src/features/user/utils/ProfilePrivacyUtils.ts                                                                    |    17 +
 fluxer_app/src/features/user/utils/ProfileUtils.test.ts                                                                      |    57 +
 fluxer_app/src/features/user/utils/ProfileUtils.ts                                                                           |    10 +
 fluxer_app/src/features/user/utils/UserTagUtils.test.ts                                                                      |    30 +
 fluxer_app/src/features/user/utils/UserTagUtils.ts                                                                           |    22 +-
 fluxer_app/src/features/user/utils/UsernameSelectionGateUtils.test.ts                                                        |    81 +
 fluxer_app/src/features/user/utils/UsernameSelectionGateUtils.ts                                                             |    60 +
 fluxer_app/src/features/voice/VoiceGatewayLifecycle.ts                                                                       |     7 +
 fluxer_app/src/features/voice/VoiceGatewayLifecycleUsernameSelection.test.ts                                                 |    35 +
 fluxer_app/src/features/voice/commands/VoiceDebugEventSinkCommands.test.ts                                                   |    34 +
 fluxer_app/src/features/voice/commands/VoiceDebugEventSinkCommands.ts                                                        |    24 +-
 fluxer_app/src/features/voice/commands/VoiceSettingsCommands.ts                                                              |     3 +
 fluxer_app/src/features/voice/components/IncomingCallUI.module.css                                                           |     6 +-
 fluxer_app/src/features/voice/components/PiPOverlay.test.tsx                                                                 |    87 +
 fluxer_app/src/features/voice/components/PiPOverlay.tsx                                                                      |     2 +-
 fluxer_app/src/features/voice/components/StreamSettingsMenuContent.tsx                                                       |     6 +-
 fluxer_app/src/features/voice/components/VoiceCallView.test.tsx                                                              |   328 +
 fluxer_app/src/features/voice/components/VoiceCallView.tsx                                                                   |    30 +-
 fluxer_app/src/features/voice/components/VoiceConnectionStatus.module.css                                                    |    82 +-
 fluxer_app/src/features/voice/components/VoiceConnectionStatusCss.test.ts                                                    |    46 +
 fluxer_app/src/features/voice/components/VoiceLiveKitRoot.test.tsx                                                           |   286 +
 fluxer_app/src/features/voice/components/VoiceLiveKitRoot.tsx                                                                |    60 +-
 fluxer_app/src/features/voice/components/VoiceMessageComposerModal.teardown.test.tsx                                         |   439 +
 fluxer_app/src/features/voice/components/VoiceMessageComposerModal.tsx                                                       |    45 +-
 fluxer_app/src/features/voice/components/VoiceParticipantTile.tsx                                                            |     1 +
 fluxer_app/src/features/voice/components/VoiceReconnectionManager.test.tsx                                                   |   117 +
 fluxer_app/src/features/voice/components/VoiceReconnectionManager.tsx                                                        |     5 +-
 fluxer_app/src/features/voice/components/VoiceRegionTeleportOverlay.module.css                                               |     6 +-
 fluxer_app/src/features/voice/components/alerts/ScreenShareRollbackIncompleteModal.tsx                                       |     7 +-
 fluxer_app/src/features/voice/components/bottomsheets/DirectCallLobbyBottomSheet.module.css                                  |     5 +
 fluxer_app/src/features/voice/components/bottomsheets/DirectCallLobbyBottomSheet.tsx                                         |     6 +-
 fluxer_app/src/features/voice/components/bottomsheets/VoiceLobbyBottomSheet.module.css                                       |    11 +-
 fluxer_app/src/features/voice/components/bottomsheets/VoiceLobbyBottomSheet.tsx                                              |     6 +-
 fluxer_app/src/features/voice/components/compact_voice_call_view/CompactVoiceCallViewInner.test.tsx                          |   137 +
 fluxer_app/src/features/voice/components/media_player/MediaPlayButton.module.css                                             |     2 +-
 fluxer_app/src/features/voice/components/media_player/VideoPlayer.module.css                                                 |     4 +-
 fluxer_app/src/features/voice/components/useStatsForNerds.ts                                                                 |     6 +-
 fluxer_app/src/features/voice/components/useVoiceCallAppFullscreen.ts                                                        |     2 +-
 fluxer_app/src/features/voice/components/useVoiceCallTracksAndLayout.ts                                                      |     2 +-
 fluxer_app/src/features/voice/components/voice_connection_status/AudioProcessingModal.tsx                                    |    96 +-
 fluxer_app/src/features/voice/components/voice_connection_status/LocalParticipantControls.test.tsx                           |   387 +
 fluxer_app/src/features/voice/components/voice_connection_status/LocalParticipantControls.tsx                                |   122 +-
 fluxer_app/src/features/voice/components/voice_connection_status/VoiceConnectionStatusInner.tsx                              |     6 +-
 fluxer_app/src/features/voice/components/voice_connection_status/VoiceDetailsPopout.tsx                                      |    21 +-
 fluxer_app/src/features/voice/components/voice_connection_status/shared.ts                                                   |     8 +
 fluxer_app/src/features/voice/diagnostics/VoiceDebugBrowserEventSinkPopout.test.ts                                           |   118 +
 fluxer_app/src/features/voice/diagnostics/VoiceDebugBrowserEventSinkPopout.ts                                                |    55 +-
 fluxer_app/src/features/voice/diagnostics/VoiceDebugStatsForwarder.test.tsx                                                  |   148 +
 fluxer_app/src/features/voice/diagnostics/VoiceDebugStatsForwarder.tsx                                                       |    32 +-
 fluxer_app/src/features/voice/engine/MediaEngineFacade.ts                                                                    |    29 +-
 fluxer_app/src/features/voice/engine/MediaEngineFacadeStateMachine.ts                                                        |    15 +-
 fluxer_app/src/features/voice/engine/MediaEngineFacadeStats.test.tsx                                                         |   499 +
 fluxer_app/src/features/voice/engine/MediaEngineFacadeUsernameError.test.ts                                                  |    30 +
 fluxer_app/src/features/voice/engine/MediaEngineStatsSubscriptions.test.ts                                                   |    87 +
 fluxer_app/src/features/voice/engine/VoiceDevicePermissionState.ts                                                           |     4 +
 fluxer_app/src/features/voice/engine/VoiceInputAudioContext.test.ts                                                          |   129 +
 fluxer_app/src/features/voice/engine/VoiceInputAudioContext.ts                                                               |    27 +-
 fluxer_app/src/features/voice/engine/VoiceParticipantStateMachine.test.ts                                                    |    97 +
 fluxer_app/src/features/voice/engine/VoiceParticipantStateMachine.ts                                                         |    40 +-
 fluxer_app/src/features/voice/engine/VoiceRoomEventBinder.ts                                                                 |    12 +-
 fluxer_app/src/features/voice/engine/VoiceRoomEventBinderConnected.test.ts                                                   |   168 +
 fluxer_app/src/features/voice/engine/VoiceSharedAudioContext.test.ts                                                         |    96 +
 fluxer_app/src/features/voice/engine/VoiceSharedAudioContext.ts                                                              |    26 +-
 fluxer_app/src/features/voice/engine/VoiceStatsStateMachine.ts                                                               |    14 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppAudioPreferencesSyncBinding.test.ts                                  |   177 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppAudioPreferencesSyncBinding.ts                                       |     2 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppAudioSettingsSync.test.ts                                            |    90 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppAudioSettingsSync.ts                                                 |    29 +-
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppConnectionHostAdapter.test.ts                                        |    69 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppConnectionHostAdapter.ts                                             |    10 +-
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppDebugEventSinkHostAdapter.test.ts                                    |   154 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppDebugEventSinkHostAdapter.ts                                         |    54 +-
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppLiveKitExecutionAdapter.test.ts                                      |    44 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppLiveKitExecutionAdapter.ts                                           |     5 +-
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppMediaExecutionAdapter.tsx                                            |   157 +-
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppMediaExecutionAdapterHangUp.test.ts                                  |  1057 ++
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppRemoteSpeakingAdapter.test.ts                                        |   196 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppRemoteSpeakingAdapter.ts                                             |    61 +-
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppStatsHostAdapter.test.ts                                             |   213 +
 fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppStatsHostAdapter.ts                                                  |    82 +-
 fluxer_app/src/features/voice/hooks/usePendingVoiceConnection.tsx                                                            |    10 +-
 fluxer_app/src/features/voice/state/VoiceCallFullscreen.test.ts                                                              |    34 +
 fluxer_app/src/features/voice/state/VoiceCallFullscreen.ts                                                                   |     9 +-
 fluxer_app/src/features/voice/state/VoiceConnectionAvatarStackDefault.test.ts                                                |    62 +
 fluxer_app/src/features/voice/state/VoiceConnectionIdDefault.test.ts                                                         |    59 +
 fluxer_app/src/features/voice/state/VoiceNoiseSuppressionRollout.test.ts                                                     |   116 +
 fluxer_app/src/features/voice/state/VoiceNoiseSuppressionRollout.ts                                                          |    41 +
 fluxer_app/src/features/voice/state/VoiceSettings.ts                                                                         |   155 +-
 fluxer_app/src/features/voice/state/VoiceSettingsDeepFilterReset.test.ts                                                     |    96 +
 fluxer_app/src/features/voice/state/VoiceSettingsStreamingModeDefault.test.ts                                                |    96 +
 fluxer_app/src/features/voice/utils/InAppMediaSoundCapture.test.ts                                                           |   163 +
 fluxer_app/src/features/voice/utils/InAppMediaSoundCapture.ts                                                                |    19 +-
 fluxer_app/src/features/voice/utils/MediaDeviceStartupPreload.test.ts                                                        |    67 +
 fluxer_app/src/features/voice/utils/MediaDeviceStartupPreload.ts                                                             |    11 +-
 fluxer_app/src/features/voice/utils/ScreenShareOptions.test.ts                                                               |    84 +-
 fluxer_app/src/features/voice/utils/ScreenShareOptions.ts                                                                    |    17 +-
 fluxer_app/src/features/voice/utils/TtsBundling.test.ts                                                                      |    46 +
 fluxer_app/src/features/voice/utils/VoiceActivityGate.test.ts                                                                |   169 +
 fluxer_app/src/features/voice/utils/VoiceActivityGate.ts                                                                     |    81 +-
 fluxer_app/src/features/voice/utils/VoiceActivityGateLoading.test.ts                                                         |    63 +
 fluxer_app/src/features/voice/utils/VoiceDeviceManager.test.ts                                                               |    36 +
 fluxer_app/src/features/voice/utils/VoiceDeviceManager.ts                                                                    |    22 +-
 fluxer_app/src/features/voice/utils/VoiceInputDeepFilter.test.ts                                                             |   168 +
 fluxer_app/src/features/voice/utils/VoiceInputGraphStudio.test.ts                                                            |   600 +
 fluxer_app/src/features/voice/utils/VoiceInputProcessor.ts                                                                   |   243 +-
 fluxer_app/src/features/voice/utils/VoicePipelineTuning.test.ts                                                              |   113 +
 fluxer_app/src/features/voice/utils/VoicePipelineTuning.ts                                                                   |    50 +
 fluxer_app/src/features/voice/utils/VoiceProcessingProfile.test.ts                                                           |    20 +
 fluxer_app/src/features/voice/utils/VoiceProcessingProfile.ts                                                                |   117 +-
 fluxer_app/src/features/voice/utils/VoiceSoftGain.test.ts                                                                    |   116 +
 fluxer_app/src/features/voice/utils/VoiceStatsForNerdsPresenter.ts                                                           |     1 +
 fluxer_app/src/features/voice/utils/VoiceSuppressionContract.test.ts                                                         |   139 +
 fluxer_app/src/features/voice/utils/VoiceTtsUtils.tsx                                                                        |     4 +-
 fluxer_app/src/features/voice/utils/VoiceTtsUtilsFallback.test.ts                                                            |   196 +
 fluxer_app/src/features/voice/utils/VoiceTtsUtilsPrivacy.test.ts                                                             |   153 +
 fluxer_app/src/features/voice/utils/VoiceVadAssets.test.ts                                                                   |   162 +
 fluxer_app/src/features/voice/utils/noise_suppression/DeepFilter.test.ts                                                     |   271 +
 fluxer_app/src/features/voice/utils/noise_suppression/DeepFilter.ts                                                          |   168 +-
 fluxer_app/src/features/voice/utils/noise_suppression/DeepFilterProcessor.test.ts                                            |    74 +
 fluxer_app/src/features/voice/utils/noise_suppression/NOTICE.md                                                              |    11 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionAvailability.test.ts                                   |   134 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionAvailability.ts                                        |   140 +-
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionChain.test.ts                                          |    66 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionChain.ts                                               |    42 +-
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionChoices.operator.test.ts                               |    82 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionChoices.test.ts                                        |   147 +-
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionChoices.ts                                             |    98 +-
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionGateTuning.ts                                          |    23 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionLabels.test.ts                                         |    70 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionLabels.ts                                              |    33 +-
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionLiveConfig.test.ts                                     |   104 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionRuntime.operator.test.ts                               |   165 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionRuntime.test.ts                                        |   145 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionRuntime.ts                                             |   115 +-
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionSelection.ts                                           |   121 +-
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionWorkletAssets.ts                                       |     4 +
 fluxer_app/src/features/voice/utils/noise_suppression/NoiseSuppressionWorkletHealth.test.ts                                  |    81 +
 fluxer_app/src/features/voice/utils/noise_suppression/deepFilterProcessor.worklet.js                                         |    16 +
 fluxer_app/src/features/voice/utils/voiceGateProcessor.worklet.js                                                            |   114 +-
 fluxer_app/src/features/voice/utils/voiceSoftGain.worklet.js                                                                 |    81 +
 fluxer_app/src/features/voice_scene/audio/RoomSpatialAudio.test.ts                                                           |   318 +
 fluxer_app/src/features/voice_scene/audio/RoomSpatialAudio.ts                                                                |   180 +
 fluxer_app/src/features/voice_scene/audio/SpatialAudioMath.test.ts                                                           |   203 +
 fluxer_app/src/features/voice_scene/audio/SpatialAudioMath.ts                                                                |   135 +
 fluxer_app/src/features/voice_scene/commands/VoiceSeatCommands.test.ts                                                       |    63 +
 fluxer_app/src/features/voice_scene/commands/VoiceSeatCommands.ts                                                            |    35 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneAnchor.test.tsx                                                     |   806 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneAnchor.tsx                                                          |   364 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneAvatar.module.css                                                   |    15 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneAvatar.test.tsx                                                     |   185 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneAvatar.tsx                                                          |   147 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneOverlay.module.css                                                  |   276 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneOverlay.test.tsx                                                    |   723 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneOverlay.tsx                                                         |   303 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneRoomThemeSelect.test.tsx                                            |    59 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneRoomThemeSelect.tsx                                                 |    73 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneSeatHud.module.css                                                  |    55 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneSeatHud.test.tsx                                                    |   186 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneSeatHud.tsx                                                         |   185 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneSeatMarker.tsx                                                      |    49 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneStanding.tsx                                                        |    78 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneToggleButton.tsx                                                    |    75 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneToolbar.module.css                                                  |    61 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneToolbar.test.tsx                                                    |   111 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneToolbar.tsx                                                         |   130 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneTv.module.css                                                       |    12 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneTv.test.tsx                                                         |   913 ++
 fluxer_app/src/features/voice_scene/components/VoiceSceneTv.tsx                                                              |   405 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneTvPicker.test.tsx                                                   |   114 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneTvPicker.tsx                                                        |    87 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneView.module.css                                                     |    51 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneView.test.tsx                                                       |   307 +
 fluxer_app/src/features/voice_scene/components/VoiceSceneView.tsx                                                            |   141 +
 fluxer_app/src/features/voice_scene/components/useCameraMode.ts                                                              |    14 +
 fluxer_app/src/features/voice_scene/hooks/useSceneEscape.test.ts                                                             |    75 +
 fluxer_app/src/features/voice_scene/hooks/useSceneEscape.ts                                                                  |    21 +
 fluxer_app/src/features/voice_scene/hooks/useSeatAssignments.test.ts                                                         |   167 +
 fluxer_app/src/features/voice_scene/hooks/useSeatAssignments.ts                                                              |    70 +
 fluxer_app/src/features/voice_scene/hooks/useSeatFallback.test.ts                                                            |   108 +
 fluxer_app/src/features/voice_scene/hooks/useSeatFallback.ts                                                                 |    39 +
 fluxer_app/src/features/voice_scene/hooks/useSeatView.test.ts                                                                |   244 +
 fluxer_app/src/features/voice_scene/hooks/useSeatView.ts                                                                     |    87 +
 fluxer_app/src/features/voice_scene/hooks/useSpatialAudioSync.test.ts                                                        |   191 +
 fluxer_app/src/features/voice_scene/hooks/useSpatialAudioSync.ts                                                             |   111 +
 fluxer_app/src/features/voice_scene/hooks/useTableGameScene.test.ts                                                          |   498 +
 fluxer_app/src/features/voice_scene/hooks/useTableGameScene.ts                                                               |   312 +
 fluxer_app/src/features/voice_scene/hooks/useTvScreenShareDemand.ts                                                          |    89 +
 fluxer_app/src/features/voice_scene/hooks/useWatchSeatSpectate.test.ts                                                       |   227 +
 fluxer_app/src/features/voice_scene/hooks/useWatchSeatSpectate.ts                                                            |    63 +
 fluxer_app/src/features/voice_scene/scene/RoomCameraRig.test.ts                                                              |   916 ++
 fluxer_app/src/features/voice_scene/scene/RoomCameraRig.ts                                                                   |   533 +
 fluxer_app/src/features/voice_scene/scene/ScreenLayer.test.ts                                                                |   250 +
 fluxer_app/src/features/voice_scene/scene/ScreenLayer.ts                                                                     |   140 +
 fluxer_app/src/features/voice_scene/scene/TableGame3DHost.test.ts                                                            |   541 +
 fluxer_app/src/features/voice_scene/scene/TableGame3DHost.ts                                                                 |   321 +
 fluxer_app/src/features/voice_scene/scene/TableGame3DHostInteraction.test.ts                                                 |   189 +
 fluxer_app/src/features/voice_scene/scene/VoiceSceneRenderLoop.test.ts                                                       |   146 +
 fluxer_app/src/features/voice_scene/scene/VoiceSceneRenderLoop.ts                                                            |    88 +
 fluxer_app/src/features/voice_scene/scene/VoiceSceneRenderer.test.ts                                                         |  1142 ++
 fluxer_app/src/features/voice_scene/scene/VoiceSceneRenderer.ts                                                              |   518 +
 fluxer_app/src/features/voice_scene/scene/VoiceSceneTypes.ts                                                                 |   147 +
 fluxer_app/src/features/voice_scene/scene/table/BoardTableModel.test.ts                                                      |   676 +
 fluxer_app/src/features/voice_scene/scene/table/BoardTableModel.ts                                                           |   328 +
 fluxer_app/src/features/voice_scene/scene/table/DiceAnimation.test.ts                                                        |   147 +
 fluxer_app/src/features/voice_scene/scene/table/DiceAnimation.ts                                                             |   106 +
 fluxer_app/src/features/voice_scene/scene/table/OkeyTableModel.test.ts                                                       |   980 ++
 fluxer_app/src/features/voice_scene/scene/table/OkeyTableModel.ts                                                            |   331 +
 fluxer_app/src/features/voice_scene/scene/table/OkeyTileAtlas.test.ts                                                        |   144 +
 fluxer_app/src/features/voice_scene/scene/table/OkeyTileAtlas.ts                                                             |   101 +
 fluxer_app/src/features/voice_scene/scene/table/TableModelTypes.ts                                                           |    51 +
 fluxer_app/src/features/voice_scene/scene/table/TableParts.test.ts                                                           |   159 +
 fluxer_app/src/features/voice_scene/scene/table/TableParts.ts                                                                |   111 +
 fluxer_app/src/features/voice_scene/scene/table/TavlaTableModel.test.ts                                                      |   453 +
 fluxer_app/src/features/voice_scene/scene/table/TavlaTableModel.ts                                                           |   407 +
 fluxer_app/src/features/voice_scene/scene/table/boardLayout.test.ts                                                          |   203 +
 fluxer_app/src/features/voice_scene/scene/table/boardLayout.ts                                                               |   116 +
 fluxer_app/src/features/voice_scene/scene/table/okeyTableLayout.test.ts                                                      |   454 +
 fluxer_app/src/features/voice_scene/scene/table/okeyTableLayout.ts                                                           |   510 +
 fluxer_app/src/features/voice_scene/scene/table/tavlaLayout.test.ts                                                          |   253 +
 fluxer_app/src/features/voice_scene/scene/table/tavlaLayout.ts                                                               |   318 +
 fluxer_app/src/features/voice_scene/state/RoomView.test.ts                                                                   |    76 +
 fluxer_app/src/features/voice_scene/state/RoomView.ts                                                                        |    28 +
 fluxer_app/src/features/voice_scene/state/VoiceRoomControlDiscovery.test.ts                                                  |    82 +
 fluxer_app/src/features/voice_scene/state/VoiceRoomControlDiscovery.ts                                                       |    27 +
 fluxer_app/src/features/voice_scene/state/VoiceSceneSeatView.ts                                                              |    53 +
 fluxer_app/src/features/voice_scene/state/VoiceSceneSettings.ts                                                              |    44 +
 fluxer_app/src/features/voice_scene/state/VoiceSceneTvRequest.test.ts                                                        |   120 +
 fluxer_app/src/features/voice_scene/state/VoiceSceneTvRequest.ts                                                             |   103 +
 fluxer_app/src/features/voice_scene/utils/CameraCardLayout.ts                                                                |   112 +
 fluxer_app/src/features/voice_scene/utils/CameraLimits.test.ts                                                               |   259 +
 fluxer_app/src/features/voice_scene/utils/CameraLimits.ts                                                                    |   148 +
 fluxer_app/src/features/voice_scene/utils/EffectiveRoomTheme.test.ts                                                         |    30 +
 fluxer_app/src/features/voice_scene/utils/EffectiveRoomTheme.ts                                                              |    14 +
 fluxer_app/src/features/voice_scene/utils/GlbRoomContract.test.ts                                                            |   202 +
 fluxer_app/src/features/voice_scene/utils/GlbRoomContract.ts                                                                 |   144 +
 fluxer_app/src/features/voice_scene/utils/RoomThemeOptions.ts                                                                |    41 +
 fluxer_app/src/features/voice_scene/utils/RoomViewAvailability.test.ts                                                       |   101 +
 fluxer_app/src/features/voice_scene/utils/RoomViewAvailability.ts                                                            |    60 +
 fluxer_app/src/features/voice_scene/utils/SceneWheel.ts                                                                      |    20 +
 fluxer_app/src/features/voice_scene/utils/SeatAssignment.test.ts                                                             |   148 +
 fluxer_app/src/features/voice_scene/utils/SeatAssignment.ts                                                                  |    70 +
 fluxer_app/src/features/voice_scene/utils/SeatedPawnVisibility.test.ts                                                       |   401 +
 fluxer_app/src/features/voice_scene/utils/SeatedView.test.ts                                                                 |   500 +
 fluxer_app/src/features/voice_scene/utils/SeatedView.ts                                                                      |   379 +
 fluxer_app/src/features/voice_scene/utils/WebglSupport.test.ts                                                               |    55 +
 fluxer_app/src/features/voice_scene/utils/WebglSupport.ts                                                                    |    37 +
 fluxer_app/src/features/voice_scene/video/CameraSubscriptionPlan.test.ts                                                     |   160 +
 fluxer_app/src/features/voice_scene/video/CameraSubscriptionPlan.ts                                                          |    74 +
 fluxer_app/src/features/voice_scene/video/RoomCameraStore.ts                                                                 |    10 +
 fluxer_app/src/features/voice_scene/video/RoomCameraSubscriptions.test.ts                                                    |   262 +
 fluxer_app/src/features/voice_scene/video/RoomCameraSubscriptions.ts                                                         |   141 +
 fluxer_app/src/features/voice_scene/video/TvSource.test.ts                                                                   |    53 +
 fluxer_app/src/features/voice_scene/video/TvSource.ts                                                                        |    30 +
 fluxer_app/src/features/voice_scene/video/useRoomCameras.test.tsx                                                            |   350 +
 fluxer_app/src/features/voice_scene/video/useRoomCameras.ts                                                                  |   238 +
 fluxer_app/src/index.tsx                                                                                                     |     9 +-
 fluxer_app/src/media/images/avatars/0.png                                                                                    |   Bin 9439 -> 29011 bytes
 fluxer_app/src/media/images/avatars/1.png                                                                                    |   Bin 8922 -> 31622 bytes
 fluxer_app/src/media/images/avatars/2.png                                                                                    |   Bin 9168 -> 33087 bytes
 fluxer_app/src/media/images/avatars/3.png                                                                                    |   Bin 8349 -> 31519 bytes
 fluxer_app/src/media/images/avatars/4.png                                                                                    |   Bin 8500 -> 30235 bytes
 fluxer_app/src/media/images/avatars/5.png                                                                                    |   Bin 10091 -> 33421 bytes
 fluxer_app/src/media/images/avatars/NOTICE.md                                                                                |     6 +-
 fluxer_app/src/media/images/micup-premium-badge.png                                                                          |   Bin 0 -> 21602 bytes
 fluxer_app/src/media/images/premium/plus/kart-avatar-600.webp                                                                |   Bin 0 -> 37864 bytes
 fluxer_app/src/media/images/premium/plus/kart-avatar.webp                                                                    |   Bin 0 -> 109674 bytes
 fluxer_app/src/media/images/premium/plus/kart-etiket-600.webp                                                                |   Bin 0 -> 40816 bytes
 fluxer_app/src/media/images/premium/plus/kart-etiket.webp                                                                    |   Bin 0 -> 116574 bytes
 fluxer_app/src/media/images/premium/plus/kart-indirim-600.webp                                                               |   Bin 0 -> 32230 bytes
 fluxer_app/src/media/images/premium/plus/kart-indirim.webp                                                                   |   Bin 0 -> 92350 bytes
 fluxer_app/src/media/images/premium/plus/kart-isim-600.webp                                                                  |   Bin 0 -> 38784 bytes
 fluxer_app/src/media/images/premium/plus/kart-isim.webp                                                                      |   Bin 0 -> 108892 bytes
 fluxer_app/src/media/images/premium/plus/kart-profil-600.webp                                                                |   Bin 0 -> 30842 bytes
 fluxer_app/src/media/images/premium/plus/kart-profil.webp                                                                    |   Bin 0 -> 86720 bytes
 fluxer_app/src/media/images/premium/plus/kart-rozet-600.webp                                                                 |   Bin 0 -> 28156 bytes
 fluxer_app/src/media/images/premium/plus/kart-rozet.webp                                                                     |   Bin 0 -> 76076 bytes
 fluxer_app/src/media/images/premium/plus/plan-aylik.webp                                                                     |   Bin 0 -> 64400 bytes
 fluxer_app/src/media/images/premium/plus/plan-yillik.webp                                                                    |   Bin 0 -> 108650 bytes
 fluxer_app/src/media/images/premium/plus/plus-ana-1200.webp                                                                  |   Bin 0 -> 62590 bytes
 fluxer_app/src/media/images/premium/plus/plus-ana.webp                                                                       |   Bin 0 -> 158482 bytes
 fluxer_app/src/media/images/shop/sets/ana-1200.webp                                                                          |   Bin 0 -> 60052 bytes
 fluxer_app/src/media/images/shop/sets/ana.webp                                                                               |   Bin 0 -> 143752 bytes
 fluxer_app/src/media/images/shop/sets/angel-wings-1200.webp                                                                  |   Bin 0 -> 56942 bytes
 fluxer_app/src/media/images/shop/sets/angel-wings.webp                                                                       |   Bin 0 -> 146462 bytes
 fluxer_app/src/media/images/shop/sets/kara-ejder-1200.webp                                                                   |   Bin 0 -> 40678 bytes
 fluxer_app/src/media/images/shop/sets/kara-ejder.webp                                                                        |   Bin 0 -> 108828 bytes
 fluxer_app/src/media/images/shop/sets/kedi-1200.webp                                                                         |   Bin 0 -> 73580 bytes
 fluxer_app/src/media/images/shop/sets/kedi.webp                                                                              |   Bin 0 -> 188226 bytes
 fluxer_app/src/media/images/shop/sets/kuzgun-1200.webp                                                                       |   Bin 0 -> 49654 bytes
 fluxer_app/src/media/images/shop/sets/kuzgun.webp                                                                            |   Bin 0 -> 132598 bytes
 fluxer_app/src/media/images/shop/sets/neon-1200.webp                                                                         |   Bin 0 -> 81316 bytes
 fluxer_app/src/media/images/shop/sets/neon.webp                                                                              |   Bin 0 -> 215618 bytes
 fluxer_app/src/media/images/shop/sets/sakura-1200.webp                                                                       |   Bin 0 -> 94028 bytes
 fluxer_app/src/media/images/shop/sets/sakura.webp                                                                            |   Bin 0 -> 250432 bytes
 fluxer_app/src/media/images/shop/sets/sonbahar-1200.webp                                                                     |   Bin 0 -> 89756 bytes
 fluxer_app/src/media/images/shop/sets/sonbahar.webp                                                                          |   Bin 0 -> 244162 bytes
 fluxer_app/src/media/sounds/table-game/SOURCES.txt                                                                           |    34 +
 fluxer_app/src/media/sounds/table-game/dama-al.mp3                                                                           |   Bin 0 -> 2550 bytes
 fluxer_app/src/media/sounds/table-game/dama-hamle.mp3                                                                        |   Bin 0 -> 4222 bytes
 fluxer_app/src/media/sounds/table-game/okey-bitir.mp3                                                                        |   Bin 0 -> 5894 bytes
 fluxer_app/src/media/sounds/table-game/okey-karistir.mp3                                                                     |   Bin 0 -> 28464 bytes
 fluxer_app/src/media/sounds/table-game/okey-per-ac.mp3                                                                       |   Bin 0 -> 9656 bytes
 fluxer_app/src/media/sounds/table-game/okey-tas-al.mp3                                                                       |   Bin 0 -> 8820 bytes
 fluxer_app/src/media/sounds/table-game/okey-tas-at.mp3                                                                       |   Bin 0 -> 2550 bytes
 fluxer_app/src/media/sounds/table-game/okey-tas-cek.mp3                                                                      |   Bin 0 -> 7148 bytes
 fluxer_app/src/media/sounds/table-game/okey-tas-surukle.mp3                                                                  |   Bin 0 -> 7984 bytes
 fluxer_app/src/media/sounds/table-game/okey-tas-yerlestir.mp3                                                                |   Bin 0 -> 5058 bytes
 fluxer_app/src/media/sounds/table-game/oyun-bitti.mp3                                                                        |   Bin 0 -> 17179 bytes
 fluxer_app/src/media/sounds/table-game/oyun-kazandin.mp3                                                                     |   Bin 0 -> 21358 bytes
 fluxer_app/src/media/sounds/table-game/satranc-al.mp3                                                                        |   Bin 0 -> 3386 bytes
 fluxer_app/src/media/sounds/table-game/satranc-hamle.mp3                                                                     |   Bin 0 -> 4222 bytes
 fluxer_app/src/media/sounds/table-game/satranc-sah.mp3                                                                       |   Bin 0 -> 5894 bytes
 fluxer_app/src/media/sounds/table-game/sira-sende.mp3                                                                        |   Bin 0 -> 5894 bytes
 fluxer_app/src/media/sounds/table-game/sure-azaldi.mp3                                                                       |   Bin 0 -> 6730 bytes
 fluxer_app/src/media/sounds/table-game/tavla-kir.mp3                                                                         |   Bin 0 -> 3804 bytes
 fluxer_app/src/media/sounds/table-game/tavla-pul.mp3                                                                         |   Bin 0 -> 2968 bytes
 fluxer_app/src/media/sounds/table-game/tavla-topla.mp3                                                                       |   Bin 0 -> 4640 bytes
 fluxer_app/src/media/sounds/table-game/tavla-zar.mp3                                                                         |   Bin 0 -> 12999 bytes
 fluxer_app/src/types/electron.d.ts                                                                                           |    13 +
 fluxer_app/src/types/hls-light.d.ts                                                                                          |     7 +
 fluxer_app_proxy/Dockerfile                                                                                                  |     2 +
 fluxer_app_proxy/src/config.rs                                                                                               |    71 +-
 fluxer_app_proxy/src/csp.rs                                                                                                  |    56 +-
 fluxer_app_proxy/src/routes/spa_index.rs                                                                                     |    62 +-
 fluxer_common/src/testdata/partial_user_cosmetic_vectors.json                                                                |   218 +
 fluxer_common/src/testdata/premium_badge_flag_vectors.json                                                                   |    72 +
 fluxer_common/src/user_flags.rs                                                                                              |   120 +-
 fluxer_desktop/build_resources/appx/Square150x150Logo.png                                                                    |   Bin 0 -> 7626 bytes
 fluxer_desktop/build_resources/appx/Square44x44Logo.png                                                                      |   Bin 0 -> 1592 bytes
 fluxer_desktop/build_resources/appx/StoreLogo.png                                                                            |   Bin 0 -> 1870 bytes
 fluxer_desktop/build_resources/appx/Wide310x150Logo.png                                                                      |   Bin 0 -> 6825 bytes
 fluxer_desktop/build_resources/icons-canary/1024x1024.png                                                                    |   Bin 46234 -> 101457 bytes
 fluxer_desktop/build_resources/icons-canary/128x128.png                                                                      |   Bin 4777 -> 6098 bytes
 fluxer_desktop/build_resources/icons-canary/128x128@2x.png                                                                   |   Bin 3837 -> 15788 bytes
 fluxer_desktop/build_resources/icons-canary/16x16.png                                                                        |   Bin 557 -> 568 bytes
 fluxer_desktop/build_resources/icons-canary/24x24.png                                                                        |   Bin 865 -> 847 bytes
 fluxer_desktop/build_resources/icons-canary/256x256.png                                                                      |   Bin 10075 -> 15788 bytes
 fluxer_desktop/build_resources/icons-canary/32x32.png                                                                        |   Bin 1175 -> 1127 bytes
 fluxer_desktop/build_resources/icons-canary/48x48.png                                                                        |   Bin 1774 -> 1834 bytes
 fluxer_desktop/build_resources/icons-canary/512x512.png                                                                      |   Bin 21334 -> 42831 bytes
 fluxer_desktop/build_resources/icons-canary/64x64.png                                                                        |   Bin 2348 -> 2560 bytes
 fluxer_desktop/build_resources/icons-canary/AppIcon.icon/Assets/Vector.svg                                                   |     6 +-
 fluxer_desktop/build_resources/icons-canary/AppIcon.icon/icon.json                                                           |     6 +-
 fluxer_desktop/build_resources/icons-canary/FluxerTrayTemplate.png                                                           |   Bin 900 -> 308 bytes
 fluxer_desktop/build_resources/icons-canary/FluxerTrayTemplate@2x.png                                                        |   Bin 1270 -> 625 bytes
 fluxer_desktop/build_resources/icons-canary/Square107x107Logo.png                                                            |   Bin 1551 -> 4771 bytes
 fluxer_desktop/build_resources/icons-canary/Square142x142Logo.png                                                            |   Bin 2071 -> 7004 bytes
 fluxer_desktop/build_resources/icons-canary/Square150x150Logo.png                                                            |   Bin 2208 -> 7626 bytes
 fluxer_desktop/build_resources/icons-canary/Square284x284Logo.png                                                            |   Bin 4246 -> 18676 bytes
 fluxer_desktop/build_resources/icons-canary/Square30x30Logo.png                                                              |   Bin 521 -> 1073 bytes
 fluxer_desktop/build_resources/icons-canary/Square310x310Logo.png                                                            |   Bin 4575 -> 21141 bytes
 fluxer_desktop/build_resources/icons-canary/Square44x44Logo.png                                                              |   Bin 701 -> 1592 bytes
 fluxer_desktop/build_resources/icons-canary/Square71x71Logo.png                                                              |   Bin 1059 -> 2886 bytes
 fluxer_desktop/build_resources/icons-canary/Square89x89Logo.png                                                              |   Bin 883 -> 3720 bytes
 fluxer_desktop/build_resources/icons-canary/StoreLogo.png                                                                    |   Bin 805 -> 1870 bytes
 fluxer_desktop/build_resources/icons-canary/_compiled/AppIcon.icns                                                           |   Bin 46926 -> 232831 bytes
 fluxer_desktop/build_resources/icons-canary/_compiled/Assets.car                                                             |   Bin 1611128 -> 0 bytes
 fluxer_desktop/build_resources/icons-canary/icon.ico                                                                         |   Bin 112200 -> 29011 bytes
 fluxer_desktop/build_resources/icons-canary/icon.png                                                                         |   Bin 7787 -> 42831 bytes
 fluxer_desktop/build_resources/icons-development/1024x1024.png                                                               |   Bin 1639832 -> 101457 bytes
 fluxer_desktop/build_resources/icons-development/128x128.png                                                                 |   Bin 55120 -> 6098 bytes
 fluxer_desktop/build_resources/icons-development/128x128@2x.png                                                              |   Bin 162759 -> 15788 bytes
 fluxer_desktop/build_resources/icons-development/16x16.png                                                                   |   Bin 910 -> 568 bytes
 fluxer_desktop/build_resources/icons-development/24x24.png                                                                   |   Bin 4012 -> 847 bytes
 fluxer_desktop/build_resources/icons-development/256x256.png                                                                 |   Bin 162759 -> 15788 bytes
 fluxer_desktop/build_resources/icons-development/32x32.png                                                                   |   Bin 6257 -> 1127 bytes
 fluxer_desktop/build_resources/icons-development/48x48.png                                                                   |   Bin 12033 -> 1834 bytes
 fluxer_desktop/build_resources/icons-development/512x512.png                                                                 |   Bin 513440 -> 42831 bytes
 fluxer_desktop/build_resources/icons-development/64x64.png                                                                   |   Bin 18573 -> 2560 bytes
 fluxer_desktop/build_resources/icons-development/AppIcon.icon/Assets/Vector.svg                                              |     5 +-
 fluxer_desktop/build_resources/icons-development/AppIcon.icon/icon.json                                                      |     7 +-
 fluxer_desktop/build_resources/icons-development/FluxerTrayTemplate.png                                                      |   Bin 900 -> 308 bytes
 fluxer_desktop/build_resources/icons-development/FluxerTrayTemplate@2x.png                                                   |   Bin 1270 -> 625 bytes
 fluxer_desktop/build_resources/icons-development/_compiled/AppIcon.icns                                                      |   Bin 3076325 -> 232831 bytes
 fluxer_desktop/build_resources/icons-development/_compiled/Assets.car                                                        |   Bin 1814936 -> 0 bytes
 fluxer_desktop/build_resources/icons-development/icon.ico                                                                    |   Bin 113152 -> 29011 bytes
 fluxer_desktop/build_resources/icons-development/icon.png                                                                    |   Bin 1639832 -> 42831 bytes
 fluxer_desktop/build_resources/icons-stable/1024x1024.png                                                                    |   Bin 54528 -> 101457 bytes
 fluxer_desktop/build_resources/icons-stable/128x128.png                                                                      |   Bin 5805 -> 6098 bytes
 fluxer_desktop/build_resources/icons-stable/128x128@2x.png                                                                   |   Bin 4423 -> 15788 bytes
 fluxer_desktop/build_resources/icons-stable/16x16.png                                                                        |   Bin 676 -> 568 bytes
 fluxer_desktop/build_resources/icons-stable/24x24.png                                                                        |   Bin 1050 -> 847 bytes
 fluxer_desktop/build_resources/icons-stable/256x256.png                                                                      |   Bin 12144 -> 15788 bytes
 fluxer_desktop/build_resources/icons-stable/32x32.png                                                                        |   Bin 1446 -> 1127 bytes
 fluxer_desktop/build_resources/icons-stable/48x48.png                                                                        |   Bin 2153 -> 1834 bytes
 fluxer_desktop/build_resources/icons-stable/512x512.png                                                                      |   Bin 25457 -> 42831 bytes
 fluxer_desktop/build_resources/icons-stable/64x64.png                                                                        |   Bin 2869 -> 2560 bytes
 fluxer_desktop/build_resources/icons-stable/AppIcon.icon/Assets/Vector.svg                                                   |     6 +-
 fluxer_desktop/build_resources/icons-stable/AppIcon.icon/icon.json                                                           |     6 +-
 fluxer_desktop/build_resources/icons-stable/FluxerTrayTemplate.png                                                           |   Bin 900 -> 308 bytes
 fluxer_desktop/build_resources/icons-stable/FluxerTrayTemplate@2x.png                                                        |   Bin 1270 -> 625 bytes
 fluxer_desktop/build_resources/icons-stable/Square107x107Logo.png                                                            |   Bin 1766 -> 4771 bytes
 fluxer_desktop/build_resources/icons-stable/Square142x142Logo.png                                                            |   Bin 2339 -> 7004 bytes
 fluxer_desktop/build_resources/icons-stable/Square150x150Logo.png                                                            |   Bin 2475 -> 7626 bytes
 fluxer_desktop/build_resources/icons-stable/Square284x284Logo.png                                                            |   Bin 4793 -> 18676 bytes
 fluxer_desktop/build_resources/icons-stable/Square30x30Logo.png                                                              |   Bin 624 -> 1073 bytes
 fluxer_desktop/build_resources/icons-stable/Square310x310Logo.png                                                            |   Bin 5228 -> 21141 bytes
 fluxer_desktop/build_resources/icons-stable/Square44x44Logo.png                                                              |   Bin 807 -> 1592 bytes
 fluxer_desktop/build_resources/icons-stable/Square71x71Logo.png                                                              |   Bin 1224 -> 2886 bytes
 fluxer_desktop/build_resources/icons-stable/Square89x89Logo.png                                                              |   Bin 1054 -> 3720 bytes
 fluxer_desktop/build_resources/icons-stable/StoreLogo.png                                                                    |   Bin 930 -> 1870 bytes
 fluxer_desktop/build_resources/icons-stable/_compiled/AppIcon.icns                                                           |   Bin 50274 -> 232831 bytes
 fluxer_desktop/build_resources/icons-stable/_compiled/Assets.car                                                             |   Bin 1806408 -> 0 bytes
 fluxer_desktop/build_resources/icons-stable/icon.ico                                                                         |   Bin 114264 -> 29011 bytes
 fluxer_desktop/build_resources/icons-stable/icon.png                                                                         |   Bin 8796 -> 42831 bytes
 fluxer_desktop/electron-builder.config.cjs                                                                                   |   266 +-
 fluxer_desktop/native/rust/src/system_hunspell/dictionaries.rs                                                               |    50 +-
 fluxer_desktop/native/win-game-capture/Cargo.lock                                                                            |     1 +
 fluxer_desktop/native/win-game-capture/Cargo.toml                                                                            |     2 +
 fluxer_desktop/native/win-game-capture/index.d.ts                                                                            |     1 +
 fluxer_desktop/native/win-game-capture/index.js                                                                              |     6 +
 fluxer_desktop/native/win-game-capture/index.test.mjs                                                                        |    18 +
 fluxer_desktop/native/win-game-capture/src/borderless.rs                                                                     |    95 +
 fluxer_desktop/native/win-game-capture/src/lib.rs                                                                            |     3 +
 fluxer_desktop/native/win-game-capture/src/wgc_capture.rs                                                                    |     4 +
 fluxer_desktop/native/win-shell/Cargo.lock                                                                                   |     1 +
 fluxer_desktop/native/win-shell/Cargo.toml                                                                                   |     6 +
 fluxer_desktop/native/win-shell/index.d.ts                                                                                   |    29 +
 fluxer_desktop/native/win-shell/index.js                                                                                     |     5 +
 fluxer_desktop/native/win-shell/src/lib.rs                                                                                   |   121 +-
 fluxer_desktop/native/win-shell/src/processes.rs                                                                             |   203 +
 fluxer_desktop/native/win-shell/src/taskbar.rs                                                                               |   215 +
 fluxer_desktop/package.json                                                                                                  |     3 +-
 fluxer_desktop/packaging/linux/app.fluxer.Fluxer.sh                                                                          |     2 +-
 fluxer_desktop/packaging/linux/app.fluxer.FluxerCanary.sh                                                                    |     2 +-
 fluxer_desktop/packaging/windows/micup-bridge/bridge-latest-yml.test.mjs                                                     |    70 +
 fluxer_desktop/packaging/windows/micup-bridge/bridge.nsi                                                                     |   222 +
 fluxer_desktop/packaging/windows/micup-bridge/build-bridge.ps1                                                               |    43 +
 fluxer_desktop/packaging/windows/micup-bridge/sandbox/bridge-e2e.wsb                                                         |    16 +
 fluxer_desktop/packaging/windows/micup-bridge/sandbox/run-e2e.ps1                                                            |   178 +
 fluxer_desktop/packaging/windows/store/extensions.xml                                                                        |    13 +
 fluxer_desktop/packaging/windows/store/manifest.test.mjs                                                                     |    99 +
 fluxer_desktop/packaging/windows/store/manifest.xml                                                                          |    49 +
 fluxer_desktop/packaging/windows/store/paketle.ps1                                                                           |    71 +
 fluxer_desktop/packaging/windows/store/sandbox-e2e.ps1                                                                       |    56 +
 fluxer_desktop/packaging/windows/store/sandbox-e2e.wsb                                                                       |    14 +
 fluxer_desktop/scripts/build.mjs                                                                                             |     1 +
 fluxer_desktop/scripts/generate-brand-icons.py                                                                               |    90 +
 fluxer_desktop/src/common/ChannelEndpoints.test.mjs                                                                          |    14 +-
 fluxer_desktop/src/common/ChannelIsolation.test.mjs                                                                          |    14 +-
 fluxer_desktop/src/common/Constants.ts                                                                                       |    20 +-
 fluxer_desktop/src/common/DesktopConfig.ts                                                                                   |    30 +
 fluxer_desktop/src/common/DesktopIdentity.ts                                                                                 |    57 +-
 fluxer_desktop/src/common/GameActivityTypes.ts                                                                               |    93 +
 fluxer_desktop/src/common/Types.ts                                                                                           |    22 +-
 fluxer_desktop/src/common/UserDataPath.ts                                                                                    |     6 +-
 fluxer_desktop/src/main/AppImageUpdate.test.mjs                                                                              |    10 +-
 fluxer_desktop/src/main/Autostart.test.mjs                                                                                   |    29 +-
 fluxer_desktop/src/main/Autostart.ts                                                                                         |    89 +-
 fluxer_desktop/src/main/Bootstrap.ts                                                                                         |    37 +-
 fluxer_desktop/src/main/BootstrapEntry.test.mjs                                                                              |     2 +-
 fluxer_desktop/src/main/BootstrapLocale.test.mjs                                                                             |   110 +
 fluxer_desktop/src/main/DeepLinks.ts                                                                                         |    34 +-
 fluxer_desktop/src/main/DesktopAccountStoreTelemetry.test.mjs                                                                |     2 +-
 fluxer_desktop/src/main/DesktopBrandAssets.test.mjs                                                                          |   196 +
 fluxer_desktop/src/main/DesktopRuntimeDiscovery.test.mjs                                                                     |    25 +-
 fluxer_desktop/src/main/DesktopRuntimeDiscovery.ts                                                                           |     4 +-
 fluxer_desktop/src/main/DesktopRuntimeSecurity.test.mjs                                                                      |     6 +-
 fluxer_desktop/src/main/DisplayMedia.ts                                                                                      |     2 +
 fluxer_desktop/src/main/GameActivityContract.test.mjs                                                                        |   671 +
 fluxer_desktop/src/main/GameActivityDetection.test.mjs                                                                       |   633 +
 fluxer_desktop/src/main/GameActivityDetection.ts                                                                             |   326 +
 fluxer_desktop/src/main/GameActivityIpc.test.mjs                                                                             |   427 +
 fluxer_desktop/src/main/GameActivityIpc.ts                                                                                   |   314 +
 fluxer_desktop/src/main/GameActivityNativeBundle.test.mjs                                                                    |    51 +
 fluxer_desktop/src/main/GameOverlay.test.mjs                                                                                 |   212 +
 fluxer_desktop/src/main/GameOverlay.ts                                                                                       |   129 +
 fluxer_desktop/src/main/GameOverlayLayout.test.mjs                                                                           |   147 +
 fluxer_desktop/src/main/GameOverlayLayout.ts                                                                                 |    63 +
 fluxer_desktop/src/main/IpcHandlers.ts                                                                                       |     7 +
 fluxer_desktop/src/main/LegacyAppOrigin.test.mjs                                                                             |    33 +-
 fluxer_desktop/src/main/LinuxDesktopEntry.test.mjs                                                                           |   139 +-
 fluxer_desktop/src/main/LinuxDesktopEntry.ts                                                                                 |     1 +
 fluxer_desktop/src/main/LinuxSession.test.mjs                                                                                |     2 +-
 fluxer_desktop/src/main/LocalAppCSP.ts                                                                                       |    37 +-
 fluxer_desktop/src/main/LocalAppCsp.test.mjs                                                                                 |    16 +-
 fluxer_desktop/src/main/LocalAppFileResolver.test.mjs                                                                        |    16 +-
 fluxer_desktop/src/main/MainI18n.ts                                                                                          |     6 +-
 fluxer_desktop/src/main/Menu.ts                                                                                              |     8 +-
 fluxer_desktop/src/main/MicupIdentity.test.mjs                                                                               |   261 +
 fluxer_desktop/src/main/ModuleStore.test.mjs                                                                                 |     4 +-
 fluxer_desktop/src/main/NativeModulePreflight.test.mjs                                                                       |     4 +
 fluxer_desktop/src/main/NativeModulePreflight.ts                                                                             |    49 +-
 fluxer_desktop/src/main/NativeScreenCapture.test.mjs                                                                         |    47 +-
 fluxer_desktop/src/main/NativeScreenCapture.ts                                                                               |     8 +-
 fluxer_desktop/src/main/NotificationState.ts                                                                                 |    33 +-
 fluxer_desktop/src/main/NotificationsIpc.test.mjs                                                                            |   147 +
 fluxer_desktop/src/main/NotificationsIpc.ts                                                                                  |    44 +-
 fluxer_desktop/src/main/OpenExternal.test.mjs                                                                                |     8 +
 fluxer_desktop/src/main/OpenExternal.ts                                                                                      |     2 +
 fluxer_desktop/src/main/Passkeys.test.mjs                                                                                    |     2 +-
 fluxer_desktop/src/main/PreloadStartupZoom.test.mjs                                                                          |   151 +
 fluxer_desktop/src/main/ShellDownloadFormats.ts                                                                              |     4 +-
 fluxer_desktop/src/main/ShellUpdateCapability.test.mjs                                                                       |    55 +-
 fluxer_desktop/src/main/ShellUpdateCapability.ts                                                                             |     4 +-
 fluxer_desktop/src/main/ShellUpdateSplash.ts                                                                                 |    18 +-
 fluxer_desktop/src/main/SplashBundleOwnership.test.mjs                                                                       |     2 +-
 fluxer_desktop/src/main/SplashWindow.test.mjs                                                                                |    20 +-
 fluxer_desktop/src/main/TaskbarPin.test.mjs                                                                                  |   121 +
 fluxer_desktop/src/main/TaskbarPin.ts                                                                                        |    39 +
 fluxer_desktop/src/main/ThemeLinkedFileWatch.test.mjs                                                                        |     2 +-
 fluxer_desktop/src/main/Updater.test.mjs                                                                                     |     8 +-
 fluxer_desktop/src/main/Updater.ts                                                                                           |     2 +-
 fluxer_desktop/src/main/UpdaterDownloads.test.mjs                                                                            |    84 +-
 fluxer_desktop/src/main/WinShell.test.mjs                                                                                    |   575 +
 fluxer_desktop/src/main/WinShell.ts                                                                                          |    51 +
 fluxer_desktop/src/main/WinShellTestHarness.mjs                                                                              |    47 +
 fluxer_desktop/src/main/Window.ts                                                                                            |    17 +-
 fluxer_desktop/src/main/WindowTrustedOrigin.test.mjs                                                                         |     5 +-
 fluxer_desktop/src/main/WindowsCaptureBorder.test.mjs                                                                        |   100 +
 fluxer_desktop/src/main/WindowsCaptureBorder.ts                                                                              |    35 +
 fluxer_desktop/src/main/WindowsPlatformGates.test.mjs                                                                        |    92 +
 fluxer_desktop/src/main/WindowsShortcuts.test.mjs                                                                            |    10 +
 fluxer_desktop/src/main/WindowsShortcuts.ts                                                                                  |    26 +-
 fluxer_desktop/src/main/WindowsStore.test.mjs                                                                                |   527 +
 fluxer_desktop/src/main/index.ts                                                                                             |    10 +-
 fluxer_desktop/src/preload/index.ts                                                                                          |   133 +-
 fluxer_desktop/src/preload/splash.cjs                                                                                        |    16 +-
 fluxer_desktop/tsconfig.json                                                                                                 |     9 +-
 fluxer_docs/Dockerfile                                                                                                       |    26 +
 fluxer_docs/README.md                                                                                                        |    40 +
 fluxer_docs/astro.config.ts                                                                                                  |    72 +-
 fluxer_docs/micup.env                                                                                                        |     7 +
 fluxer_docs/scripts/DocsBranding.test.ts                                                                                     |   314 +
 fluxer_docs/scripts/VerifyDocsCoverage.ts                                                                                    |     2 +-
 fluxer_docs/scripts/VerifyDocsSidebar.ts                                                                                     |     2 +-
 fluxer_docs/scripts/VerifyDocsStyle.ts                                                                                       |     4 +-
 fluxer_docs/scripts/VerifyMicupBuild.ts                                                                                      |   141 +
 fluxer_docs/src/branding/DocsBranding.ts                                                                                     |   302 +
 fluxer_docs/src/content.config.ts                                                                                            |    19 +-
 fluxer_docs/src/content/docs/admin-api/badges.mdx                                                                            |   291 +
 fluxer_docs/src/content/docs/admin-api/blocklists.mdx                                                                        |    66 +
 fluxer_docs/src/content/docs/admin-api/cosmetics.mdx                                                                         |   237 +
 fluxer_docs/src/content/docs/admin-api/feed.mdx                                                                              |   136 +
 fluxer_docs/src/content/docs/admin-api/gift-codes.mdx                                                                        |    89 +-
 fluxer_docs/src/content/docs/admin-api/guilds.mdx                                                                            |     5 +-
 fluxer_docs/src/content/docs/admin-api/index.mdx                                                                             |    13 +
 fluxer_docs/src/content/docs/admin-api/instance.mdx                                                                          |   265 +-
 fluxer_docs/src/content/docs/admin-api/referral.mdx                                                                          |   380 +
 fluxer_docs/src/content/docs/admin-api/reports.mdx                                                                           |     4 +
 fluxer_docs/src/content/docs/admin-api/shop.mdx                                                                              |   515 +
 fluxer_docs/src/content/docs/admin-api/users.mdx                                                                             |   333 +
 fluxer_docs/src/content/docs/bots/hizli-baslangic.mdx                                                                        |    70 +
 fluxer_docs/src/content/docs/gateway/events.md                                                                               |    75 +
 fluxer_docs/src/content/docs/gateway/limits-and-rate-limits.md                                                               |     6 +-
 fluxer_docs/src/content/docs/gateway/opcodes-and-close-codes.md                                                              |     7 +-
 fluxer_docs/src/content/docs/gateway/overview.md                                                                             |     5 +
 fluxer_docs/src/content/docs/http-api/authentication.mdx                                                                     |     8 +-
 fluxer_docs/src/content/docs/http-api/channels.mdx                                                                           |     6 +-
 fluxer_docs/src/content/docs/http-api/cosmetics.mdx                                                                          |   227 +
 fluxer_docs/src/content/docs/http-api/deployment-availability.md                                                             |     4 +
 fluxer_docs/src/content/docs/http-api/entrance-sounds.mdx                                                                    |    12 +-
 fluxer_docs/src/content/docs/http-api/errors.md                                                                              |   214 +-
 fluxer_docs/src/content/docs/http-api/experiments.mdx                                                                        |    17 +-
 fluxer_docs/src/content/docs/http-api/feed.mdx                                                                               |  1052 ++
 fluxer_docs/src/content/docs/http-api/gifts.mdx                                                                              |    23 +-
 fluxer_docs/src/content/docs/http-api/guild-channels.mdx                                                                     |     5 +-
 fluxer_docs/src/content/docs/http-api/guild-micupbot.mdx                                                                     |   573 +
 fluxer_docs/src/content/docs/http-api/guild-roster-events.mdx                                                                |   290 +
 fluxer_docs/src/content/docs/http-api/guilds.mdx                                                                             |   210 +-
 fluxer_docs/src/content/docs/http-api/instance.mdx                                                                           |    52 +-
 fluxer_docs/src/content/docs/http-api/messages.mdx                                                                           |   167 +
 fluxer_docs/src/content/docs/http-api/oauth2.mdx                                                                             |     1 +
 fluxer_docs/src/content/docs/http-api/premium.mdx                                                                            |    97 +-
 fluxer_docs/src/content/docs/http-api/referral.mdx                                                                           |   127 +
 fluxer_docs/src/content/docs/http-api/reports.mdx                                                                            |    99 +-
 fluxer_docs/src/content/docs/http-api/shop.mdx                                                                               |   479 +
 fluxer_docs/src/content/docs/http-api/table-games.mdx                                                                        |   777 +
 fluxer_docs/src/content/docs/http-api/users.mdx                                                                              |    77 +-
 fluxer_docs/src/content/docs/http-api/users/current-user.mdx                                                                 |    47 +
 fluxer_docs/src/content/docs/http-api/users/follows.mdx                                                                      |   196 +
 fluxer_docs/src/content/docs/http-api/users/settings.mdx                                                                     |    17 +-
 fluxer_docs/src/content/docs/http-api/voice-seats.mdx                                                                        |   139 +
 fluxer_docs/src/content/docs/media-proxy/transformations.md                                                                  |     6 +-
 fluxer_docs/src/content/docs/operator/configuration.mdx                                                                      |   170 +-
 fluxer_docs/src/content/docs/operator/reverse-proxy.mdx                                                                      |     2 +-
 fluxer_docs/src/content/docs/operator/sign-in.mdx                                                                            |     4 +
 fluxer_docs/src/content/docs/topics/captcha.md                                                                               |     1 +
 fluxer_docs/src/content/docs/topics/rate-limits.md                                                                           |     5 +-
 fluxer_docs/src/content/docs/voice/index.md                                                                                  |     2 +-
 fluxer_docs/src/pages/micup-docs-icon.svg.ts                                                                                 |    12 +
 fluxer_docs/src/server/DocsConfig.ts                                                                                         |    14 +-
 fluxer_gateway/src/gateway/fluxer_gateway_app.erl                                                                            |     1 +
 fluxer_gateway/src/gateway/fluxer_gateway_config.erl                                                                         |    49 +
 fluxer_gateway/src/gateway/gateway_cluster_discovery.erl                                                                     |     3 +
 fluxer_gateway/src/gateway/gateway_cluster_membership.erl                                                                    |   192 +-
 fluxer_gateway/src/gateway/gateway_compress.erl                                                                              |   110 +-
 fluxer_gateway/src/gateway/gateway_connection_metrics.erl                                                                    |   266 +
 fluxer_gateway/src/gateway/gateway_dispatch_relay.erl                                                                        |     5 +
 fluxer_gateway/src/gateway/gateway_dispatch_relay_batch.erl                                                                  |    37 +
 fluxer_gateway/src/gateway/gateway_errors.erl                                                                                |    33 +-
 fluxer_gateway/src/gateway/gateway_handler.erl                                                                               |    70 +-
 fluxer_gateway/src/gateway/gateway_handler_dispatch.erl                                                                      |    80 +-
 fluxer_gateway/src/gateway/gateway_handler_identify.erl                                                                      |     9 +-
 fluxer_gateway/src/gateway/gateway_handler_resume.erl                                                                        |     1 +
 fluxer_gateway/src/gateway/gateway_ip_connections.erl                                                                        |   761 +-
 fluxer_gateway/src/gateway/gateway_metrics_access.erl                                                                        |   127 +
 fluxer_gateway/src/gateway/gateway_nats_pool.erl                                                                             |   188 +-
 fluxer_gateway/src/gateway/gateway_nats_pool_conn.erl                                                                        |    84 +-
 fluxer_gateway/src/gateway/gateway_nats_rpc.erl                                                                              |   194 +-
 fluxer_gateway/src/gateway/gateway_nats_rpc_handler.erl                                                                      |   107 +-
 fluxer_gateway/src/gateway/gateway_rollout_config.erl                                                                        |   287 +-
 fluxer_gateway/src/gateway/gateway_rollout_config_validate.erl                                                               |    17 +-
 fluxer_gateway/src/gateway/gateway_rpc_guild_voice.erl                                                                       |     3 +-
 fluxer_gateway/src/gateway/gateway_rpc_presence.erl                                                                          |   137 +-
 fluxer_gateway/src/gateway/gateway_rpc_voice.erl                                                                             |     3 +-
 fluxer_gateway/src/gateway/health_handler.erl                                                                                |    36 +-
 fluxer_gateway/src/gateway/metrics_handler.erl                                                                               |   205 +-
 fluxer_gateway/src/guild/guild_member_list_common.erl                                                                        |     2 +-
 fluxer_gateway/src/guild/guild_presence.erl                                                                                  |     4 +-
 fluxer_gateway/src/guild/guild_user_data.erl                                                                                 |    41 +-
 fluxer_gateway/src/guild/voice/dm_voice_token.erl                                                                            |    11 +-
 fluxer_gateway/src/guild/voice/guild_voice_connection_join.erl                                                               |    29 +-
 fluxer_gateway/src/guild/voice/guild_voice_connection_move.erl                                                               |    29 +-
 fluxer_gateway/src/guild/voice/guild_voice_connection_token.erl                                                              |     5 +-
 fluxer_gateway/src/guild/voice/guild_voice_disconnect_channel.erl                                                            |    51 +-
 fluxer_gateway/src/guild/voice/guild_voice_disconnect_user.erl                                                               |     7 +-
 fluxer_gateway/src/presence/presence.erl                                                                                     |   114 +-
 fluxer_gateway/src/presence/presence_broadcast.erl                                                                           |     4 +-
 fluxer_gateway/src/presence/presence_cache_shard.erl                                                                         |    30 +-
 fluxer_gateway/src/presence/presence_connect.erl                                                                             |    30 +-
 fluxer_gateway/src/presence/presence_game_activity.erl                                                                       |   610 +
 fluxer_gateway/src/presence/presence_game_activity_policy.erl                                                                |   531 +
 fluxer_gateway/src/presence/presence_manager.erl                                                                             |     9 +
 fluxer_gateway/src/presence/presence_manager_game_activity.erl                                                               |   174 +
 fluxer_gateway/src/presence/presence_manager_shard.erl                                                                       |   251 +-
 fluxer_gateway/src/presence/presence_session.erl                                                                             |    11 +-
 fluxer_gateway/src/presence/presence_update.erl                                                                              |     7 +-
 fluxer_gateway/src/session/session.erl                                                                                       |    65 +-
 fluxer_gateway/src/session/session_connection_presence.erl                                                                   |    10 +-
 fluxer_gateway/src/session/session_dispatch.erl                                                                              |    27 +-
 fluxer_gateway/src/session/session_dispatch_presence.erl                                                                     |    19 +-
 fluxer_gateway/src/session/session_game_activity.erl                                                                         |   671 +
 fluxer_gateway/src/session/session_game_activity_rollout.erl                                                                 |    54 +
 fluxer_gateway/src/session/session_init.erl                                                                                  |     2 +
 fluxer_gateway/src/session/session_lifecycle.erl                                                                             |    16 +-
 fluxer_gateway/src/session/session_manager.erl                                                                               |     1 +
 fluxer_gateway/src/session/session_manager_shard.erl                                                                         |   105 +-
 fluxer_gateway/src/session/session_manager_shard_drain.erl                                                                   |    34 +-
 fluxer_gateway/src/session/session_manager_shard_lookup.erl                                                                  |    74 +-
 fluxer_gateway/src/session/session_manager_shard_rollout.erl                                                                 |    88 +
 fluxer_gateway/src/session/session_ready_dispatch.erl                                                                        |    73 +-
 fluxer_gateway/src/session/session_state_transfer.erl                                                                        |   123 +-
 fluxer_gateway/src/utils/event_atoms.erl                                                                                     |    15 +
 fluxer_gateway/src/utils/user_utils.erl                                                                                      |   159 +-
 fluxer_gateway/src/utils/utils.erl                                                                                           |    40 +-
 fluxer_gateway/test/fluxer_gateway_app_tests.erl                                                                             |    26 +
 fluxer_gateway/test/fluxer_gateway_config_tests.erl                                                                          |   161 +-
 fluxer_gateway/test/game_activity_disabled_session_tests.erl                                                                 |   178 +
 fluxer_gateway/test/game_activity_input_tests.erl                                                                            |   450 +
 fluxer_gateway/test/game_activity_lease_tests.erl                                                                            |   117 +
 fluxer_gateway/test/game_activity_projection_tests.erl                                                                       |   756 +
 fluxer_gateway/test/game_activity_rate_limit_tests.erl                                                                       |    74 +
 fluxer_gateway/test/game_activity_recovery_tests.erl                                                                         |   515 +
 fluxer_gateway/test/game_activity_resume_contract_tests.erl                                                                  |   164 +
 fluxer_gateway/test/game_activity_retry_tests.erl                                                                            |   351 +
 fluxer_gateway/test/game_activity_revocation_tests.erl                                                                       |   826 ++
 fluxer_gateway/test/game_activity_rollout_contract_tests.erl                                                                 |   429 +
 fluxer_gateway/test/game_activity_rollout_tests.erl                                                                          |   268 +
 fluxer_gateway/test/gateway_cluster_membership_tests.erl                                                                     |   146 +
 fluxer_gateway/test/gateway_cluster_rpc_tests.erl                                                                            |  1138 ++
 fluxer_gateway/test/gateway_handler_tests.erl                                                                                |   288 +
 fluxer_gateway/test/gateway_resume_timings_tests.erl                                                                         |    71 +
 fluxer_gateway/test/gateway_rollout_config_tests.erl                                                                         |   378 +-
 fluxer_gateway/test/gateway_rpc_voice_tests.erl                                                                              |    38 +
 fluxer_gateway/test/guild_voice_move_tests.erl                                                                               |   196 +-
 fluxer_gateway/test/presence_connect_tests.erl                                                                               |    50 +
 fluxer_gateway/test/push_read_dm_tests.erl                                                                                   |    19 +-
 fluxer_gateway/test/session_manager_shard_drain_tests.erl                                                                    |    44 +
 fluxer_gateway/test/session_manager_shard_lookup_tests.erl                                                                   |   188 +
 fluxer_gateway/test/session_manager_shard_rollout_tests.erl                                                                  |   338 +
 fluxer_gateway/test/session_manager_shard_session_count_tests.erl                                                            |    86 +
 fluxer_gateway/test/username_identity_writer_tests.erl                                                                       |   206 +
 fluxer_gateway/test/username_private_session_tests.erl                                                                       |    58 +
 fluxer_gateway/test/username_voice_error_tests.erl                                                                           |    81 +
 fluxer_gifs/src/klipy.rs                                                                                                     |     2 +-
 fluxer_media_proxy/fuzz/Cargo.lock                                                                                           |     4 +-
 fluxer_media_proxy/src/constants.rs                                                                                          |     3 +-
 fluxer_media_proxy/src/media_limits.rs                                                                                       |     8 +
 fluxer_media_proxy/src/media_process/animated_transform.rs                                                                   |    14 +
 fluxer_media_proxy/src/media_process/mod.rs                                                                                  |     1 +
 fluxer_media_proxy/src/media_process/tests/animated_gif.rs                                                                   |   145 +-
 fluxer_media_proxy/src/media_process/transform.rs                                                                            |    19 +-
 fluxer_media_proxy/src/server/format_policy.rs                                                                               |    90 +-
 fluxer_media_proxy/src/server/routes/ops.rs                                                                                  |   148 +-
 fluxer_media_proxy/src/server/runtime.rs                                                                                     |    51 +-
 fluxer_media_proxy/src/server/stored/mod.rs                                                                                  |   110 +-
 fluxer_media_proxy/src/server/stored/tests.rs                                                                                |   109 +
 fluxer_media_proxy/src/server/transform/execution.rs                                                                         |    11 +-
 fluxer_media_proxy/src/test_fixtures/images.rs                                                                               |    98 +
 fluxer_media_proxy/src/test_fixtures/mod.rs                                                                                  |     8 +-
 fluxer_messages/benches/message_response.rs                                                                                  |     4 +
 fluxer_messages/src/shard_impl.rs                                                                                            |   299 +-
 fluxer_messages/src/types.rs                                                                                                 |   248 +
 fluxer_messages/src/udt.rs                                                                                                   |    85 +
 fluxer_nsfw/Dockerfile                                                                                                       |    73 +
 fluxer_nsfw/README.md                                                                                                        |    87 +
 fluxer_nsfw/VERSION                                                                                                          |     1 +
 fluxer_nsfw/export_onnx.py                                                                                                   |    88 +
 fluxer_nsfw/requirements-model.txt                                                                                           |    84 +
 fluxer_nsfw/requirements.txt                                                                                                 |    16 +
 fluxer_nsfw/server.py                                                                                                        |   312 +
 fluxer_nsfw/smoke.py                                                                                                         |   127 +
 fluxer_nsfw/test_model.py                                                                                                    |    71 +
 fluxer_nsfw/test_server.py                                                                                                   |   334 +
 fluxer_push/src/config.rs                                                                                                    |    25 +
 fluxer_push/src/payload.rs                                                                                                   |    15 +-
 fluxer_push/src/providers/web_push.rs                                                                                        |    27 +
 fluxer_push/src/server.rs                                                                                                    |    64 +-
 fluxer_static/Dockerfile                                                                                                     |   Bin 1672 -> 1880 bytes
 fluxer_static/avatars/0.png                                                                                                  |   Bin 9439 -> 29011 bytes
 fluxer_static/avatars/1.png                                                                                                  |   Bin 8922 -> 31622 bytes
 fluxer_static/avatars/2.png                                                                                                  |   Bin 9168 -> 33087 bytes
 fluxer_static/avatars/3.png                                                                                                  |   Bin 8349 -> 31519 bytes
 fluxer_static/avatars/4.png                                                                                                  |   Bin 8500 -> 30235 bytes
 fluxer_static/avatars/5.png                                                                                                  |   Bin 10091 -> 33421 bytes
 fluxer_static/marketing/branding/NOTICE.md                                                                                   |     5 +
 fluxer_static/marketing/branding/symbol-white.svg                                                                            |   Bin 2341 -> 7375 bytes
 fluxer_static/web/NOTICE.md                                                                                                  |    12 +-
 fluxer_static/web/android-chrome-192x192.png                                                                                 |   Bin 3431 -> 7673 bytes
 fluxer_static/web/android-chrome-512x512.png                                                                                 |   Bin 9439 -> 33405 bytes
 fluxer_static/web/apple-touch-icon.png                                                                                       |   Bin 3158 -> 6878 bytes
 fluxer_static/web/favicon-16x16.png                                                                                          |   Bin 625 -> 711 bytes
 fluxer_static/web/favicon-32x32.png                                                                                          |   Bin 1122 -> 1545 bytes
 fluxer_static/web/favicon.ico                                                                                                |   Bin 270622 -> 29478 bytes
 fluxer_static/web/icons/NOTICE.md                                                                                            |     7 +
 fluxer_static/web/icons/desktop/canary/icon.ico                                                                              |   Bin 0 -> 29011 bytes
 fluxer_static/web/icons/desktop/stable/icon.ico                                                                              |   Bin 0 -> 29011 bytes
 fluxer_static/web/mstile-150x150.png                                                                                         |   Bin 2599 -> 5298 bytes
 fluxer_static/web/og-image-default.png                                                                                       |   Bin 0 -> 35427 bytes
 fluxer_svc/src/config.rs                                                                                                     |    42 +
 fluxer_svc/src/scylla.rs                                                                                                     |    80 +-
 fluxer_svc/src/server.rs                                                                                                     |   161 +-
 fluxer_unfurl/src/shard_impl.rs                                                                                              |     2 +-
 fluxer_users/src/shard_impl.rs                                                                                               |   224 +-
 fluxer_users/src/types.rs                                                                                                    |   162 +-
 knip.json                                                                                                                    |    22 +-
 package.json                                                                                                                 |     9 +-
 packages/config/src/ConfigLoader.ts                                                                                          |   203 +-
 packages/config/src/MasterConfig.ts                                                                                          |    79 +-
 packages/config/src/__tests__/ConfigLoader.test.ts                                                                           |   371 +-
 packages/config/src/__tests__/EnvironmentOverrides.test.ts                                                                   |    31 +
 packages/config/src/__tests__/SelfHostingComposeEnvironment.test.ts                                                          |     9 +
 packages/config/src/config_loader/EnvironmentOverrides.ts                                                                    |    77 +
 packages/constants/src/AdminACLs.ts                                                                                          |     9 +
 packages/constants/src/ApiErrorCodes.ts                                                                                      |    46 +
 packages/constants/src/ApplicationCommandConstants.test.ts                                                                   |    49 +
 packages/constants/src/ApplicationCommandConstants.ts                                                                        |    45 +
 packages/constants/src/ApplicationCommandGatewayEvents.test.ts                                                               |    13 +
 packages/constants/src/AssetFormatPolicy.test.ts                                                                             |    20 +
 packages/constants/src/AssetFormatPolicy.ts                                                                                  |    23 +
 packages/constants/src/Core.ts                                                                                               |     2 +-
 packages/constants/src/GatewayConstants.ts                                                                                   |     6 +
 packages/constants/src/GuildBoostConstants.test.ts                                                                           |    14 +
 packages/constants/src/GuildBoostConstants.ts                                                                                |    17 +
 packages/constants/src/GuildConstants.ts                                                                                     |     4 +
 packages/constants/src/LimitConfigMetadata.ts                                                                                |   222 +
 packages/constants/src/MessageComponentConstants.ts                                                                          |    19 +
 packages/constants/src/RegionalMinimumAge.test.ts                                                                            |    53 +
 packages/constants/src/RegionalMinimumAge.ts                                                                                 |     1 +
 packages/constants/src/SchemaUsernameConstants.test.ts                                                                       |    38 +
 packages/constants/src/TableGameConstants.test.ts                                                                            |    95 +
 packages/constants/src/TableGameConstants.ts                                                                                 |    74 +
 packages/constants/src/UserConstants.test.ts                                                                                 |    34 +
 packages/constants/src/UserConstants.ts                                                                                      |    53 +-
 packages/constants/src/UserFlagsCompatibility.test.ts                                                                        |    21 +
 packages/constants/src/ValidationErrorCodes.ts                                                                               |     4 +
 packages/constants/src/VoiceRoomPartsManifest.ts                                                                             |     9 +
 packages/constants/src/VoiceRoomThemeManifest.ts                                                                             |   103 +
 packages/constants/src/VoiceRoomThemes.test.ts                                                                               |    97 +
 packages/constants/src/VoiceRoomThemes.ts                                                                                    |    57 +
 packages/errors/src/__tests__/AppErrorHandlerLogging.test.ts                                                                 |    39 +
 packages/errors/src/__tests__/ApplicationCommandErrors.test.ts                                                               |    51 +
 packages/errors/src/__tests__/GuildRosterErrors.test.ts                                                                      |    41 +
 packages/errors/src/__tests__/MicupBotErrors.test.ts                                                                         |    85 +
 packages/errors/src/domains/application_command/ApplicationCommandBotUnavailableError.ts                                     |    10 +
 packages/errors/src/domains/application_command/ApplicationCommandFeatureDisabledError.ts                                    |    10 +
 packages/errors/src/domains/application_command/ApplicationCommandStaleError.ts                                              |    10 +
 packages/errors/src/domains/application_command/ApplicationCommandVersionConflictError.ts                                    |    10 +
 packages/errors/src/domains/application_command/InteractionDeadlineExceededError.ts                                          |    10 +
 packages/errors/src/domains/application_command/InteractionNonceConflictError.ts                                             |    10 +
 packages/errors/src/domains/application_command/InteractionOutcomeUnknownError.ts                                            |    10 +
 packages/errors/src/domains/application_command/InteractionTokenConsumedError.ts                                             |    10 +
 packages/errors/src/domains/content/MaxFeedCommentsError.ts                                                                  |    16 +
 packages/errors/src/domains/content/UnknownFeedCommentError.ts                                                               |    10 +
 packages/errors/src/domains/content/UnknownFeedPostError.ts                                                                  |    10 +
 packages/errors/src/domains/core/ErrorHandlers.ts                                                                            |     5 +-
 packages/errors/src/domains/guild/MaxGuildRosterEventsError.ts                                                               |    16 +
 packages/errors/src/domains/guild/MaxMicupBotReactionRolePanelsError.ts                                                      |    16 +
 packages/errors/src/domains/guild/MicupBotNotInGuildError.ts                                                                 |    10 +
 packages/errors/src/domains/guild/MicupBotRoleNotAssignableError.ts                                                          |    15 +
 packages/errors/src/domains/guild/UnknownGuildRosterEventError.ts                                                            |    10 +
 packages/errors/src/domains/guild/UnknownMicupBotReactionRolePanelError.ts                                                   |    10 +
 packages/errors/src/domains/guild/UnknownMicupBotWarningError.ts                                                             |    10 +
 packages/errors/src/domains/moderation/IpBannedError.ts                                                                      |     2 +-
 packages/errors/src/domains/payment/CannotRedeemPlutoniumWithVisionaryError.ts                                               |     2 +-
 packages/errors/src/domains/payment/ShopBusyError.ts                                                                         |    10 +
 packages/errors/src/domains/payment/ShopErrors.test.ts                                                                       |    22 +
 packages/errors/src/domains/payment/ShopItemUnavailableError.ts                                                              |    10 +
 packages/errors/src/domains/payment/ShopSalesClosedError.ts                                                                  |    10 +
 packages/errors/src/domains/payment/ShopTooManyOpenOrdersError.ts                                                            |    10 +
 packages/errors/src/domains/payment/TrialAlreadyUsedError.ts                                                                 |    10 +
 packages/errors/src/domains/payment/TrialNotEligibleError.ts                                                                 |    10 +
 packages/errors/src/domains/payment/TrialUnavailableError.ts                                                                 |    10 +
 packages/errors/src/domains/user/CosmeticAlreadyOwnedError.ts                                                                |    10 +
 packages/errors/src/domains/user/CosmeticNotOwnedError.ts                                                                    |    10 +
 packages/errors/src/domains/user/MaxFollowingError.ts                                                                        |    16 +
 packages/errors/src/domains/voice/TableGameConflictError.ts                                                                  |    11 +
 packages/errors/src/domains/voice/TableGameRuleViolationError.ts                                                             |    12 +
 packages/errors/src/domains/voice/UnknownTableGameError.ts                                                                   |    10 +
 packages/errors/src/domains/voice/VoiceSeatTakenError.ts                                                                     |    10 +
 packages/errors/src/domains/voice/VoiceSeatUnknownError.ts                                                                   |    11 +
 packages/errors/src/error_handling/RequestLogRedaction.ts                                                                    |    15 +
 packages/errors/src/i18n/ErrorCodeMappings.ts                                                                                |    52 +
 packages/errors/src/i18n/ErrorI18n.test.ts                                                                                   |    71 +
 packages/errors/src/i18n/ErrorI18nMessages.ts                                                                                |    80 +-
 packages/errors/src/i18n/MicupErrorBrand.test.ts                                                                             |    40 +
 packages/errors/src/i18n/SchemaErrorMappings.test.ts                                                                         |    29 +
 packages/errors/src/i18n/locales/ar.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/bg.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/cs.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/da.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/de.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/el.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/en-GB.ts                                                                                    |    69 +-
 packages/errors/src/i18n/locales/es-419.ts                                                                                   |    69 +-
 packages/errors/src/i18n/locales/es-ES.ts                                                                                    |    69 +-
 packages/errors/src/i18n/locales/fi.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/fr.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/he.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/hi.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/hr.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/hu.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/id.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/it.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/ja.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/ko.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/lt.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/nl.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/no.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/pl.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/pt-BR.ts                                                                                    |    69 +-
 packages/errors/src/i18n/locales/ro.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/ru.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/sv-SE.ts                                                                                    |    69 +-
 packages/errors/src/i18n/locales/th.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/tr.ts                                                                                       |    71 +-
 packages/errors/src/i18n/locales/uk.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/vi.ts                                                                                       |    69 +-
 packages/errors/src/i18n/locales/zh-CN.ts                                                                                    |    69 +-
 packages/errors/src/i18n/locales/zh-TW.ts                                                                                    |    69 +-
 packages/errors/src/i18n/weblate/locales/ar.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/bg.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/cs.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/da.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/de.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/el.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/en-GB.json                                                                          |    71 +-
 packages/errors/src/i18n/weblate/locales/es-419.json                                                                         |    71 +-
 packages/errors/src/i18n/weblate/locales/es-ES.json                                                                          |    71 +-
 packages/errors/src/i18n/weblate/locales/fi.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/fr.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/he.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/hi.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/hr.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/hu.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/id.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/it.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/ja.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/ko.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/lt.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/nl.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/no.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/pl.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/pt-BR.json                                                                          |    71 +-
 packages/errors/src/i18n/weblate/locales/ro.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/ru.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/sv-SE.json                                                                          |    71 +-
 packages/errors/src/i18n/weblate/locales/th.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/tr.json                                                                             |    73 +-
 packages/errors/src/i18n/weblate/locales/uk.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/vi.json                                                                             |    71 +-
 packages/errors/src/i18n/weblate/locales/zh-CN.json                                                                          |    71 +-
 packages/errors/src/i18n/weblate/locales/zh-TW.json                                                                          |    71 +-
 packages/errors/src/i18n/weblate/messages.json                                                                               |    71 +-
 packages/game_catalog/README.md                                                                                              |   200 +
 packages/game_catalog/package.json                                                                                           |    19 +
 packages/game_catalog/src/GameCatalog.test.ts                                                                                |   136 +
 packages/game_catalog/src/GameCatalog.ts                                                                                     |    25 +
 packages/game_catalog/src/catalog.json                                                                                       |  1505 ++
 packages/game_catalog/tsconfig.json                                                                                          |     4 +
 packages/game_catalog/vitest.config.ts                                                                                       |    13 +
 packages/hono/src/middleware/Metrics.ts                                                                                      |    68 +-
 packages/hono/src/middleware/tests/Metrics.test.ts                                                                           |    85 +-
 packages/i18n/scripts/GenerateI18nTypes.ts                                                                                   |     1 +
 packages/i18n/scripts/SyncStaticI18nCatalogs.ts                                                                              |    10 +
 packages/instance_bootstrap/package.json                                                                                     |     3 +-
 packages/instance_bootstrap/src/ClientRuntimeDiscovery.test.ts                                                               |   108 +
 packages/instance_bootstrap/src/ClientRuntimeDiscovery.ts                                                                    |    11 +-
 packages/instance_bootstrap/src/Discovery.ts                                                                                 |    38 +
 packages/limits/src/LimitDefaults.ts                                                                                         |    25 +
 packages/limits/src/__tests__/ApplicationCommandLimits.test.ts                                                               |    48 +
 packages/limits/src/__tests__/MicupLimitDefaults.test.ts                                                                     |    98 +
 packages/openapi/src/converters/__tests__/GameActivitySettingsComponents.test.ts                                             |    28 +
 packages/openapi/src/converters/__tests__/ProfilePrivacyLevelComponents.test.ts                                              |    34 +
 packages/openapi/src/extractors/RouteExtractor.ts                                                                            |     2 +-
 packages/openapi/src/extractors/StaticPathResolver.ts                                                                        |    17 +-
 packages/openapi/src/generator/__tests__/OpenAPIOperationSecurity.test.ts                                                    |    41 +
 packages/schema/proto/buf.gen.yaml                                                                                           |     2 +-
 packages/schema/proto/fluxer/user/preferences/v1/preferences.proto                                                           |     3 +
 packages/schema/src/domains/admin/AdminSchemas.ts                                                                            |   112 +-
 packages/schema/src/domains/admin/AdminThreadSchemas.ts                                                                      |    17 +-
 packages/schema/src/domains/admin/AdminUserSchemas.ts                                                                        |     4 +-
 packages/schema/src/domains/admin/CaptchaSchemas.ts                                                                          |    22 +
 packages/schema/src/domains/admin/GatewayRolloutSchemas.ts                                                                   |     7 +-
 packages/schema/src/domains/admin/UsernameSchemas.ts                                                                         |   202 +
 packages/schema/src/domains/admin/VoiceNoiseSuppressionCompatibility.test.ts                                                 |    43 +
 packages/schema/src/domains/admin/VoiceNoiseSuppressionSchemas.test.ts                                                       |   655 +
 packages/schema/src/domains/admin/VoiceNoiseSuppressionSchemas.ts                                                            |   285 +
 packages/schema/src/domains/admin/VoiceRoomConfigSchemas.test.ts                                                             |   121 +
 packages/schema/src/domains/admin/VoiceRoomConfigSchemas.ts                                                                  |    68 +
 packages/schema/src/domains/application_command/ApplicationCommandSchemas.test.ts                                            |   274 +
 packages/schema/src/domains/application_command/ApplicationCommandSchemas.ts                                                 |   186 +
 packages/schema/src/domains/application_command/InteractionSchemas.test.ts                                                   |   208 +
 packages/schema/src/domains/application_command/InteractionSchemas.ts                                                        |   134 +
 packages/schema/src/domains/auth/AuthSchemas.ts                                                                              |     6 +
 packages/schema/src/domains/badge/BadgeRequestSchemas.ts                                                                     |    40 +
 packages/schema/src/domains/badge/BadgeResponseSchemas.ts                                                                    |    16 +
 packages/schema/src/domains/boost/BoostRequestSchemas.ts                                                                     |    34 +
 packages/schema/src/domains/boost/BoostResponseSchemas.ts                                                                    |    31 +
 packages/schema/src/domains/channel/ChannelRequestSchemas.test.ts                                                            |    46 +
 packages/schema/src/domains/channel/ChannelRequestSchemas.ts                                                                 |     7 +
 packages/schema/src/domains/channel/ChannelSchemas.ts                                                                        |     5 +
 packages/schema/src/domains/cosmetics/CosmeticRequestSchemas.ts                                                              |    99 +
 packages/schema/src/domains/cosmetics/CosmeticResponseSchemas.ts                                                             |   126 +
 packages/schema/src/domains/cosmetics/CosmeticSchemas.test.ts                                                                |   120 +
 packages/schema/src/domains/experiment/ExperimentSchemas.ts                                                                  |    24 +
 packages/schema/src/domains/feed/FeedRequestSchemas.ts                                                                       |   217 +
 packages/schema/src/domains/feed/FeedResponseSchemas.ts                                                                      |   266 +
 packages/schema/src/domains/feed/FeedSchemas.test.ts                                                                         |   267 +
 packages/schema/src/domains/follow/FollowRequestSchemas.ts                                                                   |    35 +
 packages/schema/src/domains/follow/FollowResponseSchemas.ts                                                                  |    20 +
 packages/schema/src/domains/follow/FollowSchemas.test.ts                                                                     |    18 +
 packages/schema/src/domains/guild/GuildRequestSchemas.ts                                                                     |    12 +-
 packages/schema/src/domains/guild/GuildResponseSchemas.ts                                                                    |     4 +
 packages/schema/src/domains/instance/InstanceSchemas.ts                                                                      |    72 +-
 packages/schema/src/domains/message/MessageComponentSchemas.test.ts                                                          |    51 +
 packages/schema/src/domains/message/MessageComponentSchemas.ts                                                               |    45 +
 packages/schema/src/domains/message/MessageResponseSchemas.ts                                                                |     3 +
 packages/schema/src/domains/micupbot/MicupBotRequestSchemas.ts                                                               |   142 +
 packages/schema/src/domains/micupbot/MicupBotResponseSchemas.ts                                                              |   131 +
 packages/schema/src/domains/micupbot/MicupBotSchemas.test.ts                                                                 |    87 +
 packages/schema/src/domains/oauth/OAuthSchemas.ts                                                                            |     1 +
 packages/schema/src/domains/premium/PremiumLedgerSchemas.ts                                                                  |    10 +
 packages/schema/src/domains/premium/PremiumTrialSchemas.ts                                                                   |    14 +
 packages/schema/src/domains/referral/ReferralCode.ts                                                                         |    11 +
 packages/schema/src/domains/referral/ReferralRequestSchemas.ts                                                               |   122 +
 packages/schema/src/domains/referral/ReferralResponseSchemas.ts                                                              |   131 +
 packages/schema/src/domains/referral/ReferralSchemas.test.ts                                                                 |    89 +
 packages/schema/src/domains/roster/GuildRosterRequestSchemas.ts                                                              |    52 +
 packages/schema/src/domains/roster/GuildRosterResponseSchemas.ts                                                             |    36 +
 packages/schema/src/domains/roster/GuildRosterSchemas.test.ts                                                                |    74 +
 packages/schema/src/domains/rpc/RpcSchemas.ts                                                                                |   123 +
 packages/schema/src/domains/shop/ShopAdminSchemas.ts                                                                         |   208 +
 packages/schema/src/domains/shop/ShopPriceFormatting.ts                                                                      |    22 +
 packages/schema/src/domains/shop/ShopRequestSchemas.ts                                                                       |    45 +
 packages/schema/src/domains/shop/ShopResponseSchemas.ts                                                                      |   169 +
 packages/schema/src/domains/shop/ShopSchemas.test.ts                                                                         |   102 +
 packages/schema/src/domains/table_game/TableGameSchemas.test.ts                                                              |   297 +
 packages/schema/src/domains/table_game/TableGameSchemas.ts                                                                   |   281 +
 packages/schema/src/domains/tests/GameActivitySchemas.test.ts                                                                |    69 +
 packages/schema/src/domains/tests/GatewayRolloutSchemas.test.ts                                                              |    35 +
 packages/schema/src/domains/tests/GuildRequestSchemas.test.ts                                                                |    15 +
 packages/schema/src/domains/user/GameActivitySchemas.ts                                                                      |    31 +
 packages/schema/src/domains/user/UserRequestSchemas.ts                                                                       |    15 +-
 packages/schema/src/domains/user/UserResponseSchemas.ts                                                                      |    68 +-
 packages/schema/src/domains/voice_seat/VoiceSeatSchemas.test.ts                                                              |    30 +
 packages/schema/src/domains/voice_seat/VoiceSeatSchemas.ts                                                                   |    23 +
 packages/schema/src/gen/fluxer/user/preferences/v1/preferences_pb.ts                                                         |    14 +-
 packages/schema/src/primitives/MicupBrandGuard.ts                                                                            |   205 +
 packages/schema/src/primitives/UserSettingsValidators.ts                                                                     |    15 +
 packages/schema/src/primitives/UserValidators.ts                                                                             |    40 +-
 packages/schema/src/primitives/tests/MicupBrandGuard.test.ts                                                                 |    34 +
 packages/schema/src/primitives/tests/ProfilePrivacyLevelSchemas.test.ts                                                      |    22 +
 packages/schema/src/primitives/tests/UserValidators.test.ts                                                                  |   120 +
 pnpm-lock.yaml                                                                                                               |   180 +-
 pnpm-workspace.yaml                                                                                                          |     7 +
 tests/game_activity_integration/README.md                                                                                    |    15 +
 tests/game_activity_integration/flow.test.tsx                                                                                |   290 +
 tests/game_activity_integration/game_activity_integration_bridge.erl                                                         |    87 +
 tests/game_activity_integration/run.mjs                                                                                      |    43 +
 tests/game_activity_integration/vitest.config.mts                                                                            |    35 +
 tools/ci/Cargo.lock                                                                                                          |     4 +-
 tools/ci/build-desktop.test.mjs                                                                                              |   102 +
 tools/ci/src/appimage.rs                                                                                                     |    52 +-
 tools/ci/src/ci_workflow.rs                                                                                                  |     1 +
 tools/ci/src/desktop.rs                                                                                                      |   395 +-
 tools/ci/src/release.rs                                                                                                      |     4 +-
 tools/ci/test-entrypoints.test.mjs                                                                                           |    22 +
 tools/dev/cassandra_target_schema.json                                                                                       | 11368 +++++++++-----
 tools/dev/src/cassandra.rs                                                                                                   |   359 +-
 tools/dev/src/main.rs                                                                                                        |    34 +-
 tools/i18n_auto/src/runner.rs                                                                                                |     2 +-
 tools/room_themes/build_manifest.mjs                                                                                         |   454 +
 3705 files changed, 555288 insertions(+), 67008 deletions(-)
```
