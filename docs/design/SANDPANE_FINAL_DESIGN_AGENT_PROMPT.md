# Sandpane Desktop — Final UI/UX Design Implementation Prompt

**Use this only after Sandpane Desktop is functionally complete.** Copy the prompt below into a coding agent attached to your actual Sandpane repository. Place the companion `SANDPANE_DESKTOP_DESIGN_SPEC_AND_FINAL_PROMPT.md` in `docs/design/` so the agent can inspect the visual/UX contract.

This prompt requests a real UI implementation and performance audit, **not** a generated mockup.

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
