# vendor/ — pinned, self-hosted browser libraries

Minified UMD builds served by `swarm board --serve` and copied beside generated
board HTML, so the visualizer works offline and never loads from a CDN
(docs/design/SWARM-VISUALIZER.md §2, §9). UMD (classic `<script>`) is required:
ES-module imports are blocked over `file://` by browser CORS rules.

Provenance: fetched 2026-07-19 via `npm pack` from the npm registry (not a CDN),
dist files copied verbatim. Licenses: mermaid MIT · cytoscape.js MIT ·
cytoscape-dagre MIT (bundles dagre/graphlib internally — no separate dagre file
needed) · echarts Apache-2.0.

| File | Package | Version | SHA-256 |
|---|---|---|---|
| mermaid.min.js | mermaid | 11.16.0 | 74d7c46dabca328c2294733910a8aa1ed0c37451776e8d5295da38a2b758fb9b |
| cytoscape.min.js | cytoscape | 3.34.0 | 9c2a3bf2592e0b14a1f7bec07c03a54f16dedf32af9cd0af155c716aa6c87bc3 |
| cytoscape-dagre.min.js | cytoscape-dagre | 4.0.0 | b9e9d704119970f4255c035baa98d778e94af4b2efd2bdba20a601a869417223 |
| echarts.min.js | echarts | 5.6.0 | bf4a223524e40b77c304bec67e1222cf551f14880cf42c69dc046558e11c07b1 |

Note: cytoscape-dagre 4.0.0's dist banner self-reports "3.0.0" — stale banner in
the published tarball; the package.json version is 4.0.0.

## Update procedure

1. `npm pack <pkg>@<version>` in a scratch dir; extract; copy the dist UMD file here verbatim (never edit contents).
2. `shasum -a 256 vendor/*.js` and update the table above (version + hash) in the same commit.
3. Run the full test suite — server/asset tests assert these files exist and HTML references no external URLs.
