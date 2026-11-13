# Code signing policy — Orca G5

**Status:** this independent fork is not approved by SignPath Foundation and has no signed G5 release. Free code signing provided by SignPath.io, certificate by SignPath Foundation — **if and only if approved by SignPath Foundation**.

## Upstream and scope
This is a modification of [stablyai/orca](https://github.com/stablyai/orca) under the MIT license. The G5 branch derives from official Orca 1.4.246 (base commit `55ccff19ad4cd8ba28b6f3d2be798c1e626a2c2c`), which has signed Windows installers. The fork is independently maintained and is **not** an official stablyai release.

G5 adds experimental installation integration and process-identity checks. No software in this branch should be installed as a trusted signed G5 release.

## Roles and approvals
- Source owner and current proposed maintainer: GitHub account [AilLabPT](https://github.com/AilLabPT).
- Authors / committers: repository collaborators with write access. Enable MFA.
- Reviewers: to be nominated and documented before release.
- SignPath signing approvers: **not yet assigned**; every signing request requires manual approval by an authorized, independent reviewer, subject to SignPath Foundation eligibility.
- Source/build workflow changes require security review.

## Privacy and system changes
The fork retains network-capable AI-provider integrations, remote process/terminal management, and optional agents. These features may communicate with services configured by the user. Exact data flow, telemetry and third-party policies must be reviewed and documented in the [G5 privacy readiness notice](G5_PRIVACY_READINESS.md) before any production release. Do **not** assume that all communication is disabled by default.

Installation modifies application files and may install helpers. All production installers must disclose system changes and support uninstallation. Until privacy review, **no signed production release is authorized**.

## SignPath rules and signed artifact gate
1. Use source-controlled, automatically built packages from the public fork and a branch based on a signed upstream release.
2. Never sign third-party upstream executables as G5-owned components. Preserve their attribution and existing signature.
3. Sign the appropriate G5-owned executables, NSIS installer and uninstaller only under an approved artifact configuration and publisher identity.
4. Check release version/product metadata consistency, Authenticode publisher, certificate chain and timestamps, then publish SHA-256 checksums for *signed* binaries.
5. Verify bundled addon imports, executable architecture, selected runtime identity and exact template manifests. Re-run disposable Windows installation/update/rollback, GUI/PTY and failure-recovery tests.
6. Complete independent review of the signed artifact SHA before declaring GO.

No secrets, personal credentials or signing keys may appear in source or CI artifacts. SignPath API tokens must be held as protected GitHub secrets.

**Current approved production releases: none.** This policy describes intended controls, not a valid signature or SignPath Foundation endorsement.
