# Orca G5 fork — SignPath Foundation application readiness

Date: 2026-11-17. Status: **NOT SUBMITTED / NOT APPROVED / NOT PRODUCTION SIGNED**.

This is an evidence-based intake preparation checklist, not an entitlement to a free
certificate or a request to sign a release. No API token, identity document, password,
personal email or signing secret is stored here.

## Project identification and scope

- Public project repository: https://github.com/AilLabPT/orca-g5-open
- Upstream project: https://github.com/stablyai/orca
- GitHub reports the repository as an **actual public fork** of stablyai/orca.
- GitHub reports both repository licenses as MIT.
- Development branch: g5-security-wip-20261116 (draft PR #1).
- Default branch: g5-1.4.246; current validation is not a production release.
- Working description: experimental G5 extension for Windows remote managed-server
  installation and recovery, Linux Docker sidecar and authenticated PTY protocol 54.
- This modified fork is **not** an official Stably AI release. Any project
  reputation, maintainership, software-signing authority and product naming
  must accurately distinguish the fork from upstream.
- Existing project policy: CODE_SIGNING_POLICY.md.
- Privacy release review: G5_PRIVACY_READINESS.md, still an outstanding gate.

## SignPath Foundation eligibility requirements

Official conditions: https://signpath.org/terms
Apply: https://signpath.org/apply
GitHub origin verification: https://docs.signpath.io/trusted-build-systems/github
Signing policy configuration: https://docs.signpath.io/projects

Before application/approval, the project maintainers must establish:
1. Project is maintained, properly licensed, publicly documented and already
   released in the required form. **An experimental QA installer is not evidence
   of an eligible production release.**
2. Verified original maintenance/ownership of all fork-specific code and build
   scripts; the visibly forked upstream project publishes signed official
   binaries and signing branches actually derive from normally signed upstream
   releases. These upstream facts require evidence, not assumption.
3. No proprietary components or unauthorized third-party executable signatures
   are included. Audit bundled dependencies and licensing.
4. Project/maintainer reputation and suitability for a Foundation certificate
   can be verified by the Foundation.
5. MFA on GitHub and SignPath; assigned source reviewers and independent
   signing approvers. The accessible repository lists only AilLabPT as
   collaborator; no separate signing approver has been verified.
6. An openly linked **Code signing policy** from the project homepage and
   release/download pages, covering metadata and publisher naming.
7. Complete privacy/system-change disclosures, tested uninstall and rollback.
8. Trusted GitHub-hosted CI with source/branch origin verification, protected
   reviewed release branch, immutable build provenance, artifact SHA-256 and
   manual approval per signing request.
9. Release sign only the authorized fork's maintained binaries and approved
   installer/uninstaller components; do not re-sign unmaintained upstream
   binaries as if fork-owned.
10. Publicly verify Authenticode signature status, publisher certificate chain,
    timestamp, signed-file SHA-256, embedded binary version, and exact source
    revision, then repeat installation/update/recovery/rollback in disposable
    Windows environments.

## Current blockers and verified status

- Existing build artifacts are **QA-only, self-signed** and cannot establish
  publicly trusted publisher signing.
- No SignPath Foundation project acceptance, approved policy, configured
  signing token or authorized release signing certificate was verified.
- No signed production installer for the latest G5 source exists.
- Native G5/Docker was not proved through the actual non-admin SSH account;
  a SID-restricted *read-only* named-pipe broker experiment has been created
  but must be independently audited and subjected to real end-to-end CI.
- The G5 Windows QA installation and two-version survival update/rollback
  passed for an earlier source SHA. Rebuild and requalify after any code changes.
- Production G5 release, merger to default/release branch and publication are
  **HOLD**.

## Safe request summary for a future Foundation intake

We request consideration of the independent open-source fork AilLabPT/orca-g5-open
for SignPath Foundation code signing. Our project derives from stablyai/orca
(MIT) and develops separate G5 Windows installation, recovery and Docker/PTY
integrations. We will release only code and packages under our actual
maintainership, retain upstream license and attribution, publish a code-signing
policy, implement protected GitHub-based origin verification, document privacy
and system effects, designate a separate signing approver, and provide
production-readiness audit evidence and reproducible release artifacts.
We do **not** claim acceptance, current publisher identity, official upstream
authorization, or an entitlement to use the Foundation certificate.

**No application has been submitted.** Submission, project verification,
certificate authorization and release approval are external actions handled by
SignPath Foundation and properly authorized project maintainers.
