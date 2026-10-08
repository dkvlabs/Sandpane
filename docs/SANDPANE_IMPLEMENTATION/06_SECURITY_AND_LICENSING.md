# Sandpane — Security, licensing, and compliance gates

**Date:** 08.10.2026 · **Important:** engineering guidance; not legal advice, and not a statement that Docker has authorized this product.

## 1. The legal question to resolve first

Sandpane intends to be a third-party, independent open-source GUI and orchestration client for Docker Sandboxes (`sbx`). It uses **documented external interfaces**, and users install/authenticate Docker SBX separately. The Docker Subscription Service Agreement and any SBX-specific license terms may still restrict particular third-party integrations, derivative works, redistribution and competitive products.

**A documented CLI command does not automatically constitute permission to publish every GUI/service that calls it.** Technical feasibility and distribution rights are different checks.

### Mandatory release gate

- [ ] Obtain current applicable Docker/SBX license terms and record effective version/date.
- [ ] Ask Docker for written clarification covering: (a) local CLI wrapper GUI, (b) persistent background orchestration service, (c) open-source VS Code/JetBrains plugins, (d) standalone cross-platform binary distribution, (e) templates/exports, (f) Docker name/trademark references and attribution.
- [ ] Confirm permitted branding, screenshots and logos without implication of affiliation.
- [ ] Confirm license compatibility of all dependencies, SDKs, SDK binary packaging and marketplace requirements.
- [ ] Publish independent-software notice and dependency prerequisites.
- [ ] Review whether users' access to cloud SBX is governed by separate terms/billing; default cloud OFF.
- [ ] Preserve the written decision and escalate unresolved terms before public launch.

**Fallback if permission is unclear:** continue only with approved independently written features and internal technical prototypes; postpone public SBX integration release until reviewed. Do not attempt to bypass terms by hiding the integration or manipulating private APIs.

Recommended product disclaimer:

> Sandpane is an independent open-source developer tool published by DKV Labs. It is not affiliated with or endorsed by Docker, Inc. Docker Sandboxes is installed, licensed and authenticated separately.

Open-sourcing original Sandpane code under MIT **does not relicense Docker SBX or any third-party agent software**.

## 2. Integration authorization matrix

| Operation | Interface | Release policy |
|---|---|---|
| Sandbox create/list/start/stop/remove | Public SBX CLI | Confirm published commands and wrapper licensing |
| Network/ports/templates/MCP/secrets | Public documented SBX CLI | Capability-gate per installed version; test exact flags |
| Local application SSH connectivity | Official SBX integration docs | Guide user; don't edit proprietary app's private config |
| Codex chat and sessions | Documented Codex app-server, tested inside SBX | Agent-specific feasibility gate |
| Claude Code chat | Documented structured CLI / Agent SDK, tested inside SBX | Adapter-specific gate |
| VS Code/JetBrains editor UI | Public IDE extension SDKs | Follow marketplace policy |
| ChatGPT/Claude Desktop native-app chat history | Not documented as accessible | Do not attempt to read, scrape or sync |
| Docker internal daemon/private API | Undocumented/private | Excluded |
| Redistribution of SBX binaries | Proprietary | Excluded absent explicit authorization |
| Cloud Sandbox API | Experimental documented API | Future separate review; user billing/consent required |

## 3. Threat model

**Assets:** user's source code, uncommitted changes, environment secrets, agent credentials, Git remotes, local machine, sandbox configs, Core SQLite database, chat history, and logs.

**Trust boundaries:** React webview ⇄ IDE extension host ⇄ local IPC ⇄ Core ⇄ SBX CLI/agent process ⇄ sandbox network/filesystem; remote integrations and MCP tools add boundaries.

**Attackers or failure sources:** malicious/untrusted repository, prompt injection through files/tool output, compromised MCP server, malicious agent-produced instructions, unauthorized local process, path confusion or symlink traversal, accidental operator action, overly broad mounts, vulnerable dependencies, command injection and task-concurrency races.

## 4. Secure CLI and IPC execution

- Only Rust Core can invoke approved SBX/Git subprocesses; webview cannot run shell commands.
- Use fixed executable + argument vector. Never `sh -c` / `cmd /c` with interpolated untrusted input.
- Strict type validation for sandbox names, project paths, Git refs, port mappings and network destinations.
- Canonicalize and validate workspace roots before reading/applying file operations; account for symlinks and time-of-check/time-of-use issues.
- Ensure project context from remote IDE hosts isn't misinterpreted as a local path.
- Pin or verify binaries launched from user overrides; never silently trust repository-local `sbx` executables or executable files named by an agent.
- Use per-user socket permission or Windows pipe ACL; handshake version and authorized client identity as appropriate.
- Limit IPC method access by capability where useful; destructive actions require confirmations and server-side validation even if UI already confirmed.
- Bound stdin/stdout/events and enforce timeouts. Capture process trees and cleanup without killing unrelated processes.
- No unauthenticated localhost TCP admin endpoint; no cloud listener in local-first baseline.

## 5. Credentials, privacy and context

- Keep Docker authentication in Docker-supported stores/flows, agent authentication in provider-supported flows, and Sandpane-only secrets in OS credential storage if unavoidable.
- Store only *presence* and nonsecret metadata about SBX secrets; avoid displaying existing values.
- Never import credentials from private ChatGPT/Claude Desktop installation files.
- Default chat transcripts and project metadata to local storage. Document retention, export and delete options.
- Redact tokens, `Authorization` headers, `.env` values, SSH keys and private URLs from telemetry, diagnostics and streamed logs when possible; note that redaction is best-effort and users must review exports.
- Require explicit approval for adding entire directories or files to agent context; size cap and deny sensitive paths by default.
- Scan/project-instruction summaries are **untrusted context**, not system authorization. Treat prompts from README or tools as potentially hostile instructions.
- Do not send source code to a Sandpane-owned server; no default product telemetry.

## 6. Filesystem and Git safety

### Default workspace decision

Use task-isolated Git clone/worktree execution wherever practical. In direct mount mode, the host is writable immediately and must carry a prominent warning.

### Before executing an agent task

- Check repository identity, base commit, current branch, dirty status and intended workspace mode.
- Snapshot metadata, *not automatically sensitive contents*.
- Allocate a unique branch/worktree/sandbox binding for independent writable tasks.
- Reject attempts to bind two simultaneous writer tasks to one directory unless user explicitly resolves conflict.
- Keep untracked files and secrets out of patches by default; ask before including them.

### Before integrating changes

- Re-check host branch and dirty state against recorded base.
- Generate actual diff including new/deleted/renamed files.
- Support no-overwrite conflict handling. Abort cleanly on changed base or unresolved conflict.
- Require explicit user approval of merge/cherry-pick/patch/commit.
- Preserve task artifacts and branch references until user decides to clean up.
- Deletion of isolated task environment is independent from deletion of a project/repository.

### Sandbox security nuance

Clone-mode isolation prevents direct writes to the host working tree but must not be described as total secret isolation. Host mounts and copied repos may expose sensitive/untracked data. Explain what can be read and written in the selected mode.

## 7. Agent execution and MCP

- Each adapter must document its own auth flow, execution scope, tool permissions and approval semantics.
- Never assume all agents support interactive approvals; some sandbox workflows may operate with elevated or bypassed agent approvals.
- Show true privileges and ask for consent before starting high-impact tasks.
- MCP registration must explain command/server address and execution origin (host vs sandbox), credential scope and network targets.
- Treat MCP responses and tool outputs as untrusted data; do not authorize management commands by parsing chat text.
- Limit automatically launched subprocess count and agent retry loops.
- Allow user cancellation; log actual outcome and warn if files may already have changed.

## 8. Network, ports, remote access

- Default locally published services to loopback (localhost) when supported.
- Require deliberate confirmation before exposing network ports publicly.
- Show effective network policy rather than assume a requested rule took effect.
- Display actual blocked destinations from supported SBX policy logs where available.
- Use documented SSH configuration flow; test connection without storing host private keys in Sandpane database.
- Warn about app-specific credential forwarding (notably native Claude Desktop SSH workflow as documented by Docker).
- Do not use SSH to bypass SBX isolation restrictions.

## 9. Logging, updates, distribution

- Logs have bounded size and retention, timestamps, correlation IDs, and user-controlled export.
- Avoid exposing full prompt content or sensitive file contents in routine logs.
- Security policy with vulnerability disclosure instructions and dependency audits.
- Signed reproducible release artifacts where feasible, plus checksums and provenance.
- Updates must not interrupt active agent processes; handle service upgrades with handshake and maintenance mode.
- Client binaries and Core updates need tested rollback/migration strategy.
- Disable cloud operations by default; require subscription/billing acknowledgment if later introduced.

## 10. Security acceptance gate

- [ ] No shell injection from sandbox name, chat text, branch name, filenames or URL.
- [ ] Same-user IPC boundary enforced on all supported OSes.
- [ ] Unauthorized process cannot invoke delete/merge via exposed webview.
- [ ] Multiple clients cannot accidentally issue duplicate create/start tasks after reconnect.
- [ ] Dirty host changes remain intact after task integration attempt.
- [ ] Network ports never become publicly exposed unintentionally.
- [ ] Diagnostic export reviewed for secret redaction.
- [ ] Prompt injection in repository instructions cannot turn chat content into Core admin permission.
- [ ] Secrets are not mirrored into plaintext configuration/history by default.
- [ ] Destructive operations remain server-validated and explicitly confirmed.
- [ ] Docker/legal/third-party redistribution release approvals documented.

## 11. Primary references

- https://www.docker.com/legal/docker-subscription-service-agreement/
- https://docs.docker.com/reference/cli/sbx/
- https://docs.docker.com/ai/sandboxes/security/
- https://docs.docker.com/ai/sandboxes/integrations/
- https://code.visualstudio.com/api/extension-guides/webview
- https://plugins.jetbrains.com/docs/intellij/welcome.html
