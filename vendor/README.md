# vendor/ — pinned, self-hosted browser libraries

Pinned browser libraries, self-hosted so the board works offline and never
loads from a CDN.

- `mermaid.min.js` — UMD, used by `swarm board --graph` file output only
  (classic `<script>`; ES-module imports are blocked over `file://`).
- `preact-*.module.js`, `htm-*.module.js` — browser ES modules served by
  `swarm board --serve` for the v2 board (docs/design/SWARM-BOARD-V2.md).
  Board v1's cytoscape/echarts bundles were removed with the v2 rewrite.
  preact-hooks has ONE deliberate edit: its bare `from"preact"` import is
  rewritten to `from"./preact-10.29.7.module.js"` so it resolves in-browser.

Provenance: fetched 2026-07-19 (mermaid) and 2026-07-22 (preact/htm) via
`npm pack` from the npm registry, dist files copied verbatim except the noted
hooks import rewrite. Licenses: mermaid MIT · preact MIT · htm Apache-2.0.

| File | Package | Version | SHA-256 |
|---|---|---|---|
| mermaid.min.js | mermaid | 11.16.0 | 74d7c46dabca328c2294733910a8aa1ed0c37451776e8d5295da38a2b758fb9b |
| preact-10.29.7.module.js | preact | 10.29.7 | 850dcba8ed3535b0a3611495c405551b9887724885d3b8482207a03de365d64e |
| preact-hooks-10.29.7.module.js | preact (hooks dist) | 10.29.7 | 0b3a11f9f2fe079d7ca267eb53b37533dced0664485c7529a13daa6b1bfa3afe |
| htm-3.1.1.module.js | htm | 3.1.1 | ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4 |

## Update procedure

1. `npm pack <pkg>@<version>` in a scratch dir; extract; copy the dist UMD file here verbatim (never edit contents).
2. `shasum -a 256 vendor/*.js` and update the table above (version + hash) in the same commit.
3. Run the full test suite — server/asset tests assert these files exist and HTML references no external URLs.
