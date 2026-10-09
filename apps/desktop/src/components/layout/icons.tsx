/**
 * Local icon set (inline SVG). No icon font, no CDN, no runtime icon package —
 * design spec §4.4 and §11. Decorative to the screen reader; the accessible name
 * always lives on the surrounding control.
 */

import type { SVGProps } from "react";

const BASE: Partial<SVGProps<SVGSVGElement>> = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
};

export function IconHome() {
  return (
    <svg {...BASE}>
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6 10.5V19h12v-8.5" />
    </svg>
  );
}

export function IconProjects() {
  return (
    <svg {...BASE}>
      <path d="M4 7h6l2 2h8v9H4z" />
      <path d="M4 7V5h5" />
    </svg>
  );
}

export function IconChats() {
  return (
    <svg {...BASE}>
      <path d="M5 6h14v9h-8l-4 3v-3H5z" />
    </svg>
  );
}

export function IconTasks() {
  return (
    <svg {...BASE}>
      <path d="M5 7h14" />
      <path d="M5 12h10" />
      <path d="M5 17h7" />
      <path d="M17.5 15.5 19.5 17.5 22 15" />
    </svg>
  );
}

export function IconSandboxes() {
  return (
    <svg {...BASE}>
      <path d="M12 4 20 8v8l-8 4-8-4V8z" />
      <path d="M12 12 20 8M12 12v8M12 12 4 8" />
    </svg>
  );
}

export function IconAgents() {
  return (
    <svg {...BASE}>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M6 19c1.2-2.6 3.4-4 6-4s4.8 1.4 6 4" />
    </svg>
  );
}

export function IconTemplates() {
  return (
    <svg {...BASE}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconIntegrations() {
  return (
    <svg {...BASE}>
      <path d="M9 9 6 12l3 3" />
      <path d="M15 9l3 3-3 3" />
      <path d="M12 4v16" />
    </svg>
  );
}

export function IconSettings() {
  return (
    <svg {...BASE}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.9 6.9l1.8 1.8M15.3 15.3l1.8 1.8M17.1 6.9l-1.8 1.8M8.7 15.3l-1.8 1.8" />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg {...BASE}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconRefresh() {
  return (
    <svg {...BASE}>
      <path d="M19 12a7 7 0 1 1-2-4.9" />
      <path d="M19 5v4h-4" />
    </svg>
  );
}
