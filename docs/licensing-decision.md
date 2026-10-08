# Sandpane licensing decision record (P0 BLOCKER)

Required by `specs/06_SECURITY_AND_LICENSING.md` §1 and `specs/07_ROADMAP_AND_TASKS.md` (P0). **Public release of any SBX-integrated Sandpane artifact is blocked until every gate below is checked with evidence linked.**

## Current position (09.10.2026)

- Original Sandpane code: **MIT** (see `/LICENSE`), subject to dependency/redistribution review.
- Sandpane is an independent open-source developer tool published by DKV Labs. It is not affiliated with or endorsed by Docker, Inc. Docker Sandboxes is installed, licensed, and authenticated separately by the user.
- No Docker SBX binaries are bundled. No proprietary ChatGPT/Claude Desktop/Copilot/JetBrains AI internals are accessed or imitated.
- All SBX interaction is designed to go through the documented public CLI with typed argument vectors (no shell interpolation, no private APIs).

## Release gates (all UNCHECKED — status: OPEN)

- [ ] Obtain current applicable Docker/SBX license terms; record effective version/date here.
- [ ] Written Docker clarification covering: (a) local CLI wrapper GUI, (b) persistent background orchestration service, (c) open-source VS Code/JetBrains plugins, (d) standalone cross-platform binary distribution, (e) templates/exports, (f) Docker name/trademark references and attribution.
- [ ] Confirm permitted branding, screenshots, and logos without implication of affiliation.
- [ ] Confirm license compatibility of all dependencies, SDKs, SDK binary packaging, and marketplace requirements (run dependency audit; record output).
- [ ] Publish independent-software notice and dependency prerequisites (README).
- [ ] Review whether users' access to cloud SBX is governed by separate terms/billing; default cloud OFF.
- [ ] Verify name/trademark/domain/marketplace suitability for "Sandpane".
- [ ] Preserve the written decision and escalate unresolved terms before public launch.

## Decision log

| Date | Decision | By | Evidence |
|---|---|---|---|
| 09.10.2026 | Adopt MIT for original code at scaffold stage; all distribution gates remain OPEN; internal prototyping only | AI implementation session (goal 5f437ea3) | this file, /LICENSE |

## Fallback rule

If permission is unclear: continue only with approved independently written features and internal technical prototypes; postpone public SBX integration release until reviewed. Do not attempt to bypass terms by hiding the integration or manipulating private APIs (specs/06 §1).
