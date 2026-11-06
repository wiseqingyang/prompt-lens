# Security policy

PromptLens handles potentially sensitive local traffic and can install a trusted root certificate. Read the [security and privacy model](docs/SECURITY_MODEL.md) and [recovery guide](docs/UNINSTALL.md) before using it.

## Supported versions

The project is preparing its first public release. The current development branch receives fixes; older private builds are not maintained security releases. A stable support window will be stated with the first release. Do not assume a package version alone means the build was signed or validated.

## Reporting vulnerabilities

Use [GitHub private vulnerability reporting](https://github.com/wiseqingyang/prompt-lens/security/advisories/new) when the repository's “Report a vulnerability” button is available. Describe affected versions, impact and a minimal synthetic reproduction. Do not include live credentials, private traffic or CA private keys.

**Release prerequisite:** the maintainer must enable and verify this private reporting channel, or provide a verified private contact before public launch. If the button is unavailable, do not put exploit details in a public issue. This prerequisite remains tracked in [the publication checklist](docs/RELEASING.md#首次公开检查); the link alone does not enable the feature.

Reports are assessed by the maintainer. We coordinate fixes and disclosure with the reporter and credit them with consent. No response-time guarantee or paid bounty is offered. Please allow reasonable coordination before publishing an unpatched issue.

## Dependency monitoring

Run `npm run audit:dependencies` for npm advisories and the pinned Go vulnerability scanner in the security workflow. Scanner failures are failures, not zero vulnerabilities. Any unresolved advisory requires a documented dependency path, impact assessment, owner and review date; see [dependency review](docs/DEPENDENCY_SECURITY.md).
