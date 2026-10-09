import type { ReactNode } from "react";
import {
  NAV_LABELS,
  NAV_SECTIONS,
  sectionHref,
  type NavSection,
  type Route,
} from "../../app/router";
import {
  IconAgents,
  IconChats,
  IconHome,
  IconIntegrations,
  IconProjects,
  IconSandboxes,
  IconSettings,
  IconTasks,
  IconTemplates,
} from "./icons";
import { useUiPreferences } from "../../app/context";

const ICONS: Record<NavSection, () => ReactNode> = {
  dashboard: IconHome,
  projects: IconProjects,
  chats: IconChats,
  tasks: IconTasks,
  sandboxes: IconSandboxes,
  agents: IconAgents,
  templates: IconTemplates,
  integrations: IconIntegrations,
  settings: IconSettings,
};

/**
 * Icon rail + labelled navigation. Labels are always present (design spec §3:
 * "do not rely on icon meaning alone"); the rail collapses to icons only below
 * the narrow breakpoint through CSS, keeping the accessible name on every button.
 */
function IconRail({
  route,
  collapsed,
}: {
  route: Route;
  collapsed: boolean;
}) {
  return (
    <nav className={`rail${collapsed ? " rail--collapsed" : ""}`} aria-label="Sandpane sections">
      <div className="rail__brand" title="Sandpane">
        <span className="rail__mark" aria-hidden="true">
          SP
        </span>
        {!collapsed && <span className="rail__word">Sandpane</span>}
      </div>
      <ul className="rail__list">
        {NAV_SECTIONS.map((section) => {
          const Icon = ICONS[section];
          const active = route.section === section && !route.unmatched;
          return (
            <li key={section}>
              <a
                href={sectionHref(section)}
                className={`rail__item${active ? " rail__item--active" : ""}`}
                aria-current={active ? "page" : undefined}
                // The accessible name never depends on the label being drawn:
                // collapsed (preference) or narrow (CSS) rails hide it.
                aria-label={NAV_LABELS[section]}
                title={NAV_LABELS[section]}
              >
                <Icon />
                {!collapsed && <span className="rail__label">{NAV_LABELS[section]}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppShell({
  route,
  sidebar,
  statusLeading,
  statusTrailing,
  children,
}: {
  route: Route;
  sidebar?: ReactNode;
  statusLeading: ReactNode;
  statusTrailing: ReactNode;
  children: ReactNode;
}) {
  const collapsed = useUiPreferences().preferences.sidebarCollapsed;
  const className = [
    "shell",
    sidebar !== undefined ? "shell--with-sidebar" : "",
    collapsed ? "shell--rail-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className}>
      <IconRail route={route} collapsed={collapsed} />
      {sidebar !== undefined && <aside className="sidebar">{sidebar}</aside>}
      <main className="workspace" id="main" tabIndex={-1}>
        <div className="workspace__scroll">{children}</div>
        <footer className="statusbar">
          <div className="statusbar__leading">{statusLeading}</div>
          <div className="statusbar__trailing">{statusTrailing}</div>
        </footer>
      </main>
    </div>
  );
}

export function ViewHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="view-head">
      <div>
        <h1 className="view-head__title">{title}</h1>
        {subtitle !== undefined && (
          <p className="view-head__sub">{subtitle}</p>
        )}
      </div>
      {actions !== undefined && <div className="view-head__actions">{actions}</div>}
    </header>
  );
}
