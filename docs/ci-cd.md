# CI/CD and release safety

Last verified against source on 2026-08-04.

This document describes how an Exograph source change becomes a draft macOS
release. It is intentionally narrow: CI/CD decides whether code and the exact
packaged app have earned promotion. It does not decide whether a product choice
is good, complete, or ready for public launch.

## The path

| Stage | What happens | What it proves | Owner |
| --- | --- | --- | --- |
| Local change | A person or agent works in a branch. `pnpm dev:qa` keeps source QA state out of an installed app’s normal state. | Only that there is a candidate change. | Contributor / closest code owner |
| Source gate | `pnpm ci:check` runs unused-code checks, types, tests, builds, graph checks, and local installer dry-run validation. | Source contracts and build composition hold. | [`package.json`](../package.json) |
| Pull-request CI | GitHub repeats the source gate on macOS/Node 24, then runs a real Electron smoke journey. Failure retains a Playwright trace. | The source app crosses one visible Electron boundary. | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| macOS candidate | On every `main` push or explicit request, GitHub builds an unsigned arm64 app and exercises containment, onboarding/restart, terminal/GPU, and QMD against that packaged app. | The actual packaged artifact starts and performs its protected journeys. | [`.github/workflows/package-macos.yml`](../.github/workflows/package-macos.yml) |
| Draft release | A human manually supplies the version. The release workflow verifies that the request is current `main`, versions match, assets verify, and no duplicate exists, then creates a draft prerelease. | A specific, verified candidate may be offered for review. | [`.github/workflows/release-macos.yml`](../.github/workflows/release-macos.yml) |

A failure at any stage is evidence to repair the change; it is never evidence
to advance it.

## Local contributor routine

1. Read the closest owner guidance from [`AGENTS.md`](../AGENTS.md).
2. Run the focused owner check while iterating.
3. Run `pnpm ci:check` before handoff.
4. For a desktop-visible claim, run the relevant Electron journey. For
   packaging, first-run, or native-runtime work, produce an unsigned macOS
   package and test the installed artifact.
5. Report the changed claim, boundary-matched proof, and the smallest durable
   regression guard—or why no new guard was warranted.

Agents follow the same path. They receive no release or test bypass. The
repository gives them progressive owner guidance, an isolated source QA mode,
and canonical proof commands so a human does not need to relay basic context or
terminal work.

## Current safeguards

- All GitHub Actions are pinned to full commit SHAs.
- Validation workflows have read-only repository authority; persistent checkout
  credentials are disabled.
- Only the final draft-release job receives `contents: write`, and only after
  the candidate workflow succeeds.
- Candidate archives are isolated, checksummed, and re-verified before draft
  creation.
- [`scripts/ci-contract.test.mjs`](../scripts/ci-contract.test.mjs) fails when
  required pull-request, candidate, or release workflow safeguards disappear.

## Still required before a signed public release

These are not implied by a passing workflow; each needs explicit completion
evidence.

- [ ] Configure protected `main` in GitHub and mark the CI check required before
  merge. Until then CI is a strong review signal, not a mechanical merge block.
- [ ] Sign and notarize the macOS app, then verify Gatekeeper on a clean Mac.
- [ ] Prove clean install, relaunch, uninstall/reinstall, CLI/MCP installation,
  and no dependence on a development checkout or existing shell setup.
- [x] Produce and verify package-content, license, and SPDX SBOM evidence for
  every staged macOS app. `pack:mac` writes it under `release/evidence/` and
  rejects first-party tests, fixtures, internal docs, and Windows payloads.
- [x] Make local app replacement interruption-safe. The installer stages the
  replacement, restores the prior app on interruption, and has a deterministic
  rollback regression test.

## What CI/CD does not replace

Human review and dogfooding decide whether the feature solves the right problem.
CI/CD verifies bounded technical claims. Agent-first engineering additionally
asks whether an unfamiliar agent can find the owner, make a safe change, run
the right proof, and leave the repository easier to change next time. That is a
separate capability with its own evidence, not a claim made by this document.
