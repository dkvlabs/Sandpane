/**
 * Minimal hash-based router.
 *
 * The spec allows "React Router or equivalent"; this scaffold ships the
 * equivalent rather than another dependency. Hash routing keeps the Tauri
 * bundle a single static `dist/` with no server-side rewrites, and the surface
 * needed here is a pattern match plus `hashchange`.
 */

import { useCallback, useEffect, useState } from "react";

export type RouteName =
  | "dashboard"
  | "projects"
  | "project-workspace"
  | "conversation"
  | "chats"
  | "tasks"
  | "task-detail"
  | "sandboxes"
  | "sandbox-new"
  | "sandbox-detail"
  | "agents"
  | "templates"
  | "integrations"
  | "settings";

interface Pattern {
  name: RouteName;
  /** Static segments and `:param` placeholders. */
  segments: string[];
  /** Icon-rail destination this route belongs to (for active nav state). */
  section: NavSection;
}

const PATTERNS: readonly Pattern[] = [
  { name: "dashboard", segments: [], section: "dashboard" },
  { name: "projects", segments: ["projects"], section: "projects" },
  {
    name: "project-workspace",
    segments: ["projects", ":projectId"],
    section: "projects",
  },
  {
    name: "conversation",
    segments: ["projects", ":projectId", "conversations", ":conversationId"],
    section: "chats",
  },
  { name: "chats", segments: ["chats"], section: "chats" },
  { name: "tasks", segments: ["tasks"], section: "tasks" },
  { name: "task-detail", segments: ["tasks", ":taskId"], section: "tasks" },
  { name: "sandboxes", segments: ["sandboxes"], section: "sandboxes" },
  { name: "sandbox-new", segments: ["sandboxes", "new"], section: "sandboxes" },
  {
    name: "sandbox-detail",
    segments: ["sandboxes", ":sandboxName"],
    section: "sandboxes",
  },
  { name: "agents", segments: ["agents"], section: "agents" },
  { name: "templates", segments: ["templates"], section: "templates" },
  { name: "integrations", segments: ["integrations"], section: "integrations" },
  { name: "settings", segments: ["settings"], section: "settings" },
];

export interface Route {
  name: RouteName;
  section: Pattern["section"];
  params: Record<string, string>;
  hash: string;
  /** True when the hash matched nothing — surfaced as an unknown route, not a silent dashboard. */
  unmatched: boolean;
}

export function parseHash(rawHash: string): Route {
  const hash = rawHash.replace(/^#\/?/, "");
  const [pathPart] = hash.split("?");
  const segments = pathPart.split("/").filter((s) => s.length > 0);

  // Order matters: literal `new` wins over `:param`.
  const ordered = [...PATTERNS].sort((a, b) => {
    const aLiteral = a.segments.filter(isParam).length;
    const bLiteral = b.segments.filter(isParam).length;
    if (aLiteral !== bLiteral) return aLiteral - bLiteral;
    return b.segments.length - a.segments.length;
  });

  for (const pattern of ordered) {
    if (pattern.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.segments.length; i += 1) {
      const want = pattern.segments[i] ?? "";
      const got = segments[i] ?? "";
      if (isParam(want)) {
        params[want.slice(1)] = decodeURIComponent(got);
      } else if (want !== got) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        name: pattern.name,
        section: pattern.section,
        params,
        hash: `#/${hash}`,
        unmatched: false,
      };
    }
  }

  return {
    name: "dashboard",
    section: "dashboard",
    params: {},
    hash: `#/${hash}`,
    unmatched: true,
  };
}

function isParam(segment: string): boolean {
  return segment.startsWith(":");
}

/** Build a hash href; params fill `:placeholders` in declaration order. */
export function href(
  name: RouteName,
  params: Record<string, string> = {},
): string {
  const pattern = PATTERNS.find((p) => p.name === name);
  if (!pattern) return "#/";
  const parts = pattern.segments.map((segment) =>
    isParam(segment)
      ? encodeURIComponent(params[segment.slice(1)] ?? "")
      : segment,
  );
  return parts.length === 0 ? "#/" : `#/${parts.join("/")}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() =>
    parseHash(typeof window === "undefined" ? "" : window.location.hash),
  );
  const onChange = useCallback(() => {
    setRoute(parseHash(window.location.hash));
  }, []);
  useEffect(() => {
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [onChange]);
  return route;
}

export function navigate(name: RouteName, params?: Record<string, string>): void {
  const next = href(name, params ?? {});
  if (window.location.hash !== next) window.location.hash = next;
}

export function isSectionActive(route: Route, section: Pattern["section"]): boolean {
  return route.section === section;
}

export const NAV_SECTIONS = [
  "dashboard",
  "projects",
  "chats",
  "tasks",
  "sandboxes",
  "agents",
  "templates",
  "integrations",
  "settings",
] as const;

export type NavSection = (typeof NAV_SECTIONS)[number];

export const NAV_LABELS: Record<NavSection, string> = {
  dashboard: "Dashboard",
  projects: "Projects",
  chats: "Chats",
  tasks: "Tasks & Review",
  sandboxes: "Sandboxes",
  agents: "Agents",
  templates: "Templates",
  integrations: "Integrations",
  settings: "Settings",
};

export function sectionHref(section: NavSection): string {
  switch (section) {
    case "dashboard":
      return href("dashboard");
    case "projects":
      return href("projects");
    case "chats":
      return href("chats");
    case "tasks":
      return href("tasks");
    case "sandboxes":
      return href("sandboxes");
    case "agents":
      return href("agents");
    case "templates":
      return href("templates");
    case "integrations":
      return href("integrations");
    case "settings":
      return href("settings");
  }
}
