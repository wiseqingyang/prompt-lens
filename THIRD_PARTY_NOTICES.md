# Third-party notices and asset provenance

PromptLens project code follows [LICENSE](LICENSE). Third-party components retain their respective licenses; the project's MIT declaration does not relicense them.

| Material | Source / scope | Attribution |
| --- | --- | --- |
| Electron | Electron runtime distributed by electron-builder | MIT and Chromium/Node bundled notices; preserve runtime license files |
| Font Awesome Free 6.7.2 | `@fortawesome/fontawesome-free`, CSS and fonts compiled into the renderer | Fonticons, Inc.; icons CC BY 4.0, fonts SIL OFL 1.1, code MIT; include the package license in distribution notices |
| gorilla/websocket | `core-go/go.mod` | BSD-2-Clause; include upstream LICENSE in distribution notices |
| abstract-logging 2.0.1 | Upstream README license link; collected in `licenses/abstract-logging.txt` | James Sumners, MIT |
| npm dependencies | Exact versions and integrity hashes in `package-lock.json` | Generated distribution inventory includes installed package license texts |
| Agent letter icons | `src/renderer/assets/agent-{codex,antigravity,pi}.svg` | Simple project-authored letter tiles; do not use vendor logo artwork |
| PromptLens mark | `resources/promptlens-mark.*`, renderer copy | Project asset; the maintainer has confirmed ownership or authorization for public use |

Product names identify supported integrations. PromptLens is an independent project and does not claim endorsement by the companies or communities behind those products.

Run `npm run release:metadata` after `npm ci` to generate license texts and an SBOM under `.quality/distribution/`. The SBOM includes build dependencies as well as runtime dependencies, including assets bundled from development dependencies. Release packaging must include these notices. Review missing-license warnings and bundled runtime notices before distribution.

Some build-only packages do not ship a standalone license file. The generated `license-text-review.json` lists them; README text and declared license are retained. Missing runtime license text fails metadata generation. Do not treat build metadata as a complete legal provenance review.
