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

import type { SandboxCreateSpec, WorkspaceMode } from "./protocol";
import { WORKSPACE_MODES } from "./protocol";

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
}

export interface SandboxDraft {
  name: string;
  projectId: string;
  agentId: string;
  workspaceMode: WorkspaceMode | null;
  repoPath: string;
  step: WizardStep;
}

export function emptyDraft(): SandboxDraft {
  return {
    name: "",
    projectId: "",
    agentId: "",
    workspaceMode: null,
    repoPath: "",
    step: "project",
  };
}

export type FieldErrors = Partial<
  Record<"name" | "projectId" | "agentId" | "workspaceMode" | "repoPath", string>
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
  agent: ["agentId"],
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

export const PROJECT_NAME_MAX = 120;

export function validateProjectName(name: string): string | null {
  if (name.length === 0) return "Project name is required.";
  if (name.length > PROJECT_NAME_MAX) {
    return `Project name must be at most ${PROJECT_NAME_MAX} characters.`;
  }
  // Control characters other than \n and \t are rejected by Core.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(name)) {
    return "Project name contains control characters.";
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
