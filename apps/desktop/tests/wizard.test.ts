import { describe, expect, it } from "vitest";
import {
  QUICK_STEPS,
  SANDBOX_NAME_MAX,
  STEP_TITLES,
  buildSpec,
  canAdvance,
  emptyDraft,
  fieldErrors,
  modeRequiresRepoPath,
  nextStep,
  prevStep,
  reviewWarnings,
  stepErrors,
  validateProjectName,
  validateRepoPath,
  validateRepositoryPaths,
  validateSandboxName,
  type WizardContext,
} from "../src/lib/wizard";
import type { SandboxDraft } from "../src/lib/wizard";
import { workspaceModeView } from "../src/lib/reducers";

const context: WizardContext = {
  existingSandboxNames: ["atlas-auth"],
  verifiedAgentIds: ["claude"],
  knownAgentIds: ["claude", "codex"],
  advancedAvailable: false,
};

function draft(patch: Partial<SandboxDraft>): SandboxDraft {
  return { ...emptyDraft(), ...patch };
}

describe("validateSandboxName — mirrors Validator::sandbox_name", () => {
  it("accepts DNS-label-like names", () => {
    for (const name of ["a", "atlas-auth", "orbit-web2", "9-lives", "x".repeat(SANDBOX_NAME_MAX)]) {
      expect(validateSandboxName(name), name).toBeNull();
    }
  });

  it("rejects empty, over-long, uppercase and shell-metacharacter names", () => {
    expect(validateSandboxName("")).toMatch(/required/);
    expect(validateSandboxName("x".repeat(SANDBOX_NAME_MAX + 1))).toMatch(/63/);
    expect(validateSandboxName("Atlas")).toMatch(/lowercase/);
    for (const hostile of [
      "a;rm -rf",
      "a b",
      "a|b",
      "a`b",
      "a$(id)",
      "a'b",
      'a"b',
      "a\\b",
      "a\nb",
      "a*b",
      "a?b",
      "a{b}",
      "a[b]",
      "a#b",
      "a~b",
      "a=b",
      "a%b",
      "a!b",
    ]) {
      expect(validateSandboxName(hostile), hostile).toMatch(/lowercase|start|control character/);
    }
  });

  it("rejects leading/trailing hyphens and option-smuggling doubles", () => {
    expect(validateSandboxName("-lead")).toMatch(/start/);
    expect(validateSandboxName("trail-")).toMatch(/end/);
    expect(validateSandboxName("a--b")).toMatch(/Consecutive/);
  });

  it("refuses the classic injection payload outright", () => {
    expect(validateSandboxName("x; sbx rm --everything")).not.toBeNull();
  });

  it("rejects characters a metacharacter denylist would miss", () => {
    // Core's allowlist is `[a-z0-9-]` anchored; these must not pass locally.
    for (const name of ["atläs", "at\u0007las", "atlas\u0000", "日本語", "atlas\u00A0x"]) {
      expect(validateSandboxName(name), name).not.toBeNull();
    }
  });
});

describe("validateRepoPath", () => {
  it("requires an absolute path for the modes that bind one", () => {
    expect(modeRequiresRepoPath("direct_mount")).toBe(true);
    expect(modeRequiresRepoPath("host_worktree")).toBe(true);
    expect(modeRequiresRepoPath("sbx_clone")).toBe(false);
    expect(validateRepoPath("", "direct_mount")).toMatch(/needs the repository path/);
    expect(validateRepoPath("relative/dir", "direct_mount")).toMatch(/absolute/);
    expect(validateRepoPath("/tmp/../etc", "direct_mount")).toMatch(/traversal/);
    expect(validateRepoPath("/abs/dir", "direct_mount")).toBeNull();
  });

  it("rejects a path on a mountless sandbox instead of ignoring it silently", () => {
    expect(validateRepoPath("/abs/dir", "mountless")).toMatch(/clear it/);
    expect(validateRepoPath("", "mountless")).toBeNull();
  });

  it("still requires absoluteness when the path is optional", () => {
    expect(validateRepoPath("nope", "sbx_clone")).toMatch(/absolute/);
    expect(validateRepoPath("/yes", "sbx_clone")).toBeNull();
  });
});

describe("fieldErrors", () => {
  it("flags a duplicate name against the list Core probed", () => {
    const errors = fieldErrors(
      draft({ name: "atlas-auth", projectId: "p1", agentId: "claude", workspaceMode: "sbx_clone" }),
      context,
    );
    expect(errors.name).toMatch(/already exists/);
  });

  it("rejects an uppercase duplicate on the shape rule before the duplicate rule", () => {
    const errors = fieldErrors(
      draft({ name: "ATLAS-AUTH", projectId: "p1", agentId: "claude", workspaceMode: "sbx_clone" }),
      context,
    );
    expect(errors.name).toMatch(/lowercase/);
  });

  it("requires a project and an agent Core actually reported", () => {
    const errors = fieldErrors(draft({ name: "n1", agentId: "ghost" }), context);
    expect(errors.projectId).toMatch(/Pick the project/);
    expect(errors.agentId).toMatch(/not reported by this Core build/);
  });

  it("warns about an unverified agent without blocking the sandbox itself", () => {
    const errors = fieldErrors(
      draft({ name: "n1", projectId: "p1", agentId: "codex", workspaceMode: "sbx_clone" }),
      context,
    );
    expect(errors.agentId).toMatch(/no verified adapter/);
  });

  it("requires an isolation choice", () => {
    expect(
      fieldErrors(draft({ name: "n1", projectId: "p1", agentId: "claude" }), context).workspaceMode,
    ).toMatch(/Choose how/);
  });
});

describe("step machine", () => {
  it("runs Project → Agent → Isolation → Review", () => {
    expect(QUICK_STEPS).toEqual(["project", "agent", "isolation", "review"]);
    expect(STEP_TITLES.review).toBe("Review and create");
    expect(nextStep("project")).toBe("agent");
    expect(nextStep("review")).toBeNull();
    expect(prevStep("project")).toBeNull();
    expect(prevStep("review")).toBe("isolation");
  });

  it("gates each step on its own fields", () => {
    const atProject = draft({ name: "n1" });
    expect(canAdvance(atProject, context)).toBe(false);
    expect(Object.keys(stepErrors(atProject, context))).toEqual(["projectId"]);

    const atAgent = draft({ name: "n1", projectId: "p1", step: "agent" });
    expect(Object.keys(stepErrors(atAgent, context))).toEqual(["agentId"]);

    const atIsolation = draft({
      name: "n1",
      projectId: "p1",
      agentId: "claude",
      workspaceMode: "direct_mount",
      step: "isolation",
    });
    expect(canAdvance(atIsolation, context)).toBe(false);
    expect(Object.keys(stepErrors(atIsolation, context))).toEqual(["repoPath"]);
  });

  it("lets a fully valid draft advance from the review step", () => {
    const done = draft({
      name: "orbit-web",
      projectId: "p1",
      agentId: "claude",
      workspaceMode: "sbx_clone",
      step: "review",
    });
    expect(canAdvance(done, context)).toBe(true);
    expect(stepErrors(done, context)).toEqual({});
  });
});

describe("buildSpec", () => {
  it("emits the protocol's camelCase payload and omits an empty repoPath", () => {
    const spec = buildSpec(
      draft({ name: "orbit-web", projectId: "p1", workspaceMode: "sbx_clone", agentId: "claude" }),
    );
    expect(spec).toEqual({ name: "orbit-web", projectId: "p1", workspaceMode: "sbx_clone" });
    expect(Object.keys(spec).sort()).toEqual(["name", "projectId", "workspaceMode"]);
  });

  it("trims and includes a repo path when supplied", () => {
    const spec = buildSpec(
      draft({
        name: "orbit-web",
        projectId: "p1",
        workspaceMode: "direct_mount",
        repoPath: " /srv/app ",
      }),
    );
    expect(spec.repoPath).toBe("/srv/app");
  });

  it("refuses to build without a mode rather than defaulting one", () => {
    expect(() => buildSpec(draft({ name: "n", projectId: "p" }))).toThrow(/workspace mode/);
  });
});

describe("reviewWarnings", () => {
  it("warns about a live-writable direct mount", () => {
    const warnings = reviewWarnings(
      draft({
        name: "n",
        projectId: "p",
        agentId: "claude",
        workspaceMode: "direct_mount",
        repoPath: "/srv/app",
      }),
      context,
    );
    expect(warnings.join(" ")).toMatch(/host working tree immediately/);
    expect(warnings.join(" ")).toMatch(/canonicalizes/);
  });

  it("warns that advanced options are hidden without feature detection", () => {
    const warnings = reviewWarnings(
      draft({ name: "n", projectId: "p", agentId: "claude", workspaceMode: "sbx_clone" }),
      context,
    );
    expect(warnings.join(" ")).toMatch(/Advanced create options are hidden/);
  });

  it("warns when the chosen agent has no verified adapter", () => {
    const warnings = reviewWarnings(
      draft({ name: "n", projectId: "p", agentId: "codex", workspaceMode: "sbx_clone" }),
      context,
    );
    expect(warnings.join(" ")).toMatch(/stay queued/);
  });
});

describe("mode copy", () => {
  it("labels direct mount as live-writable and clone as isolated", () => {
    expect(workspaceModeView("direct_mount").liveWritable).toBe(true);
    expect(workspaceModeView("sbx_clone").liveWritable).toBe(false);
  });
});

describe("project draft validation", () => {
  it("accepts Unicode names but rejects control characters and over-length", () => {
    expect(validateProjectName("Atlas Demo")).toBeNull();
    expect(validateProjectName("Орбита デモ")).toBeNull();
    expect(validateProjectName("")).toMatch(/required/);
    expect(validateProjectName("x".repeat(121))).toMatch(/120/);
    expect(validateSandboxName("atlas\u0007")).toMatch(/control character/);
  });

  it("requires absolute repository paths", () => {
    expect(validateRepositoryPaths([])).toBeNull();
    expect(validateRepositoryPaths(["/srv/a", "/srv/b"])).toBeNull();
    expect(validateRepositoryPaths(["relative"])).toMatch(/absolute/);
    expect(validateRepositoryPaths([""])).toMatch(/blank/);
  });
});
