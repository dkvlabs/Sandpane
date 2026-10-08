# Sandpane Desktop — Cinematic, Lightweight UX Design Specification

**Publisher:** DKV Labs  
**Product:** Sandpane Desktop  
**Design deliverable:** UI/UX specification + end-of-project implementation prompt  
**Target:** Tauri 2 + React + TypeScript + Tailwind CSS + shadcn/ui  
**Platforms:** macOS, Windows, Linux where Sandpane/SBX prerequisites are supported  
**Companion documents:** `05_DESKTOP_APP.md`, `01_MASTER_PLAN.md`, `02_ARCHITECTURE_AND_DATA.md`  
**Important:** Run the implementation prompt in **Section 17 only after the application's workflows are functional**. This file is the final visual polish contract; it does not replace the implementation roadmap.

---

## 1. Product design thesis

**Design Sandpane like a precision instrument for AI-assisted development, not a marketing landing page or a terminal emulator.**

Mood: **cinematic restraint** — quiet depth, editorial typography, subtle atmospheric lighting, tactile layering, precise motion. Inspiration keywords: *Linear's clarity × a premium film color grade × native developer-tool efficiency*. Do not clone any product's exact UI.

The interface should feel premium on first open **and remain calm during 8-hour development sessions**. Never let spectacle interfere with code, diffs, chat, or accessibility.

**Core promise:** A developer can switch projects, manage sandboxes, talk to multiple agents, review Git changes, and recover a session without leaving one coherent workspace.

### Design non-negotiables

1. **Function first.** Preserve every implemented capability and real data flow; do not replace working features with decorative demos.
2. **No terminal-first UX.** Chat, task activity, changes, ports and policies have graphical views. Advanced terminal access can live behind an explicit action.
3. **Performance first.** No Three.js, WebGL, continuously animated particles, video backgrounds, animated noise layers, canvas render loops, or scroll-animation frameworks.
4. **Cinematic by composition.** Depth comes from color, layering, shape, light gradients, and short purposeful transitions — not expensive effects.
5. **Local-first.** No remote fonts, icon CDNs, tracking pixels or analytics introduced by the design work.
6. **Honest state.** Running, failed, queued, offline, unknown, blocked and approval-required states come from actual application state; never simulate success.
7. **Keyboard-friendly.** Every primary action is accessible without a mouse and is usable with reduced motion.
8. **One design system.** All screens, dialogs, popovers, task states and settings use a small consistent token/component set.

## 2. User personas & top jobs

| Persona | Goal | UX requirement |
|---|---|---|
| Solo developer with many products | Work across 3–10 projects without losing conversations | Persistent project rail, tabs, global activity |
| AI-heavy developer | Run Codex/Claude/OpenCode where supported | Agent capability visibility, streaming chat, quick context controls |
| Safety-conscious engineer | Keep AI changes separate until reviewed | Prominent isolation badge, actual Git diff, explicit Apply |
| New SBX user | Create a sandbox without knowing CLI syntax | Guided Quick Create, contextual help, clear prerequisites |
| Advanced developer | Manage MCP, network, templates, ports, credentials | Advanced Inspector and resource management, not in the primary flow |

### Design success checks

- Returning developer reaches an active conversation in **at most 2 direct interactions** from the project dashboard.
- A new user can create a basic sandbox via **Project → Agent → Isolation → Review → Create** without seeing a CLI flag.
- Every active task visibly identifies **project, conversation, agent, sandbox, Git branch/workspace mode, and state**.
- Opening a second chat never implies the first task stopped.
- Destructive and potentially billable operations show their actual consequences before confirmation.

## 3. Information architecture

### App-level navigation

A compact **icon rail** for top-level destinations and a contextual **project/conversation sidebar**. The central workspace changes by destination; an optional **inspector** opens on the right.

**Icon rail destinations:** Home, Projects, Tasks/Activity, Sandboxes, Integrations, Settings. Labels appear in tooltips and/or expanded navigation; do not rely on icon meaning alone.

**Project sidebar:** Pinned projects, recent projects, nested conversations, active task status, `+ New Chat`. Project/repository group nesting should never exceed two visible levels by default.

**Main workspace:** Chat or overview with top tabs, task context toolbar, and a persistent composer on chat screens.

**Right inspector:** Changes, Tests, Context, Preview, Environment, Network (context-specific tabs). Closed by default on smaller windows.

**Global command/search:** One command palette for projects, chats, sandboxes and actions. Should work offline against locally indexed metadata.

### Desktop composition (reference, not pixel-perfect)

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Sandpane  Project / Workspace          ⌕ Quick switch                  ◉ Connected │
├────┬──────────────────┬───────────────────────────────────┬────────────────────────┤
│    │                  │ [Auth] [Search] [+]                 │ Changes / Tests        │
│ ⌂  │ WORKSPACES       │                                   │                        │
│ ◫  │ ▾ Atlas Demo       │ Authentication flow               │ 4 files changed        │
│ ⇄  │   ● Auth         │ Codex · auth-sbx · Isolated clone  │ ✓ lint     ✓ tests      │
│ ▦  │   ◦ Payments     │                                   │                        │
│ ◇  │ ▾ Nova Demo   │ You: Implement JWT authentication │ src/auth.ts    +42 -8   │
│ ⚙  │   ◦ Indexer      │                                   │ tests/auth.ts +68 -0   │
│    │                  │ Agent activity                    │                        │
│    │ + New project    │ ✓ Read project instructions        │ [ Review diff ]        │
│    │                  │ ✓ Updated authentication service   │                        │
│    │                  │ ● Running verification...          │                        │
│    │                  │                                   │                        │
│    │                  │ [ Add context ] [ Write message… ]│                        │
├────┴──────────────────┴───────────────────────────────────┴────────────────────────┤
│ ● Core connected   2 running  · 1 needs review                   ⌘K  Quick switch │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Sizing guidance** (adapt instead of forcing fixed widths): icon rail 56–64 px; project sidebar 228–264 px; inspector 280–340 px; chat content readable at 600–820 px; central container grows or constrains intelligently. At widths below roughly 1,100 px hide inspector by default; at narrower widths allow sidebar collapse and keep chat/composer usable. Design for 900×650 and 1280×800 minimum testing states, plus 1440×900 and 1920×1080. Avoid app-level horizontal scrolling.

## 4. Visual direction — “Obsidian Atmosphere”

### 4.1 Color palette

Primary theme is dark, with a light alternative using the *same semantic tokens*. The dark theme is cinematic but **not pure-black neon cyberpunk**.

| Token | Dark reference | Purpose |
|---|---|---|
| `--canvas` | `#0A0E13` | Main app background |
| `--rail` | `#0C1117` | Navigation rail |
| `--surface-1` | `#111820` | Primary panels |
| `--surface-2` | `#16212A` | Raised surfaces, selected cards |
| `--surface-3` | `#1D2A34` | Hover/active layered controls |
| `--line` | `#26343F` | Borders/dividers |
| `--text-strong` | `#EBF2F5` | Primary content |
| `--text-muted` | `#95A4AF` | Secondary content |
| `--text-subtle` | `#6F8291` | Meta labels (check contrast) |
| `--accent` | `#8DDACE` | Primary action and focus |
| `--accent-ink` | `#09211F` | Text on accent background |
| `--accent-quiet` | `#163731` | Restrained selection tint |
| `--success` | `#9BD5AF` | Verified success |
| `--attention` | `#E6BA7C` | Needs review / approval |
| `--danger` | `#EF978F` | Destructive / failure |
| `--info` | `#91B8E6` | Passive informational state |

**Semantic rules:** Status colors appear as small dots, pills, icons, or purposeful inline text — never as giant glowing sections. The primary accent is limited to primary actions, focus rings, active tab affordances, and selected items.

### 4.2 Atmospheric light

Use **one subtle, static radial gradient** at the edge of major home/empty-state views. Example: a dark blue/teal pool of light behind the upper-right workspace area at low alpha. Avoid fixed full-window blurred layers and never animate gradient stops, background-position, hue rotations, or shadows continuously.

For work-oriented views (chat, tests, diff, code), reduce the atmosphere further; preserve contrast and readability.

### 4.3 Typography

- Default: **system UI font stack** (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Inter` only if already locally bundled, `sans-serif`). Do not fetch a remote font.
- Monospace: system mono stack for paths, identifiers, code, logs, keyboard shortcuts.
- Display: 26–30 px / semibold, limited to dashboard header and welcome screens.
- Screen headers: 19–22 px / semibold.
- Primary UI: 13–14 px; chat prose 14–15 px, line height 1.55–1.65.
- Labels/meta: 11–12 px only where legible; accessibility must take precedence over density.
- Avoid widespread ultra-light/thin weights; use high-contrast regular and semibold.

### 4.4 Shape and spacing

- 4 px spacing baseline; most panel padding 16–24 px.
- Radii: 8 px controls, 12 px cards, 16 px dialog and featured empty-state panel.
- Borders: subtle 1 px lines, not large shadows.
- Elevation: 0/1/2 levels using surface tones and thin borders; overlays can use a restrained shadow.
- Icon system: local Lucide icons, consistent 16–18 px default; 20 px for top-level rail.
- Tooltips should teach advanced functions, not replace labels required for understanding.

### 4.5 Light theme

Create a high-quality light theme, not an inverted filter. Use warm pale gray backgrounds, dark slate text, calmer teal accent, visible dividers and accessible status indicators. Auto-detect the OS preference and persist the user's override.

## 5. Interaction & motion specification

**Cinematic = precise and quiet.** All transitions must communicate hierarchy, state changes, or success/failure.

| Interaction | Recommended motion | Duration |
|---|---|---|
| Screen content entrance | Opacity + translateY 4–8 px on newly navigated region | 160–220 ms |
| Dialog / command palette | Opacity + scale 0.985 → 1 | 140–190 ms |
| Inspector open/close | Width/layout shift or transform, no content jump | 180–240 ms |
| Hover/focus states | Background/border-color interpolation | 100–150 ms |
| Task status update | Dot/icon and text replace, no looping animation | Immediate / ≤120 ms |
| Successful task | One-time micro-confirmation, then static | ≤240 ms |
| Chat streaming | Plain text/event append; **no character-by-character animated reveal** | Event driven |
| Loading | Static skeleton or determinate progress; no infinite shimmer | Until load |

**Never:** parallax scroll, autoplay video, recurring pulse on every running sandbox, looping hero animation, large blurred glass panes, scroll hijacking, forced smooth scrolling, heavy page transitions or background rendering while window unfocused.

**Reduced motion:** `prefers-reduced-motion: reduce` disables content motion; preserve instant state changes and focus visibility.

## 6. Screen-by-screen UI specification

### S00 — First-run onboarding

**Goal:** Make prerequisites obvious, eliminate terminal anxiety.

- Minimal welcome view with Sandpane symbol, one-sentence value proposition, `Start setup` primary CTA.
- 3 checks: Sandpane Core, Docker SBX/daemon, agent availability (per-capability—not a fictional universal check).
- Status: installed / needs setup / unsupported version / permission issue / unknown.
- Links to official installation and authentication instructions; **do not silently install Docker or import credentials**.
- Optional `Use sample UI tour` for presentation only, clearly labeled and disconnected from real operations.
- One action to retry checks.

### S01 — Home / Global Overview

**Goal:** Resume work quickly.

- Header: *Good to see you back* is optional; prefer user-neutral `Your workspace`.
- Top row: `Continue last conversation`, `Create sandbox`, `New task`.
- Three meaningful counts: Running, Waiting for review, Queued (click to filter tasks).
- Recent project cards with last chat, agent, sandbox state, Git branch/workspace mode.
- Global activity list with human-readable actions and timestamp.
- A single artistic focal point only in the welcome/empty state: abstract geometric arch/rift linework using lightweight static SVG (suggests isolation), **not** an animated 3D background.

### S02 — Project Cockpit

**Goal:** One place for a project with several repositories and chats.

- Name, repo count, workspace locations, active sandbox count.
- Conversation tabs or list; tasks grouped by status; recent Git changes.
- `New Chat`, `New Isolated Task`, `Open in IDE`, `Preview` (as supported).
- Context/profile view with project rules, test commands and explicit sources.
- Sticky project switcher; switching projects must preserve other sessions.
- For multi-repo projects, display repo identity per task, not just the project name.

### S03 — Multi-chat Coding Workspace (signature screen)

**Goal:** Copilot-style clarity with multi-chat and explicit isolation.

- Tab bar with unread/update badge, task state, close-tab action that **does not** cancel the task.
- Header: conversation title; agent + model if supported; sandbox; branch; `Isolated clone`/`Direct mount` tag; exact task status.
- Main area: human/agent messages with streaming text, code blocks, collapsible tool activity, file references, errors, approval cards.
- Agent activity displayed as a **compact timeline**, not a raw console dump.
- Right inspector optional: Changes / Tests / Context / Preview / Environment.
- Bottom anchored composer: attach file/context, selected agent, send, stop; clear disabled states if disconnected.
- Only the currently visible chat renders full message DOM; other tabs retain state through Core and local cache.
- Conflicting write tasks show a visible warning with a recommended isolated workflow.

### S04 — Create Sandbox Wizard

**Goal:** Quick, predictable creation; advanced settings remain available.

- **Quick mode**: Project/workspace → Agent → Isolation → Review → Create.
- Recommended isolation: clone for writable tasks, with a concise explanation of the tradeoff.
- Advanced accordion: mounts, resource configuration, templates, network restrictions, environment settings, only if supported by installed SBX.
- Inline field validation; detect duplicate names; show paths clearly.
- Review page lists effective settings and warns about direct mounts and credential exposure.
- Progress displays actual CLI stages; a failed stage shows a retryable action and real error.

### S05 — Sandboxes Library + Detail

- Table/list with name, linked project, agent, status, workspace mode, age/last activity as available.
- Row actions: Open, Start, Stop, Inspect, Delete (confirm destructive).
- Filters: Running/Stopped/Needs attention; quick search.
- Detail view: Overview, Network, Ports, Templates, MCP, Secrets presence, Diagnostics where capabilities exist.
- On daemon disconnect, retain cached last-known info with unmistakable `Offline — last updated…` label. Never show cached status as live.

### S06 — Tasks & Global Activity

- Running, Waiting, Queued, Completed, Failed filters.
- Each task card includes linked project, chat, sandbox, agent, task duration, branch/worktree mode, review state.
- Clearly distinguish `Paused (if supported)` vs `Cancelled`, `Interrupted`, `Queued`.
- Actions: Open chat, Cancel, Review, Retry (only when semantically valid).
- Concurrency limit controls in settings, not noisy toolbar widgets.

### S07 — Git Changes / Review

- Split view: file tree on left; side-by-side/unified diff in center; test/checklist on right or bottom.
- Clear branch/base commit, added/deleted/renamed files, untracked changes and conflicts.
- `Review changes`, `Apply selected changes`, `Discard task changes`; application requires explicit review and confirmation.
- Display banner for direct-mounted tasks: **Files may already be modified on the host.**
- If task output is an isolated clone, show `Not yet applied to your working tree` only after verifying it.
- Never show an invented successful test count; verification state comes from Core.

### S08 — Agent & MCP Center

- Supported agents list with installed/auth/status/capability.
- Agent selector only shows models or actions when adapter supports them.
- MCP list, add/connect/auth/config operations based on documented commands.
- Show warnings for sensitive scopes, URLs, secrets and permissions.
- Allow shortcuts for environment presets without exposing raw JSON by default.

### S09 — Connections

- Cards for ChatGPT Desktop, Claude Desktop, VS Code, Cursor and supported IDE paths.
- Connection wizard: prerequisites → SSH setup/verification → host info → platform-specific app instructions.
- Status reports *configured / ready for manual step / unavailable* without claiming unsupported one-click connection.
- Native app conversations remain owned by native apps; Sandpane does not ingest them.

### S10 — Preferences & Diagnostics

- Appearance: dark/light/system, motion toggle honoring OS setting, density: Comfortable/Compact.
- Workspace: startup view, default isolation, active task behavior on window close.
- Performance: max visible event entries, event update batching, concurrency controls.
- Privacy/security: telemetry off, no automatic secret collection, diagnostic redaction, confirm-destructive-actions.
- Runtime: Core/SBX version + state, supported capabilities, redacted logs and troubleshooting.

## 7. Universal components (build these before screen polish)

- `AppShell`, `IconRail`, `ProjectSidebar`, `TopBar`, `StatusBar`
- `ProjectSwitcher`, `CommandPalette`, `Tabs`, `WorkspaceHeader`
- `SandboxStatusBadge`, `AgentBadge`, `IsolationBadge`, `BranchBadge`
- `ChatMessage`, `ChatComposer`, `ActivityTimeline`, `ToolEventDisclosure`
- `TaskCard`, `ApprovalCard`, `ErrorCard`, `EmptyState`, `ConnectionState`
- `InspectorPanel`, `ChangesTree`, `DiffViewer`, `VerificationSummary`
- `SandboxWizard`, `CapabilityGuard`, `ConfirmDestructiveDialog`, `Toast`
- `McpConnectionCard`, `NativeAppConnectionCard`, `SettingsSection`

Only generalize repeated components. Avoid creating a complex design framework before two real screens demonstrate the pattern.

## 8. Copywriting / microcopy rules

- Buttons state verbs: `Create sandbox`, `Review changes`, `Open preview`, `Stop task`.
- Explain technical concepts once, in short contextual help: `Clone mode keeps task edits separate from your working tree.`
- Avoid vague statuses such as `Working…` when a real stage exists; use `Preparing sandbox`, `Running tests`, `Awaiting review`.
- Errors contain **what failed**, **the verified reason if known**, and **what the user can do**.
- Distinguish `Disconnect` from `Stop` and `Close tab` from `Cancel task`.
- Use `Not supported by this SBX version` rather than a dead control.
- Example content in mockups must be marked as sample data; the implemented app must connect to real state.

## 9. Responsiveness and resizing

Desktop widths vary when snapped/tiled. Required adaptive behavior:

- **≥ 1440 px:** icon rail + project sidebar + chat + optional inspector.
- **1100–1439 px:** inspector initially hidden; user can toggle it as an overlay/drawer or resize.
- **900–1099 px:** sidebar collapsible; readable chat width; no clipped composer.
- **< 900 px:** simplified navigation and content area; use overflow menus for secondary actions.
- Preserve user-resized panel widths locally where feasible and clamp to safe ranges.
- Minimum practical target: app still navigable at 900×650. Any smaller supported window must degrade gracefully with no page-wide horizontal scrolling.

## 10. Accessibility

- Meet **WCAG 2.2 AA** for contrast, keyboard navigation, focus visibility and touch targets as applicable to desktop.
- Primary controls provide text labels or accessible names; decorative icons hidden from screen readers.
- Proper semantic controls: `<button>`, `<nav>`, tabs, dialogs, input labels, status updates.
- Screen-reader announcements for task status changes, but throttle streaming status messages.
- Keyboard interaction: Ctrl/Cmd+K global switcher; Ctrl/Cmd+Enter sends where safe; Escape closes overlays; normal Tab order for all operations. Do not hijack IDE/global shortcuts unnecessarily.
- Support OS text scaling and user font size changes without clipping the chat composer or diffs.
- `prefers-reduced-motion` disables animation, including decorative transitions.

## 11. Memory, CPU & GPU performance contract

**Important:** SBX sandboxes, local development servers and AI agent processes can consume significant memory independently of Sandpane. Measure **desktop UI**, **Sandpane Core**, and **SBX/agents** separately. Never promise total system memory usage based solely on Tauri UI measurements.

### Hard engineering practices

- Avoid React re-renders for every streaming token. **Batch updates** approximately every 50–100 ms while text is arriving; flush immediately on task completion or errors.
- **Virtualize** long chat history, activity and project lists; only mount visible conversation content.
- Use **incremental event replay** from Core, not whole-conversation fetch on every UI update.
- Cancel subscriptions on view disposal; one subscription per active stream in owning layer.
- Limit syntax highlighting for huge code blocks; progressively render or collapse them.
- Lazy-load feature routes and heavy editor/diff modules.
- Cache data with bounds; explicitly evict old inactive view data instead of retaining every DOM tree.
- Use icon SVGs; avoid runtime icon-font downloads and heavyweight imagery.
- No canvases, WebGL, animated background videos, continuous `requestAnimationFrame` loops, or background polling faster than actual needs.
- Prefer Core push events to 1-second polling. Poll only for data where necessary, adaptive to visibility/activity.
- Reduce or stop unnecessary subscriptions/timers when window is hidden/minimized.
- Use native Tauri dialogs and OS integrations; avoid bundling another large runtime.
- Do not preload all sandboxes' logs/metrics; load on demand.
- Be conservative with markdown renderer plugins, syntax grammars, webview dependencies and rich text editors.

### Measurable targets (aspirational, benchmark hardware must be documented)

| Measure | Target / pass condition |
|---|---|
| Idle UI CPU (settled, no active animations) | Aim ≤ 1% average on reference developer hardware; document OS differences |
| Persistent idle animation | **0** background render loops, 0 animated video/webgl scenes |
| Navigation responsiveness | Typical interaction response under 100 ms; visible feedback immediate |
| Animation smoothness | Aim 60 fps on reference hardware for brief transitions; do not block input |
| Idle desktop shell memory | Aim ~150–250 MB on reference environment where feasible, **not guaranteed across WebView2/WebKit/Linux**; separately report Core and sandboxes |
| Memory retention | No steady upward growth after repeatedly opening/closing 30 chats and 1000+ events |
| Long-running streaming | 60-minute task stream remains responsive and does not create unbounded DOM growth |
| Startup | Useful shell quickly, nonblocking prerequisites; measure cold and warm start, never invent benchmark claims |
| Hidden/minimized | No purely decorative animation or expensive view updates |

### Benchmark protocol

1. Record OS, CPU, RAM, Tauri/WebView version, device resolution and power mode.
2. Measure clean cold start and settled idle after ~60 seconds.
3. Record memory for **UI process**, **Core**, and **sandbox/agent processes** separately.
4. Open 10 projects, 30 chat tabs, and a conversation with 2,000+ events; measure browsing and memory retention.
5. Start two real concurrent agents, stream and switch tabs repeatedly; check no duplicated events or extra subprocesses.
6. Open and close inspector 100 times; inspect frame timeline for long tasks and render spikes.
7. Minimize for 5 minutes; confirm UI has no continuous animation/CPU churn.
8. Repeat with reduced motion and light theme.
9. Save reproducible before/after benchmark notes and screenshots.
10. If target cannot be met, record why and optimize measured hot paths; never claim a target was achieved without profiling.

## 12. Light-touch implementation mapping

The end-of-project design pass must work with **the actual repository structure**, not force a new architecture. The following paths are illustrative:

```text
apps/desktop/src/
├── app/                 # shell/router/providers
├── styles/
│   ├── tokens.css       # semantic design tokens
│   └── motion.css       # very short motion, reduced-motion override
├── components/
│   ├── layout/          # rail, sidebar, tabs, status
│   ├── ui/              # shadcn-based base primitives
│   ├── chat/            # message, composer, activity
│   ├── tasks/           # task states, approvals
│   └── review/          # diffs and verification
├── features/             # existing feature modules, enhanced not rewritten
└── lib/                  # existing core clients/hooks
```

Use shadcn/ui components already in the project; avoid adding a second UI framework. Use CSS variables for all semantic tokens. Keep the styling layer independent of Rust service business logic.

## 13. Empty, error and edge states

The final design must explicitly style:

- First run, no SBX installed, incompatible SBX version, daemon offline, missing Core, missing agent.
- No projects, no chats, no tasks, no sandboxes, empty Git diff.
- Loading/refreshing, queueing, reconnecting, expired provider authentication.
- Task running, waiting for input, waiting review, completed, failed, cancelled, interrupted.
- Partial stream replay after reconnect, agent adapter unsupported feature.
- Clone/worktree conflict, failed merge, untracked file warnings.
- Huge logs and long file paths; wrap/truncate with accessible full-text affordance.
- Deleted sandbox linked to an archived conversation; history remains but execution unavailable.
- Sandpane Core local service restarts while two UI windows are connected.

**No fake success states or fabricated test results.**

## 14. Design-review acceptance checklist

- [ ] Existing desktop workflows still work after styling, including real Core/SBX actions.
- [ ] Project switcher is visible, fast, and understandable.
- [ ] Multiple chats and different task states remain distinct.
- [ ] Current sandbox, agent, branch and isolation mode are discoverable within one glance.
- [ ] A user can review changes without discovering a hidden terminal.
- [ ] One consistent dark/light theme and token system across all routes.
- [ ] Cinematic effect exists mostly in welcome/dashboard, not dense work areas.
- [ ] No WebGL, Three.js, GSAP, Lenis, video or continuous background animations added.
- [ ] Resizable panels behave at 900, 1100, 1440, and 1920 px widths.
- [ ] 30-tab/2,000-event scenarios do not produce unbounded DOM or obvious memory leaks.
- [ ] Keyboard, reduced motion and status feedback work.
- [ ] Destructive actions and security boundaries remain explicit.
- [ ] Before/after screenshots and a performance audit are included in the design pass.

## 15. Deliverables expected from the final design pass

1. Updated standalone desktop frontend (functional implementation, not static screenshots).
2. Design tokens with dark/light themes and density rules.
3. Shared navigation, workspace, chat, task, sandbox and inspector components.
4. Cohesive loading, empty, error and confirmation states.
5. Responsive window layout and keyboard shortcuts.
6. Subtle motion with reduced-motion support.
7. A screenshot set: first run, dashboard, project cockpit, chat, task review, sandbox wizard, sandboxes, settings; include compact-window view.
8. Accessibility findings and fixes.
9. Memory/CPU/GPU profiling notes with methodology, actual readings and remaining issues.
10. Test/build results and a summary of changed files.

## 16. Reference moodboard in words

- Deep midnight slate like an unlit cinema auditorium.
- The slight teal-grey reflection of a monitor on brushed graphite.
- Fine architectural lines and disciplined proportions.
- Clear typographic hierarchy, generous breathing space around *important* actions.
- One soft luminous horizon on the home view, never a distracting animated backdrop.
- Quiet, confidence-building status indicators: `Running`, `Ready for review`, `Isolated`, `Connected`.
- Accent used with the precision of a laser pointer, not sprayed across the UI.

**Avoid:** over-glossy glassmorphism, generic glowing SaaS dashboards, large marketing copy, fake metrics, animated stars/particles, neon everywhere, permanent motion, oversized gradients behind code, tiny low-contrast labels.

---

# 17. COPY-PASTE FINAL IMPLEMENTATION PROMPT

> **Use only when Sandpane Desktop's core features are complete and working.** Paste this entire prompt into Codex / Claude Code / another coding agent working in the actual Sandpane repository. Provide this Markdown file in the project's docs and reference it by its path. The agent should implement the design, not merely generate mockups.

```text
ROLE
You are the principal desktop product designer, UI engineer, accessibility specialist, and frontend performance engineer for Sandpane, an open-source DKV Labs AI coding workspace built with Tauri 2, React, TypeScript, Tailwind CSS, and shadcn/ui.

MISSION
Perform the FINAL DESIGN AND UX POLISH PASS on the existing, already functional standalone Sandpane Desktop application. Make it feel cinematic, elegant, highly usable, fast, and native to the desktop. Preserve every working feature, backend contract, sandbox operation, project/session behavior, Git-safe review flow, and agent integration. This is not a reimplementation or a static demo.

MANDATORY REFERENCE
Read the repository's Sandpane Desktop design specification, especially SANDPANE_DESKTOP_DESIGN_SPEC_AND_FINAL_PROMPT.md, Sections 1–16. Also read the existing master plan, architecture, and desktop implementation specification if present. The actual source code and working API contracts take precedence over example paths and mockup data.

PHASE 0 — AUDIT BEFORE CHANGES
1. Inspect the existing Tauri desktop application, route structure, React components, styling, shadcn primitives, state management, Core service client, task/chat streams, and build/test scripts.
2. Enumerate every existing desktop screen, dialog, task state, feature flag, and important workflow. Produce a screen/feature inventory before editing.
3. Identify visual inconsistencies, navigation friction, accessibility problems, CPU hotspots, excessive subscriptions, memory-retaining components, and render bottlenecks.
4. Record which workflows are real, which are incomplete, and which rely on SBX/agent capabilities. Do not fabricate support for missing features.
5. Preserve the current data model, RPC event contracts, task lifecycle, and security checks. Do not rewrite Rust Core architecture or change API behavior unless a demonstrated UI correctness defect requires a narrow fix.

DEMO DATA AND PRIVACY
- All public screenshots, mockups, tutorials, fixtures, seed data, and example UI screens must use fictional project names: Atlas Demo, Nova Demo, and Orbit Demo.
- Example sandbox names should be `atlas-auth`, `nova-search`, and `orbit-web` (or similarly generic test identifiers).
- Never expose private or real project names from development machines in screenshots, README examples, presentations, or distributable sample assets.
- Do not rename, hide, or alter a user's actual saved projects: these rules apply ONLY to demo/fixture/public-facing sample data. Real project labels must display normally inside the real application to their owner.

VISUAL DIRECTION — OBSIDIAN ATMOSPHERE
- Cinematic restraint: deep graphite/slate, layered surfaces, precise 1px borders, muted teal accent, subtle static light gradient only on dashboard/empty state, strong typography.
- Use semantic CSS variables for dark/light theme; implement system theme and user override.
- Use local/system fonts and local SVG icons (prefer existing Lucide dependency).
- Premium spacing and density without giant cards or excessive whitespace in work views.
- Motion uses only short purposeful opacity/transform/color transitions. Respect reduced motion.
- Absolutely no Three.js, WebGL, canvas particle effects, Lenis, GSAP, autoplay video, animated noise, backdrop-heavy glassmorphism, remote fonts, or perpetual requestAnimationFrame animation loops.
- Retain normal native window chrome unless a custom titlebar demonstrably improves usability without breaking macOS/Windows/Linux drag regions, system buttons, or accessibility.

UX STRUCTURE
Build/refine these experiences using EXISTING working routes and state:
A. Global app shell: compact icon rail, contextual project/chat sidebar, top search/command switcher, main workspace, optional inspector, compact connection/task status line.
B. First-run and runtime readiness: real Core/SBX/agent checks, setup guidance, honest offline/unsupported states.
C. Home and Project Cockpit: recent projects, active tasks, conversations, quick-create actions, repo grouping.
D. Multi-chat workspace: tabbed conversations, agent+sandbox+branch+isolation badges, streaming messages, collapsed tool activity, fixed composer, side inspector for changes/tests/context/preview.
E. Create Sandbox wizard: Quick and Advanced modes, capability gating, review step, explicit warnings for direct mounts and credentials.
F. Sandboxes and details: searchable list, lifecycle controls, network/ports/templates/MCP/secrets where supported.
G. Task activity and Git review: accurate task states, visible test results, actual diffs, conflict warnings, apply/discard confirmations.
H. Agent/MCP, native app Connections, Settings, and Diagnostics with real state.
I. All empty/loading/error/reconnecting/permission-required/unsupported states.

CRITICAL MULTI-PROJECT BEHAVIOR
- Preserve multiple projects and conversations. Switching tabs/projects must NOT stop active work.
- Closing a chat tab hides it; cancelling an agent task is a DIFFERENT, explicit action.
- A desktop UI restart must reconnect to persistent Core state and replay missed task events, not relaunch duplicate agents.
- Do not imply a restored UI transcript means the underlying agent process resumed if it did not.
- Surface direct-mount risk clearly; only call changes 'not yet applied' when they are actually isolated and verified.

IMPLEMENTATION RULES
1. Reuse existing React components and shadcn/ui primitives when possible. Establish a small token layer and shared shell components instead of a second design framework.
2. Make navigation, dialogs, keyboard shortcuts, tabs, status badges, details, and responsive layout work with the real data layer.
3. Do not introduce mock data, placeholder success states, dummy task events, hardcoded fake tests, or UI-only settings posing as saved preferences.
4. No unrelated refactor, architecture rewrite, new backend server, remote telemetry or account flow.
5. Maintain Git-safe review, auth/secret boundaries, explicit destructive confirmation, capability-gated SBX behavior and local-first design.
6. Keep dependencies minimal. If an existing dependency suffices, do not add another one.
7. Follow the OS's visual conventions where practical while keeping the Sandpane brand consistent.

PERFORMANCE IS A SHIP BLOCKER
- Distinguish memory owned by the Tauri UI, Sandpane Core and external SBX/agent processes.
- Virtualize long conversation/task/event lists. Lazy-load routes and heavy diffs.
- Batch streaming updates ~50–100 ms instead of re-rendering entire chat on every token.
- Unsubscribe from streams and remove listeners when no longer needed.
- Use Core events instead of frequent polling whenever available; avoid updates when window is hidden.
- No perpetual animation loops or expensive large-area backdrop filters.
- Measure settled idle CPU, UI memory, navigation responsiveness, chat scrolling/streaming, and memory retention after 30 chat tab switches/2,000+ events on the actual runtime.
- Treat ~150–250 MB idle desktop shell memory as an aspirational reference-range target where feasible, not a universal guarantee; document hardware/WebView measurements and separately report Core and SBX memory.
- Fix measured leaks and obvious long tasks before considering the work complete.

ACCESSIBILITY
- Keyboard accessible navigation, clear focus ring, usable contrast, correctly labeled controls, proper tabs/dialog patterns, reduced motion, screen reader status updates throttled for chat streaming.
- Verify responsive states around 900x650, 1100x750, 1440x900 and 1920x1080. No clipped composer or app-wide horizontal scroll.

EXECUTION ORDER
1. Audit/inventory baseline screens and runtime performance.
2. Define tokens/theme and typography.
3. Refine global shell and navigation.
4. Refine project dashboard/cockpit and multi-chat experience.
5. Refine sandbox wizard/details and task/Git review.
6. Refine integrations/settings and edge states.
7. Add only minimal purposeful motion and responsive behavior.
8. Profile, optimize, test, and fix regressions.
9. Capture screenshots and provide final change/performance report.

QUALITY GATES / DEFINITION OF DONE
- All previously working desktop actions still function.
- No dummy functionality introduced.
- No heavy rendering/animation dependency added.
- Multiple concurrent agent sessions remain independent and recover correctly.
- Git changes and test status are accurate and reviewable.
- Reduced motion, accessibility, light theme and dark theme work.
- Real measurements and test results are reported; do not claim unexecuted checks passed.
- Existing tests/build/lint pass, or blockers are reported with exact details.
- Include screenshots of onboarding, home, multi-chat, sandbox creation, sandbox library, Git review, and settings (plus narrow layout).

DELIVER THE WORK
Modify the actual desktop app code and design tokens. Do not stop at a design description, screenshots, or a Figma mockup. Report exactly which files changed, which screens improved, what tests were actually run, measured performance before/after if available, and any remaining supported-interface limitations.
```

---

## 18. Using this document in the repo

Place this file at e.g. `docs/design/SANDPANE_DESKTOP_DESIGN_SPEC_AND_FINAL_PROMPT.md`. During feature development, use Sections 1–16 as guidelines, but **defer the full aesthetic redesign** until functionality is complete. At the end, run Section 17 with a coding agent in the working repository. Use the accompanying HTML reference mock only as a **visual north star**, never as authoritative app code or as proof that features are implemented.

**Reference:** Tauri 2 documentation: https://v2.tauri.app/ · VS Code and JetBrains capabilities belong in their respective plans. Docker SBX: https://docs.docker.com/reference/cli/sbx/
