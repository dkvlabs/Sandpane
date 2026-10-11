/**
 * Sandbox-create wizard state + client-side pre-validation.
 *
 * The checks below mirror `sandpane_core::validation` (docs/specs/06 §4) so the
 * form gives immediate feedback, but they are a UX convenience only: Core
 * validates every value again before it can reach a CLI argument vector, and the
 * authoritative verdict is always Core's `VALIDATION_FAILED`. This file never
 * builds a command, and never assumes a create succeeded — the review step says
 * what *will* be asked for, not what is running.
 */

import type { SandboxCreateSpec, SbxAgent, WorkspaceMode } from "./protocol";
import { DEFAULT_SBX_AGENT, WORKSPACE_MODES, isSbxAgent } from "./protocol";

export const SANDBOX_NAME_MAX = 63;

export type WizardStep = "project" | "agent" | "isolation" | "review";

/** Quick Create order from docs/specs/05 §3.B and design spec S04. */
export const QUICK_STEPS: readonly WizardStep[] = [
  "project",
  "agent",
  "isolation",
  "review",
];

export const STEP_TITLES: Record<WizardStep, string> = {
  project: "Project / workspace",
  agent: "Agent",
  isolation: "Isolation mode",
  review: "Review and create",
};

export interface WizardContext {
  /** Sandbox names already known to Core (duplicate detection). */
  existingSandboxNames: readonly string[];
  /** Agent ids with `verified: true` in `system.probe`. */
  verifiedAgentIds: readonly string[];
  /** Every agent id Core listed, verified or not. */
  knownAgentIds: readonly string[];
  /** Advanced settings are only offered after capability detection succeeds. */
  advancedAvailable: boolean;
  /**
   * Whether THIS Core honours `SandboxCreateSpec.agent` (A1). Absent/false: only
   * the default `shell` may be chosen, because a pre-A1 Core silently ignores
   * the key and would create a shell sandbox while the review claimed otherwise.
   */
  sbxAgentFieldAvailable?: boolean;
}

export interface SandboxDraft {
  name: string;
  projectId: string;
  agentId: string;
  /**
   * The built-in sbx agent the sandbox is created with (A1). Defaults to the
   * provider-free `shell`; only `SBX_AGENTS` members are ever sent. Distinct
   * from `agentId`, which is a Core adapter id from `system.probe`.
   */
  sbxAgent: SbxAgent;
  workspaceMode: WorkspaceMode | null;
  repoPath: string;
  step: WizardStep;
}

export function emptyDraft(): SandboxDraft {
  return {
    name: "",
    projectId: "",
    agentId: "",
    sbxAgent: DEFAULT_SBX_AGENT,
    workspaceMode: null,
    repoPath: "",
    step: "project",
  };
}

export type FieldErrors = Partial<
  Record<"name" | "projectId" | "agentId" | "sbxAgent" | "workspaceMode" | "repoPath", string>
>;

const NAME_ALLOWLIST = /^[a-z0-9-]+$/;

/**
 * Mirror of `Validator::sandbox_name`: a positive allowlist of lowercase ASCII
 * alphanumerics plus single hyphens, anchored at both ends, must start and end
 * alphanumeric, at most 63 chars, no `--`.
 *
 * Deliberately an allowlist and not a denylist: Core rejects every character
 * outside `[a-z0-9-]` — including non-ASCII letters and control characters that a
 * denylist of "shell metacharacters" would let through. A client check looser
 * than the server one would show a green field and then fail as
 * `VALIDATION_FAILED` on create.
 */
export function validateSandboxName(name: string): string | null {
  if (name.length === 0) return "Name is required.";
  if (name.length > SANDBOX_NAME_MAX) {
    return `Name must be at most ${SANDBOX_NAME_MAX} characters.`;
  }
  if (!NAME_ALLOWLIST.test(name)) {
    if (/[\u0000-\u001F\u007F]/.test(name)) {
      return "Name contains a control character.";
    }
    if (/[A-Z]/.test(name)) {
      return "Use lowercase letters, digits and single hyphens only — no spaces or shell characters.";
    }
    return "Use lowercase letters, digits and single hyphens only — no spaces, punctuation or non-ASCII characters.";
  }
  if (!/^[a-z0-9]/.test(name)) {
    return "Name must start with a letter or digit.";
  }
  if (!/[a-z0-9]$/.test(name)) {
    return "Name must end with a letter or digit.";
  }
  if (name.includes("--")) {
    return "Consecutive hyphens are not allowed (they look like CLI options).";
  }
  return null;
}

/** Modes whose semantics require a bound host repository path. */
export function modeRequiresRepoPath(mode: WorkspaceMode): boolean {
  return mode === "direct_mount" || mode === "host_worktree";
}

export function validateRepoPath(path: string, mode: WorkspaceMode | null): string | null {
  if (mode === null) return "Choose an isolation mode first.";
  if (modeRequiresRepoPath(mode)) {
    if (path.trim().length === 0) {
      return mode === "direct_mount"
        ? "A direct mount needs the repository path it will write into."
        : "A host worktree needs a source repository path.";
    }
    if (!path.startsWith("/")) {
      return "Path must be absolute (Core canonicalizes and confines it).";
    }
    if (path.includes("..")) {
      return "Path must not contain '..' traversal segments.";
    }
    return null;
  }
  if (mode === "mountless" && path.trim().length > 0) {
    return "Mountless binds no workspace, so a path here would be ignored — clear it.";
  }
  if (path.length > 0 && !path.startsWith("/")) {
    return "Path must be absolute when provided.";
  }
  return null;
}

export function fieldErrors(
  draft: SandboxDraft,
  context: WizardContext,
): FieldErrors {
  const errors: FieldErrors = {};

  const nameError = validateSandboxName(draft.name);
  if (nameError) {
    errors.name = nameError;
  } else if (
    context.existingSandboxNames
      .map((n) => n.toLowerCase())
      .includes(draft.name.toLowerCase())
  ) {
    errors.name = `A sandbox named "${draft.name}" already exists in SBX.`;
  }

  if (draft.projectId.trim().length === 0) {
    errors.projectId = "Pick the project this sandbox belongs to.";
  }

  if (draft.agentId.trim().length === 0) {
    errors.agentId = "Pick an agent.";
  } else if (!context.knownAgentIds.includes(draft.agentId)) {
    errors.agentId = `"${draft.agentId}" is not reported by this Core build.`;
  } else if (!context.verifiedAgentIds.includes(draft.agentId)) {
    errors.agentId =
      `"${draft.agentId}" has no verified adapter in this Core build, so a task would only queue. ` +
      "Pick a verified agent, or create the sandbox anyway and run nothing yet.";
  }

  if (!isSbxAgent(draft.sbxAgent)) {
    errors.sbxAgent = "Pick one of the built-in sbx agents.";
  } else if (draft.sbxAgent !== DEFAULT_SBX_AGENT && context.sbxAgentFieldAvailable !== true) {
    errors.sbxAgent =
      "This Core does not support choosing the sbx agent (it would silently create a shell sandbox). Use shell, or upgrade Core.";
  }

  if (draft.workspaceMode === null) {
    errors.workspaceMode = "Choose how the workspace is isolated.";
  } else if (!WORKSPACE_MODES.includes(draft.workspaceMode)) {
    errors.workspaceMode = "Unknown workspace mode.";
  }

  const repoError = validateRepoPath(draft.repoPath, draft.workspaceMode);
  if (repoError) errors.repoPath = repoError;

  return errors;
}

/** Which fields gate which step (design spec S04: inline validation per step). */
const STEP_FIELDS: Record<WizardStep, (keyof FieldErrors)[]> = {
  project: ["name", "projectId"],
  agent: ["agentId", "sbxAgent"],
  isolation: ["workspaceMode", "repoPath"],
  review: [],
};

export function stepErrors(draft: SandboxDraft, context: WizardContext): FieldErrors {
  const all = fieldErrors(draft, context);
  const scoped: FieldErrors = {};
  for (const field of STEP_FIELDS[draft.step]) {
    const message = all[field];
    if (message) scoped[field] = message;
  }
  return scoped;
}

export function canAdvance(draft: SandboxDraft, context: WizardContext): boolean {
  return Object.keys(stepErrors(draft, context)).length === 0;
}

export function nextStep(step: WizardStep): WizardStep | null {
  const index = QUICK_STEPS.indexOf(step);
  if (index === -1 || index === QUICK_STEPS.length - 1) return null;
  return QUICK_STEPS[index + 1] ?? null;
}

export function prevStep(step: WizardStep): WizardStep | null {
  const index = QUICK_STEPS.indexOf(step);
  if (index <= 0) return null;
  return QUICK_STEPS[index - 1] ?? null;
}

/**
 * The exact `sandbox.create` payload. Field names are the protocol's camelCase
 * (`SandboxCreateSpec`); `repoPath` is omitted rather than sent empty, matching
 * the Rust `skip_serializing_if = "Option::is_none"`.
 */
export function buildSpec(draft: SandboxDraft): SandboxCreateSpec {
  if (draft.workspaceMode === null) {
    throw new Error("buildSpec requires a workspace mode");
  }
  const spec: SandboxCreateSpec = {
    name: draft.name,
    projectId: draft.projectId,
    workspaceMode: draft.workspaceMode,
  };
  if (draft.repoPath.trim().length > 0) spec.repoPath = draft.repoPath.trim();
  // Never send a value outside the allowlist. `shell` is Core's default, so it is
  // omitted (an older Core then never sees the key at all).
  if (!isSbxAgent(draft.sbxAgent)) {
    throw new Error("buildSpec requires a built-in sbx agent");
  }
  if (draft.sbxAgent !== DEFAULT_SBX_AGENT) spec.agent = draft.sbxAgent;
  return spec;
}

/** Review-step warnings: the consequences the user is accepting. */
export function reviewWarnings(
  draft: SandboxDraft,
  context: WizardContext,
): string[] {
  const warnings: string[] = [];
  if (draft.workspaceMode === "direct_mount") {
    warnings.push(
      "Direct mount writes into your host working tree immediately — there is no isolated review step for those edits.",
    );
  }
  if (draft.agentId && !context.verifiedAgentIds.includes(draft.agentId)) {
    warnings.push(
      `No verified adapter for "${draft.agentId}" in this Core build: a task would stay queued rather than run.`,
    );
  }
  if (draft.sbxAgent !== DEFAULT_SBX_AGENT) {
    warnings.push(
      `The sbx agent "${draft.sbxAgent}" is not verified by Sandpane and may need provider sign-in inside the sandbox. Sandpane never imports provider credentials.`,
    );
  }
  if (!context.advancedAvailable) {
    warnings.push(
      "Advanced create options are hidden: resource, network and template settings require SBX feature detection that this build has not verified.",
    );
  }
  if (draft.repoPath.trim().length > 0) {
    warnings.push(
      "Core canonicalizes and confines this path before any sandbox argument is built; nothing outside it is reachable.",
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Project creation (specs/05 §3.A) — mirrors Validator::display_text + the
// absolute-path check in `project_create`.
// ---------------------------------------------------------------------------

/** `MAX_PROJECT_NAME_CHARS` in `sandpane_core::validation` (drift-tested). */
export const PROJECT_NAME_MAX = 120;
/** `MAX_PROJECT_DESCRIPTION_CHARS` in `sandpane_core::validation` (drift-tested). */
export const PROJECT_DESCRIPTION_MAX = 2000;

/** Rust `char::is_control()`: general category Cc (C0, DEL, C1). */
function isRustControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * `is_spoofing_format_char` in `sandpane_core::validation`: line/paragraph
 * separators, LRM/RLM, ALM, the bidi embeddings/overrides and the isolates.
 */
export function isSpoofingFormatChar(codePoint: number): boolean {
  return (
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x061c ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * A lone UTF-16 surrogate (`Array.from` yields it as its own element). It has
 * no UTF-8 encoding, so the frame cannot carry it as typed and Core refuses
 * the request; refusing it here keeps the user's text from being silently
 * altered. A proper pair is one character and is never matched.
 */
function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * `Validator::project_name` (`project.create` and `project.update`), exactly:
 * non-empty, at most 120 CHARACTERS (Unicode scalar values, as Rust counts —
 * not UTF-16 units), no control character at all (every Cc including `\n` and
 * `\t`, DEL, C1) and no line/paragraph separator or bidi control. The refusal
 * names the code point; it never echoes the character itself.
 */
export function validateProjectName(name: string): string | null {
  if (name.length === 0) return "Project name is required.";
  const chars = Array.from(name);
  if (chars.length > PROJECT_NAME_MAX) {
    return `Project name must be at most ${PROJECT_NAME_MAX} characters.`;
  }
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    if (isLoneSurrogate(code)) {
      return `Project name contains an unpaired surrogate (${codePointLabel(code)}), which is not valid text.`;
    }
    if (isRustControl(code)) {
      return `Project name contains a control character (${codePointLabel(code)}); names are one line.`;
    }
    if (isSpoofingFormatChar(code)) {
      return `Project name contains a hidden or direction-changing character (${codePointLabel(code)}).`;
    }
  }
  return null;
}

/**
 * `Validator::project_description`, exactly: at most 2000 characters; `\n` is
 * the ONLY control character allowed (tab, CR, DEL and C1 are refused); line/
 * paragraph separators and bidi controls are refused; empty is allowed and
 * clears the description.
 */
export function validateProjectDescription(description: string): string | null {
  const chars = Array.from(description);
  if (chars.length > PROJECT_DESCRIPTION_MAX) {
    return `Description must be at most ${PROJECT_DESCRIPTION_MAX} characters.`;
  }
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    if (isLoneSurrogate(code)) {
      return `Description contains an unpaired surrogate (${codePointLabel(code)}), which is not valid text.`;
    }
    if (isRustControl(code) && code !== 0x0a) {
      return `Description contains a control character (${codePointLabel(code)}); only line breaks are allowed.`;
    }
    if (isSpoofingFormatChar(code)) {
      return `Description contains a hidden or direction-changing character (${codePointLabel(code)}).`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversation titles (A3b §3.3 item 7) — mirrors Validator::conversation_title
// plus `conversation_rename`'s blank refusal.
// ---------------------------------------------------------------------------

/** `MAX_CONVERSATION_TITLE_CHARS` in `sandpane_core::validation` (drift-tested). */
export const CONVERSATION_TITLE_MAX = 200;

/**
 * Rust `char::is_whitespace` — the Unicode `White_Space` property, which is
 * what `str::trim()` strips. NOT JavaScript's `trim()`: JS also strips U+FEFF
 * (not White_Space, so Core keeps it) and does not strip U+0085 (which Rust
 * does). Using JS `trim()` would refuse a title Core accepts.
 */
export function isRustWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

/** `title.trim().is_empty()` exactly as Rust evaluates it. */
export function isRustBlank(value: string): boolean {
  for (const ch of value) {
    if (!isRustWhitespace(ch.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * A conversation title, checked with Core's exact rule before the frame is
 * written:
 * - `rename`: an empty or whitespace-only title (Rust `White_Space`) is
 *   refused, as `conversation_rename` refuses it with `MSG_TITLE_BLANK`;
 * - `create`: a blank title is left to Core, which stores
 *   "Untitled conversation" instead;
 * - otherwise `Validator::conversation_title`: at most 200 CHARACTERS (scalar
 *   values, as Rust counts), no control character at all (every Cc including
 *   `\n` and `\t`, DEL, C1), no line/paragraph separator or bidi control.
 *
 * Never stricter than Core: anything Core accepts passes. The refusal names
 * the code point; it never echoes the character or the title.
 */
export function validateConversationTitle(
  title: string,
  mode: "create" | "rename",
): string | null {
  if (isRustBlank(title)) {
    return mode === "rename" ? "Title must not be empty or whitespace-only." : null;
  }
  const chars = Array.from(title);
  if (chars.length > CONVERSATION_TITLE_MAX) {
    return `Title must be at most ${CONVERSATION_TITLE_MAX} characters.`;
  }
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    if (isLoneSurrogate(code)) {
      return `Title contains an unpaired surrogate (${codePointLabel(code)}), which is not valid text.`;
    }
    if (isRustControl(code)) {
      return `Title contains a control character (${codePointLabel(code)}); titles are one line.`;
    }
    if (isSpoofingFormatChar(code)) {
      return `Title contains a hidden or direction-changing character (${codePointLabel(code)}).`;
    }
  }
  return null;
}

export function validateRepositoryPaths(paths: readonly string[]): string | null {
  for (const p of paths) {
    if (p.trim().length === 0) return "Repository paths must not be blank.";
    if (!p.startsWith("/")) return `Repository path must be absolute: ${p}`;
  }
  return null;
}
