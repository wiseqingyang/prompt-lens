# Contributing to PromptLens

Thank you for helping make local Agent inspection reliable and understandable.

Start with a small issue describing the user-visible problem, a synthetic reproduction and the expected result. Discuss architecture, protocol or storage changes before implementing them. Never attach private prompts, repository content, access tokens, CA private keys or unreviewed capture exports.

## Development

Use Node 22.20.0 and Go 1.27.2, with Git, OpenSSL and a POSIX shell. Install with `npm ci`; build with `npm run build`; launch with `npm start`. See [development contracts and verification](docs/DEVELOPMENT.md) and [architecture](docs/ARCHITECTURE.md).

For behavior changes, write acceptance criteria using [the requirement template](docs/requirements/TEMPLATE.md). Add focused tests using temporary data directories, local mock origins and random ports. Preserve upstream requests and responses; never retry a model request or tool call to retry an audit event. Do not use real accounts or install certificates in automated tests.

Run `npm run verify` before sending a PR. Use `npm run verify:fast` for iteration only. Changes to UI require actual UI checks, and release changes require package-level checks. Describe what passed and what remains unverified; do not weaken assertions to make checks pass.

## Pull requests

Explain the problem, resulting behavior, validation and any migration or rollback implications. Keep changes focused. The maintainer reviews compatibility, security and evidence; a proposal may be deferred if its maintenance cost exceeds the supported scope. Be responsive to review, but there is no guaranteed turnaround time.

Submit only work you have the right to contribute under the [MIT license](LICENSE). Preserve third-party attribution. AI-assisted contributions follow the same review and testing requirements; authors remain responsible for correctness, provenance and absence of confidential material. Follow the [code of conduct](CODE_OF_CONDUCT.md).

Security reports follow [SECURITY.md](SECURITY.md), not public issues. General support belongs in [GitHub Issues](https://github.com/wiseqingyang/prompt-lens/issues); include operating system, architecture, app version and relevant Agent version.
