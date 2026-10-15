// SPDX-License-Identifier: AGPL-3.0-or-later

// The catalog palettes as plain strings: the bundler and the test runner read them the same way, and the metadata
// header is the one the theme library parses from any imported file.

export const MOR_GECE_CSS = `/* SPDX-License-Identifier: AGPL-3.0-or-later
 * @name Mor Gece
 * @description sanalyer markasının moru ve altını, gece lacivertine yakın koyu bir zeminde.
 * @author sanalyer
 * @version 1.0.0
 * @tags koyu, mor, sanalyer
 */

/* The palette applies over every built-in theme: :root[class] outranks the theme classes of color-system.css. */
:root,
:root[class] {
	--background-secondary: #120a1c;
	--background-secondary-lighter: #170e23;
	--background-channel-header: #170e23;
	--side-panel-background: #1a1026;
	--guild-list-foreground: #1d1229;
	--background-primary: #1f1430;
	--background-secondary-alt: #1f1430;
	--background-textarea: #251838;
	--background-tertiary: #241736;
	--background-header-secondary: #2d1d45;
	--background-header-primary: #2d1d45;
	--background-header-primary-hover: #3a2759;
	--bg-primary: #1f1430;
	--bg-secondary: #120a1c;
	--bg-tertiary: #241736;
	--bg-hover: #3a2759;
	--bg-active: #45306a;
	--text-primary: #f5eefa;
	--text-chat: #e9e0f1;
	--text-secondary: #cdbfdb;
	--text-primary-muted: #a393b5;
	--text-chat-muted: #9887aa;
	--text-tertiary: #9887aa;
	--text-tertiary-secondary: #7e6d92;
	--text-tertiary-muted: #6f5f82;
	--interactive-muted: #7e6d92;
	--interactive-active: #f5eefa;
	--brand-primary: #b5179e;
	--brand-secondary: #9a1386;
	--brand-primary-light: #f0a3e3;
	--brand-primary-fill: #ffffff;
	--text-on-brand-primary: #ffffff;
	--plutonium: #b5179e;
	--plutonium-hover: #9a1386;
	--focus-primary: #ffc83d;
	--border-color: #2f2145;
	--border-color-hover: #3d2c59;
	--border-color-focus: #b5179e;
	--background-modifier-hover: rgb(255 255 255 / 0.05);
	--background-modifier-selected: rgb(255 255 255 / 0.1);
	--background-modifier-accent: rgb(181 23 158 / 0.18);
	--background-modifier-accent-focus: rgb(181 23 158 / 0.26);
	--control-button-hover-bg: #3a2759;
	--control-button-active-bg: #45306a;
	--scrollbar-thumb-bg: #3a2759;
	--scrollbar-thumb-bg-hover: #4a3a72;
	--scrollbar-track-bg: transparent;
	--code-inline-bg: #2a1b40;
	--bg-code: #2a1b40;
	--code-block-bg: #150c20;
	--bg-code-block: #150c20;
	--code-block-border: #2f2145;
	--text-link: #e58cff;
	--button-secondary-fill: #332349;
	--button-secondary-active-fill: #40305c;
	--button-secondary-text: #f5eefa;
}
`;

export const DERIN_DENIZ_CSS = `/* SPDX-License-Identifier: AGPL-3.0-or-later
 * @name Derin Deniz
 * @description Lacivert zemin, turkuaz vurgu; gece yarısı denizi.
 * @author sanalyer
 * @version 1.0.0
 * @tags koyu, mavi
 */

/* The palette applies over every built-in theme: :root[class] outranks the theme classes of color-system.css. */
:root,
:root[class] {
	--background-secondary: #081019;
	--background-secondary-lighter: #0c1521;
	--background-channel-header: #0c1521;
	--side-panel-background: #0f1a28;
	--guild-list-foreground: #12202f;
	--background-primary: #142434;
	--background-secondary-alt: #142434;
	--background-textarea: #182a3c;
	--background-tertiary: #172838;
	--background-header-secondary: #203649;
	--background-header-primary: #203649;
	--background-header-primary-hover: #2b4860;
	--bg-primary: #142434;
	--bg-secondary: #081019;
	--bg-tertiary: #172838;
	--bg-hover: #2b4860;
	--bg-active: #355772;
	--text-primary: #eef4f9;
	--text-chat: #dde7ef;
	--text-secondary: #bfcfdd;
	--text-primary-muted: #91a5b7;
	--text-chat-muted: #86a0b3;
	--text-tertiary: #86a0b3;
	--text-tertiary-secondary: #6f8799;
	--text-tertiary-muted: #617a8c;
	--interactive-muted: #6f8799;
	--interactive-active: #eef4f9;
	--brand-primary: #27b3c9;
	--brand-secondary: #1e97aa;
	--brand-primary-light: #a3e6ef;
	--brand-primary-fill: #04121a;
	--text-on-brand-primary: #04121a;
	--plutonium: #27b3c9;
	--plutonium-hover: #1e97aa;
	--focus-primary: #ffc83d;
	--border-color: #203649;
	--border-color-hover: #2b4860;
	--border-color-focus: #27b3c9;
	--background-modifier-hover: rgb(255 255 255 / 0.05);
	--background-modifier-selected: rgb(255 255 255 / 0.1);
	--background-modifier-accent: rgb(39 179 201 / 0.18);
	--background-modifier-accent-focus: rgb(39 179 201 / 0.26);
	--control-button-hover-bg: #2b4860;
	--control-button-active-bg: #355772;
	--scrollbar-thumb-bg: #2b4860;
	--scrollbar-thumb-bg-hover: #38597a;
	--scrollbar-track-bg: transparent;
	--code-inline-bg: #1c3246;
	--bg-code: #1c3246;
	--code-block-bg: #0b1521;
	--bg-code-block: #0b1521;
	--code-block-border: #203649;
	--text-link: #6fd3ff;
	--button-secondary-fill: #223b4f;
	--button-secondary-active-fill: #2d4a62;
	--button-secondary-text: #eef4f9;
}
`;

export const CAM_ORMANI_CSS = `/* SPDX-License-Identifier: AGPL-3.0-or-later
 * @name Çam Ormanı
 * @description Yosun yeşili zeminler, açık yeşil vurgu; gözü yormayan serin bir gece.
 * @author sanalyer
 * @version 1.0.0
 * @tags koyu, yeşil
 */

/* The palette applies over every built-in theme: :root[class] outranks the theme classes of color-system.css. */
:root,
:root[class] {
	--background-secondary: #0b1410;
	--background-secondary-lighter: #0f1a15;
	--background-channel-header: #0f1a15;
	--side-panel-background: #122019;
	--guild-list-foreground: #152419;
	--background-primary: #172a21;
	--background-secondary-alt: #172a21;
	--background-textarea: #1b3027;
	--background-tertiary: #1a2d24;
	--background-header-secondary: #22392e;
	--background-header-primary: #22392e;
	--background-header-primary-hover: #2c4a3b;
	--bg-primary: #172a21;
	--bg-secondary: #0b1410;
	--bg-tertiary: #1a2d24;
	--bg-hover: #2c4a3b;
	--bg-active: #355846;
	--text-primary: #eef5f1;
	--text-chat: #dde9e2;
	--text-secondary: #c0d3c8;
	--text-primary-muted: #93a89c;
	--text-chat-muted: #8aa093;
	--text-tertiary: #8aa093;
	--text-tertiary-secondary: #728a7b;
	--text-tertiary-muted: #647c6d;
	--interactive-muted: #728a7b;
	--interactive-active: #eef5f1;
	--brand-primary: #3fb47a;
	--brand-secondary: #33985f;
	--brand-primary-light: #a8e6c5;
	--brand-primary-fill: #06130b;
	--text-on-brand-primary: #06130b;
	--plutonium: #3fb47a;
	--plutonium-hover: #33985f;
	--focus-primary: #ffc83d;
	--border-color: #22392e;
	--border-color-hover: #2c4a3b;
	--border-color-focus: #3fb47a;
	--background-modifier-hover: rgb(255 255 255 / 0.05);
	--background-modifier-selected: rgb(255 255 255 / 0.1);
	--background-modifier-accent: rgb(63 180 122 / 0.18);
	--background-modifier-accent-focus: rgb(63 180 122 / 0.26);
	--control-button-hover-bg: #2c4a3b;
	--control-button-active-bg: #355846;
	--scrollbar-thumb-bg: #2c4a3b;
	--scrollbar-thumb-bg-hover: #3a5e4b;
	--scrollbar-track-bg: transparent;
	--code-inline-bg: #1f3a2c;
	--bg-code: #1f3a2c;
	--code-block-bg: #0e1a13;
	--bg-code-block: #0e1a13;
	--code-block-border: #22392e;
	--text-link: #7fd7ff;
	--button-secondary-fill: #25402f;
	--button-secondary-active-fill: #30503c;
	--button-secondary-text: #eef5f1;
}
`;

export const KEHRIBAR_CSS = `/* SPDX-License-Identifier: AGPL-3.0-or-later
 * @name Kehribar
 * @description Kahve tonlarında sıcak bir zemin, kehribar sarısı vurgu.
 * @author sanalyer
 * @version 1.0.0
 * @tags koyu, sıcak, turuncu
 */

/* The palette applies over every built-in theme: :root[class] outranks the theme classes of color-system.css. */
:root,
:root[class] {
	--background-secondary: #140f0a;
	--background-secondary-lighter: #1a140d;
	--background-channel-header: #1a140d;
	--side-panel-background: #1f1810;
	--guild-list-foreground: #241c13;
	--background-primary: #271f15;
	--background-secondary-alt: #271f15;
	--background-textarea: #2d2419;
	--background-tertiary: #2b2217;
	--background-header-secondary: #3a2e20;
	--background-header-primary: #3a2e20;
	--background-header-primary-hover: #4b3c2a;
	--bg-primary: #271f15;
	--bg-secondary: #140f0a;
	--bg-tertiary: #2b2217;
	--bg-hover: #4b3c2a;
	--bg-active: #5a4932;
	--text-primary: #f8f1e8;
	--text-chat: #ece3d6;
	--text-secondary: #d4c6b3;
	--text-primary-muted: #a89880;
	--text-chat-muted: #9f9078;
	--text-tertiary: #9f9078;
	--text-tertiary-secondary: #857863;
	--text-tertiary-muted: #776b57;
	--interactive-muted: #857863;
	--interactive-active: #f8f1e8;
	--brand-primary: #e8a23a;
	--brand-secondary: #cf8d2a;
	--brand-primary-light: #ffd79a;
	--brand-primary-fill: #1a1208;
	--text-on-brand-primary: #1a1208;
	--plutonium: #e8a23a;
	--plutonium-hover: #cf8d2a;
	--focus-primary: #e8a23a;
	--border-color: #3a2e20;
	--border-color-hover: #4b3c2a;
	--border-color-focus: #e8a23a;
	--background-modifier-hover: rgb(255 255 255 / 0.05);
	--background-modifier-selected: rgb(255 255 255 / 0.1);
	--background-modifier-accent: rgb(232 162 58 / 0.18);
	--background-modifier-accent-focus: rgb(232 162 58 / 0.26);
	--control-button-hover-bg: #4b3c2a;
	--control-button-active-bg: #5a4932;
	--scrollbar-thumb-bg: #4b3c2a;
	--scrollbar-thumb-bg-hover: #5e4b34;
	--scrollbar-track-bg: transparent;
	--code-inline-bg: #3a2c1c;
	--bg-code: #3a2c1c;
	--code-block-bg: #120d08;
	--bg-code-block: #120d08;
	--code-block-border: #3a2e20;
	--text-link: #8ec9ff;
	--button-secondary-fill: #3b2f22;
	--button-secondary-active-fill: #4a3b2b;
	--button-secondary-text: #f8f1e8;
}
`;

export const KAGIT_CSS = `/* SPDX-License-Identifier: AGPL-3.0-or-later
 * @name Kağıt
 * @description Krem kâğıt dokusunda açık bir tema; gündüz okumak için.
 * @author sanalyer
 * @version 1.0.0
 * @tags açık, krem
 */

/* The palette applies over every built-in theme: :root[class] outranks the theme classes of color-system.css. */
:root,
:root[class] {
	--background-secondary: #e9e2d6;
	--background-secondary-lighter: #efe9df;
	--background-channel-header: #efe9df;
	--side-panel-background: #f3eee6;
	--guild-list-foreground: #e3dbcd;
	--background-primary: #faf6ef;
	--background-secondary-alt: #f5f0e8;
	--background-textarea: #ffffff;
	--background-tertiary: #f1ebe2;
	--background-header-secondary: #e6dfd3;
	--background-header-primary: #e6dfd3;
	--background-header-primary-hover: #dad2c4;
	--bg-primary: #faf6ef;
	--bg-secondary: #e9e2d6;
	--bg-tertiary: #f1ebe2;
	--bg-hover: #e3dbcd;
	--bg-active: #d8cfc0;
	--text-primary: #2b241c;
	--text-chat: #332b22;
	--text-secondary: #4a4034;
	--text-primary-muted: #6b5f50;
	--text-chat-muted: #7a6d5d;
	--text-tertiary: #7a6d5d;
	--text-tertiary-secondary: #8f8273;
	--text-tertiary-muted: #a0948a;
	--interactive-muted: #8f8273;
	--interactive-active: #2b241c;
	--brand-primary: #b5179e;
	--brand-secondary: #9a1386;
	--brand-primary-light: #f3c7ea;
	--brand-primary-fill: #ffffff;
	--text-on-brand-primary: #ffffff;
	--plutonium: #b5179e;
	--plutonium-hover: #9a1386;
	--focus-primary: #b5179e;
	--border-color: #ddd4c6;
	--border-color-hover: #cfc5b5;
	--border-color-focus: #b5179e;
	--background-modifier-hover: rgb(43 36 28 / 0.06);
	--background-modifier-selected: rgb(43 36 28 / 0.12);
	--background-modifier-accent: rgb(181 23 158 / 0.14);
	--background-modifier-accent-focus: rgb(181 23 158 / 0.22);
	--control-button-normal-text: #6b5f50;
	--control-button-hover-bg: #e3dbcd;
	--control-button-hover-text: #2b241c;
	--control-button-active-bg: #d8cfc0;
	--control-button-active-text: #2b241c;
	--scrollbar-thumb-bg: #cfc5b5;
	--scrollbar-thumb-bg-hover: #bdb2a0;
	--scrollbar-track-bg: transparent;
	--code-inline-bg: #ece5d9;
	--bg-code: #ece5d9;
	--code-block-bg: #f1ebe2;
	--bg-code-block: #f1ebe2;
	--code-block-border: #ddd4c6;
	--code-text: #2b241c;
	--text-code: #2b241c;
	--code-muted: #7a6d5d;
	--text-link: #1769b5;
	--status-offline: #a0948a;
	--button-secondary-fill: #e6dfd3;
	--button-secondary-active-fill: #dad2c4;
	--button-secondary-text: #2b241c;
	--panel-control-bg: #f5f0e8;
	--panel-control-border: #ddd4c6;
	--panel-control-divider: #ddd4c6;
	--panel-control-highlight: rgb(255 255 255 / 0.6);
}
`;
