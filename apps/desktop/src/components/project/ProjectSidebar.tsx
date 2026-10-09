import { useCoreLink } from "../../lib/hooks";
import { href, navigate, type Route, useRoute } from "../../app/router";
import { Button, EmptyState } from "../ui/primitives";
import { IconPlus } from "../layout/icons";
import type { Project } from "../../lib/protocol";

/**
 * Contextual project sidebar. Selection here is UI-only (which row is focused);
 * the rows themselves always come from `project.list`.
 */
export function ProjectSidebar({ projects }: { projects: Project[] }) {
  const link = useCoreLink();
  const route = useRoute() as Route;
  const attached = link.kind === "attached";
  return (
    <div className="sidebar__inner">
      <div className="sidebar__head">
        <span className="sidebar__title">Projects</span>
        <Button
          variant="ghost"
          aria-label="New project"
          disabled={!attached}
          onClick={() => navigate("projects")}
        >
          <IconPlus />
        </Button>
      </div>
      {!attached ? (
        <p className="sidebar__note">
          Core is {link.kind === "unreachable" ? "unreachable" : "not attached"} — the project
          list is not available. Nothing is cached as live here.
        </p>
      ) : projects.length === 0 ? (
        <EmptyState
          heading="No projects"
          body="Create one in Projects to bind a repository."
        />
      ) : (
        <ul className="tree">
          {projects.map((project) => {
            const active =
              route.name === "project-workspace" &&
              route.params.projectId === project.id;
            return (
              <li key={project.id}>
                <a
                  className={`tree__row${active ? " tree__row--active" : ""}`}
                  href={href("project-workspace", { projectId: project.id })}
                  aria-current={active ? "true" : undefined}
                >
                  <span className="tree__name">{project.name}</span>
                  <span className="tree__meta">{project.createdAt.slice(0, 10)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
