import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { rankPlaces, writeWorkbook } from '@nomadsf/core';
import { PLACES, type StudioPlace } from './places';
import { askAi } from './components/AiHelp';
import type { HostKind } from './host';
import { storage } from './context';
import { openExternal } from './embed';
import { PageTables, PageTablesProvider, tablesZip } from './pageTables';
import { download } from './components/DataTable';
import { ToolContext } from './statusLog';

/**
 * The Studio's layout: tools grouped into hubs (Develop, Data, Access, Security, Org for one org; Compare & Deploy for
 * what goes between two places: two orgs, the org and the project, two branches, the org and a file; Settings),
 * each hub a page with its tools as tabs; and panes side by side — drag a hub or a tab to the
 * right half of a pane to open it beside, drag the divider to resize, ✕ to close. The layout
 * is remembered. ⌘/Ctrl + K jumps to any tool.
 */

export type ToolId =
  | 'apex'
  | 'code'
  | 'apextests'
  | 'logs'
  | 'automation'
  | 'jobs'
  | 'deployments'
  | 'query'
  | 'record'
  | 'data'
  | 'lookup'
  | 'csvcompare'
  | 'fields'
  | 'schema'
  | 'backup'
  | 'migrate'
  | 'lifecycle'
  | 'project'
  | 'package'
  | 'branchorg'
  | 'manifest'
  | 'metadata'
  | 'orgdiff'
  | 'access'
  | 'apps'
  | 'health'
  | 'limits'
  | 'company'
  | 'events'
  | 'rest'
  | 'activity'
  | 'orgaccess'
  | 'permissions'
  | 'groups'
  | 'compare'
  | 'objectaccess'
  | 'audit'
  | 'eventlogs'
  | 'secdash'
  | 'timeline'
  | 'whocansee'
  | 'sharing'
  | 'myaccess'
  | 'orgapps'
  | 'settings'
  | 'settingsai'
  | 'settingsproject'
  | 'licenses'
  | 'flows'
  | 'files'
  | 'sandbox';

export type Tool = { id: ToolId; label: string; icon: string; hint: string };

export const TOOLS: Tool[] = [
  { id: 'apex', label: 'Execute Apex', icon: '▶', hint: 'run anonymous Apex' },
  { id: 'code', label: 'Code', icon: '{}', hint: 'Apex, triggers, Visualforce, LWC, Aura' },
  { id: 'apextests', label: 'Apex tests', icon: '◎', hint: 'run tests, code coverage' },
  { id: 'logs', label: 'Debug logs', icon: '☰', hint: 'logs and trace flags' },
  { id: 'automation', label: 'Save order', icon: '↯', hint: 'what runs, in order, when a record is saved' },
  { id: 'flows', label: 'Flows', icon: '≋', hint: 'old versions, old API versions, waiting and failed interviews' },
  { id: 'jobs', label: 'Jobs', icon: '⏲', hint: 'scheduled and background Apex' },
  { id: 'query', label: 'Query', icon: '⌕', hint: 'SOQL with a filterable table' },
  { id: 'record', label: 'Record', icon: 'ⓘ', hint: 'inspect and edit one record' },
  { id: 'data', label: 'Import / Update / Delete', icon: '⇅', hint: 'from a CSV file or a query' },
  { id: 'lookup', label: 'Lookup', icon: '⌖', hint: 'find Ids for a CSV column' },
  { id: 'csvcompare', label: 'Compare with CSV', icon: '≍', hint: 'a CSV next to the org; make the org match it' },
  { id: 'schema', label: 'Schema', icon: '⌗', hint: 'fields, relationships, record types' },
  { id: 'fields', label: 'Field usage', icon: '▦', hint: 'how full each field is, who can see it' },
  { id: 'backup', label: 'Backup', icon: '⛁', hint: 'backups, schedules, restore' },
  { id: 'migrate', label: 'Copy records', icon: '⇶', hint: 'copy records between orgs' },
  { id: 'lifecycle', label: 'Lifecycle', icon: '◷', hint: 'archive, anonymize, delete in steps' },
  { id: 'project', label: 'Project', icon: '⌂', hint: 'your repository, compare with the org' },
  {
    id: 'package',
    label: 'Branch ↔ Branch',
    icon: '⇆',
    hint: 'what a branch brings into another: package.xml, destructiveChanges.xml',
  },
  { id: 'branchorg', label: 'Branch ↔ Org', icon: '⑂', hint: 'a branch of the project against an org, then deploy' },
  {
    id: 'manifest',
    label: 'Check a manifest',
    icon: '☷',
    hint: 'a package.xml against an org: what differs, then deploy',
  },
  { id: 'metadata', label: 'Metadata', icon: '◫', hint: 'retrieve, package.xml' },
  { id: 'orgdiff', label: 'Compare metadata', icon: '⇋', hint: 'differences between two orgs, deploy' },
  { id: 'deployments', label: 'Deployments', icon: '⇪', hint: 'deployment history, quick deploy' },
  { id: 'access', label: 'Users', icon: '☺', hint: 'a user and everything they have' },
  {
    id: 'permissions',
    label: 'Access sets',
    icon: '▣',
    hint: 'profiles, permission sets, groups, custom permissions: what each allows, who has it, assign',
  },
  { id: 'groups', label: 'Groups & queues', icon: '◎', hint: 'public groups, queues and their members' },
  { id: 'compare', label: 'Compare', icon: '⇆', hint: 'two users, profiles or permission sets' },
  { id: 'objectaccess', label: 'Object access', icon: '⛉', hint: 'who can use an object or field' },
  { id: 'audit', label: 'Logins & audit', icon: '⌛', hint: 'login history, setup audit trail' },
  { id: 'eventlogs', label: 'Event logs', icon: '≣', hint: 'event log files: logins, API, Apex, pages, reports' },
  { id: 'secdash', label: 'Dashboard', icon: '▣', hint: 'security at a glance: health, failed logins, API, admins' },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: '⧖',
    hint: 'everything that happened: setup, logins, components, NomadSF',
  },
  { id: 'whocansee', label: 'Who can see', icon: '◉', hint: 'can this user read or edit this record, and why' },
  { id: 'sharing', label: 'Sharing', icon: '⑂', hint: "an object's defaults and sharing rules, as a tree" },
  { id: 'myaccess', label: 'Your access', icon: '✓', hint: 'what your user may do here' },
  { id: 'apps', label: 'Connected apps', icon: '⚷', hint: 'connected apps, OAuth usage' },
  { id: 'health', label: 'Org health', icon: '♥', hint: 'security check, licenses' },
  { id: 'company', label: 'Company', icon: '◰', hint: 'company information: org Id, edition, locale, fiscal year' },
  { id: 'licenses', label: 'Licenses', icon: '✎', hint: 'how many are used; who holds one without using it' },
  { id: 'limits', label: 'Limits', icon: '▤', hint: 'org limits and storage' },
  { id: 'events', label: 'Events', icon: '⚡', hint: 'platform events, CDC' },
  { id: 'rest', label: 'REST Explorer', icon: '⇄', hint: 'any REST call' },
  { id: 'activity', label: 'Activity', icon: '⏱', hint: 'what you changed or exported with NomadSF, in every org' },
  { id: 'orgaccess', label: 'Compare access', icon: '⚿', hint: 'users and permissions in two orgs' },
  { id: 'orgapps', label: 'Compare apps', icon: '⚷', hint: 'connected apps in two orgs' },
  { id: 'settings', label: 'Orgs', icon: '◈', hint: 'the orgs you are logged in to' },
  { id: 'settingsai', label: 'AI', icon: '✦', hint: 'the AI the ✦ buttons use' },
  {
    id: 'files',
    label: 'Open a file',
    icon: '⎙',
    hint: 'a snapshot, workbook or CSV next to the org: restore, copy, compare',
  },
  {
    id: 'sandbox',
    label: 'Sandbox refresh',
    icon: '⟲',
    hint: 'before a refresh: save what it wipes; after: compare and put it back',
  },
  { id: 'settingsproject', label: 'Project', icon: '⌂', hint: 'the Salesforce project every page uses' },
];

/**
 * `breakBefore`: a thin divider before these tabs (Access: changing access, then reviewing it).
 * `sections`: a small heading before a tab, naming the group it starts (Compare & Deploy: Org ↔ Org, Org ↔ Project…).
 */
export type Hub = {
  id: string;
  label: string;
  icon: string;
  tools: ToolId[];
  breakBefore?: ToolId[];
  sections?: Partial<Record<ToolId, string>>;
};

// Most-used tab first. Working in one org: Develop, Data, Access, Security, Org. Between two places (another org, the
// project, a branch, a file): Compare & Deploy. The app's own: Settings.
export const HUBS: Hub[] = [
  {
    id: 'develop',
    label: 'Develop',
    icon: '{}',
    tools: ['code', 'apex', 'apextests', 'logs', 'jobs', 'automation', 'flows', 'events', 'rest'],
  },
  {
    id: 'data',
    label: 'Data',
    icon: '⇅',
    tools: ['query', 'record', 'data', 'lookup', 'schema', 'fields', 'backup', 'lifecycle'],
    breakBefore: ['backup'],
  },
  {
    id: 'people',
    label: 'Access',
    icon: '⚿',
    tools: ['access', 'permissions', 'groups', 'objectaccess', 'compare'],
    breakBefore: ['objectaccess'],
  },
  // What happened in the org and how safe it is
  {
    id: 'security',
    label: 'Security',
    icon: '⛨',
    tools: ['secdash', 'timeline', 'eventlogs', 'whocansee', 'sharing', 'health', 'audit'],
  },
  { id: 'org', label: 'Org', icon: '◈', tools: ['company', 'limits', 'licenses', 'apps', 'metadata', 'deployments'] },
  // Everything between two places: compare, deploy, retrieve, copy, restore
  {
    id: 'move',
    label: 'Compare & Deploy',
    icon: '⇄',
    tools: [
      'orgdiff',
      'orgaccess',
      'orgapps',
      'migrate',
      'project',
      'branchorg',
      'package',
      'files',
      'manifest',
      'csvcompare',
      'sandbox',
    ],
    sections: {
      orgdiff: 'Org ↔ Org',
      project: 'Project & git',
      files: 'Org ↔ File',
      sandbox: 'Sandbox',
    },
  },
  // The app's own: your orgs, your AI, your project, and what you did with NomadSF (in every org)
  {
    id: 'settings',
    label: 'Settings',
    icon: '⚙',
    tools: ['settings', 'settingsai', 'settingsproject', 'myaccess', 'activity'],
  },
];

/** Old page ids (links from the popup, VS Code, bookmarks) still open the right tool. */
const ALIASES: Record<string, ToolId> = {
  limits: 'limits',
  // Permission sets, Permissions and Assigned users are one tool now (Access sets); Overview went
  permsets: 'permissions',
  assigned: 'permissions',
  custperms: 'permissions',
  accessmap: 'access',
};

/** A tool id as it is now (an old one from a link or a saved layout → the tool that took it over). */
export const canonicalTool = (id: string): string => ALIASES[id] ?? id;
export const toolOf = (id: string): Tool | undefined => TOOLS.find((t) => t.id === canonicalTool(id));

/** The guide's section for a tool (the website, docs/guide.html). */
const GUIDE = 'https://faridmasjedi.github.io/plugin-fm/guide.html';
const GUIDE_ANCHOR: Partial<Record<ToolId, string>> = {
  data: 'data-tool',
  settingsai: 'settings',
  settingsproject: 'settings',
};
export const guideUrl = (tool: ToolId): string => `${GUIDE}#${GUIDE_ANCHOR[tool] ?? tool}`;
export const hubOf = (tool: ToolId): Hub => HUBS.find((h) => h.tools.includes(tool)) ?? HUBS[0];
export const isTool = (id: string): id is ToolId => Boolean(toolOf(id));

export type Pane = { key: string; tool: ToolId; size: number };
type Layout = { panes: Pane[]; active: number; lastTab: Record<string, ToolId> };

const MAX_PANES = 3;
const newKey = (): string => Math.random().toString(36).slice(2, 8);

/**
 * The panes and the active one. `available` filters tools that cannot show right now (e.g.
 * CLI-app tools without the app): panes showing them fall back to the hub's first tool.
 */
export function useWorkspace(initial: ToolId) {
  const [layout, setLayout] = useState<Layout>(() => {
    const stored = storage.get<Layout | undefined>('studio.layout', undefined);
    const base: Layout = stored?.panes?.length
      ? stored
      : { panes: [{ key: newKey(), tool: initial, size: 1 }], active: 0, lastTab: {} };
    // A link (#code, #query…) opens in the active pane
    const active = Math.min(base.active, base.panes.length - 1);
    const panes = base.panes.map((p, i) =>
      i === active && initial !== p.tool && location.hash
        ? { ...p, tool: initial }
        : { ...p, tool: canonicalTool(p.tool) as ToolId }
    );
    return { ...base, panes, active };
  });
  useEffect(() => storage.set('studio.layout', layout), [layout]);

  const show = useCallback((tool: ToolId, pane?: number) => {
    setLayout((l) => {
      // Already open in a pane: focus it
      const open = l.panes.findIndex((p) => p.tool === tool);
      if (open >= 0 && pane === undefined) return { ...l, active: open };
      const at = pane ?? l.active;
      return {
        ...l,
        active: at,
        panes: l.panes.map((p, i) => (i === at ? { ...p, tool } : p)),
        lastTab: { ...l.lastTab, [hubOf(tool).id]: tool },
      };
    });
  }, []);

  /** Shows a tool afresh (it reads its remembered tab again): the pane it is open in, or the active one. */
  const reopen = useCallback((tool: ToolId) => {
    setLayout((l) => {
      const open = l.panes.findIndex((p) => p.tool === tool);
      const at = open >= 0 ? open : l.active;
      return {
        ...l,
        active: at,
        panes: l.panes.map((p, i) => (i === at ? { ...p, tool, key: newKey() } : p)),
        lastTab: { ...l.lastTab, [hubOf(tool).id]: tool },
      };
    });
  }, []);

  /** Opens a hub (its last used tab) in the active pane. */
  const openHub = useCallback((hub: Hub) => {
    setLayout((l) => {
      // The tab used last, if it is still in this hub (tools move between hubs)
      const last = l.lastTab[hub.id];
      const tool = last && hub.tools.includes(last) ? last : hub.tools[0];
      const open = l.panes.findIndex((p) => hubOf(p.tool).id === hub.id);
      if (open >= 0) return { ...l, active: open };
      return { ...l, panes: l.panes.map((p, i) => (i === l.active ? { ...p, tool } : p)) };
    });
  }, []);

  const openBeside = useCallback((tool: ToolId, after?: number) => {
    setLayout((l) => {
      if (l.panes.length >= MAX_PANES) {
        // Full: replace the last pane
        const last = l.panes.length - 1;
        return { ...l, active: last, panes: l.panes.map((p, i) => (i === last ? { ...p, tool } : p)) };
      }
      const at = (after ?? l.active) + 1;
      const panes = [...l.panes];
      panes.splice(at, 0, { key: newKey(), tool, size: 1 });
      // New pane takes an equal share
      const total = panes.length;
      return { ...l, active: at, panes: panes.map((p) => ({ ...p, size: 1 / total })) };
    });
  }, []);

  const close = useCallback((index: number) => {
    setLayout((l) => {
      if (l.panes.length <= 1) return l;
      const panes = l.panes.filter((_, i) => i !== index);
      const sum = panes.reduce((n, p) => n + p.size, 0);
      return {
        ...l,
        panes: panes.map((p) => ({ ...p, size: p.size / sum })),
        active: Math.max(0, Math.min(l.active, panes.length - 1)),
      };
    });
  }, []);

  const resize = useCallback((index: number, sizes: [number, number]) => {
    setLayout((l) => ({
      ...l,
      panes: l.panes.map((p, i) =>
        i === index ? { ...p, size: sizes[0] } : i === index + 1 ? { ...p, size: sizes[1] } : p
      ),
    }));
  }, []);

  const focus = useCallback(
    (index: number) => setLayout((l) => (l.active === index ? l : { ...l, active: index })),
    []
  );

  return {
    ...layout,
    show,
    reopen,
    openHub,
    openBeside,
    close,
    resize,
    focus,
    full: layout.panes.length >= MAX_PANES,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;

const DRAG_TYPE = 'application/x-nomadsf-tool';

export const dragTool = (tool: ToolId) => (e: React.DragEvent) => {
  e.dataTransfer.setData(DRAG_TYPE, tool);
  e.dataTransfer.effectAllowed = 'copyMove';
};

/** The sidebar: one entry per hub; drag one into the panes area to open it beside. */
export function HubNav({
  ws,
  available,
  compact,
  onCompact,
}: {
  ws: WorkspaceState;
  available: (tool: ToolId) => boolean;
  /** Icons only: the name shows when the mouse is over a hub. */
  compact: boolean;
  onCompact: (compact: boolean) => void;
}) {
  // Narrow sidebar: the hub's name beside it on hover (a fixed box, so the scrolling sidebar does not cut it)
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const showTip = (h: Hub) => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!compact) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label: h.label, top: r.top + r.height / 2, left: r.right + 8 });
  };
  const activeHub = hubOf(ws.panes[ws.active]?.tool ?? 'apex').id;
  const openHubs = new Set(ws.panes.map((p) => hubOf(p.tool).id));
  const hubs = HUBS.filter((h) => h.id !== 'settings' && h.tools.some(available));
  const entry = (h: Hub) => (
    <button
      key={h.id}
      className={`hub ${activeHub === h.id ? 'active' : ''} ${openHubs.has(h.id) ? 'open' : ''}`}
      data-hub={h.id}
      aria-label={h.label}
      onClick={() => ws.openHub(h)}
      onMouseEnter={showTip(h)}
      onMouseLeave={() => setTip(null)}
      draggable
      onDragStart={dragTool(
        (h.tools.includes(ws.lastTab[h.id]) ? ws.lastTab[h.id] : undefined) ?? h.tools.find(available) ?? h.tools[0]
      )}
      title={`${compact ? `${h.label}: ` : ''}${h.tools
        .filter(available)
        .map((t) => toolOf(t)!.label)
        .join(' · ')}\nDrag to the right of a pane to open it beside`}
    >
      <span className="icon">{h.icon}</span>
      <span className="hub-label">{h.label}</span>
      {h.id !== 'settings' && <span className="hub-count">{h.tools.filter(available).length}</span>}
    </button>
  );
  return (
    <>
      {hubs.map(entry)}
      <div className="nav-spacer" />
      <div className="nav-hint">Drag a hub or a tab to the right of a pane to open it beside · ⌘K to jump</div>
      {entry(HUBS.find((h) => h.id === 'settings')!)}
      <button
        className="nav-width"
        onClick={() => {
          setTip(null);
          onCompact(!compact);
        }}
        title={compact ? 'Show the hub names' : 'Icons only (the name shows on hover)'}
        aria-label={compact ? 'Show the hub names' : 'Icons only'}
      >
        {compact ? '»' : '« Narrow'}
      </button>
      {tip && (
        <span className="hub-tip" style={{ top: tip.top, left: tip.left }}>
          {tip.label}
        </span>
      )}
    </>
  );
}

/**
 * The panes side by side, each with its hub's tabs; drop zones appear while dragging, the
 * dividers resize.
 */
export function Panes({
  ws,
  available,
  render,
}: {
  ws: WorkspaceState;
  available: (tool: ToolId) => boolean;
  render: (tool: ToolId, pane: number) => ReactNode;
}) {
  const [drag, setDrag] = useState<{ pane: number; side: 'beside' | 'here' } | null>(null);
  // Tools opened in each pane stay mounted (hidden when not shown), so switching tabs or hubs, or
  // The tables of each open tab, for its ⤓ download
  const registries = useRef(new Map<string, PageTables>());
  const tablesOf = (key: string): PageTables => {
    let tables = registries.current.get(key);
    if (!tables) registries.current.set(key, (tables = new PageTables()));
    return tables;
  };
  // closing another pane, keeps their results; ↻ resets one to a clean page
  const [opened, setOpened] = useState<Record<string, ToolId[]>>({});
  const [resets, setResets] = useState<Record<string, number>>({});
  useEffect(() => {
    setOpened((o) => {
      const next: Record<string, ToolId[]> = {};
      let changed = Object.keys(o).length !== ws.panes.length;
      for (const p of ws.panes) {
        const list = o[p.key] ?? [];
        next[p.key] = list.includes(p.tool) ? list : [...list, p.tool];
        if (next[p.key] !== list) changed = true;
      }
      return changed ? next : o;
    });
  }, [ws.panes]);
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onDragOver = (pane: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side = e.clientX > box.left + box.width * 0.55 ? 'beside' : 'here';
    if (drag?.pane !== pane || drag.side !== side) setDrag({ pane, side });
  };
  const onDrop = (pane: number) => (e: React.DragEvent) => {
    const tool = e.dataTransfer.getData(DRAG_TYPE) as ToolId;
    e.preventDefault();
    setDrag(null);
    if (!isTool(tool)) return;
    if (drag?.side === 'beside') ws.openBeside(tool, pane);
    else ws.show(tool, pane);
  };

  const startResize = (index: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const box = area.current!.getBoundingClientRect();
    const panes = ws.panes;
    const before = panes.slice(0, index).reduce((n, p) => n + p.size, 0);
    const pair = panes[index].size + panes[index + 1].size;
    dragging.current = true;
    const move = (ev: PointerEvent) => {
      const at = (ev.clientX - box.left) / box.width;
      // Each pane keeps at least 22% of the width
      const first = Math.max(0.22, Math.min(pair - 0.22, at - before));
      ws.resize(index, [first, pair - first]);
    };
    const up = () => {
      dragging.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`panes ${ws.panes.length > 1 ? 'split' : ''}`}
      ref={area}
      onDragLeave={(e) => !area.current?.contains(e.relatedTarget as Node) && setDrag(null)}
    >
      {ws.panes.map((pane, i) => {
        const hub = hubOf(pane.tool);
        const tools = hub.tools.filter(available);
        const tool = available(pane.tool) ? pane.tool : tools[0] ?? 'settings';
        const kept = [...new Set([...(opened[pane.key] ?? []), tool])].filter(available);
        const resetKey = `${pane.key}:${tool}`;
        return (
          <Fragment key={pane.key}>
            {i > 0 && (
              <div className="pane-divider" onPointerDown={startResize(i - 1)} title="Drag to resize">
                <span />
              </div>
            )}
            <section
              className={`pane ${i === ws.active ? 'active' : ''}`}
              style={{ flexGrow: pane.size, flexBasis: 0 }}
              onMouseDown={() => ws.focus(i)}
              onDragOver={onDragOver(i)}
              onDrop={onDrop(i)}
            >
              <div className="pane-bar">
                <span className="pane-hub" title={hub.label} data-hub={hub.id}>
                  <span className="icon">{hub.icon}</span>
                  <span className="hub-name">{hub.label}</span>
                </span>
                <span className="pane-tool">
                  <span className="sep">›</span>
                  <span className="icon">{toolOf(tool)?.icon}</span>
                  {toolOf(tool)?.label}
                </span>
                <span className="grow" />
                <button
                  className="pane-action help"
                  title={`How to use ${toolOf(tool)?.label ?? 'this tool'} (opens the guide)`}
                  onClick={() => openExternal(guideUrl(tool))}
                >
                  ?
                </button>
                <PageDownload tables={tablesOf(`${pane.key}:${tool}`)} name={toolOf(tool)?.label ?? tool} />
                <button
                  className="pane-action"
                  title="Start this tab again with a clean page (its current results are cleared)"
                  onClick={() => setResets((r) => ({ ...r, [resetKey]: (r[resetKey] ?? 0) + 1 }))}
                >
                  ↻
                </button>
                {!ws.full && (
                  <button className="pane-action" title="Open this hub beside" onClick={() => ws.openBeside(tool, i)}>
                    ⧉
                  </button>
                )}
                {ws.panes.length > 1 && (
                  <button className="pane-action" title="Close this pane" onClick={() => ws.close(i)}>
                    ✕
                  </button>
                )}
              </div>
              <div className="pane-main">
                <nav className="pane-nav" role="tablist" aria-label={`${hub.label} tools`}>
                  {tools.map((t, n) => {
                    const meta = toolOf(t)!;
                    return (
                      <Fragment key={t}>
                        {hub.breakBefore?.includes(t) && <span className="pane-nav-break" aria-hidden="true" />}
                        {hub.sections?.[t] && <span className="pane-nav-section">{hub.sections[t]}</span>}
                        <button
                          role="tab"
                          className={`pane-nav-item ${t === tool ? 'active' : ''}`}
                          data-tone={n % 8}
                          title={`${meta.label}: ${meta.hint} · drag to the right to open beside`}
                          draggable
                          onDragStart={dragTool(t)}
                          onClick={() => ws.show(t, i)}
                        >
                          <span className="icon">{meta.icon}</span>
                          <span className="pane-nav-label">{meta.label}</span>
                        </button>
                      </Fragment>
                    );
                  })}
                </nav>
                <div className="pane-body">
                  {kept.map((t) => (
                    <div key={`${t}:${resets[`${pane.key}:${t}`] ?? 0}`} className="tool-view" hidden={t !== tool}>
                      <ToolContext.Provider value={toolOf(t)?.label ?? t}>
                        <PageTablesProvider tables={tablesOf(`${pane.key}:${t}`)}>{render(t, i)}</PageTablesProvider>
                      </ToolContext.Provider>
                    </div>
                  ))}
                </div>
              </div>
              {drag?.pane === i && (
                <div className={`drop-zone ${drag.side}`}>
                  <span>
                    {drag.side === 'beside' ? (ws.full ? 'Open here (3 panes at most)' : 'Open beside') : 'Open here'}
                  </span>
                </div>
              )}
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Opens the ⌘K box from a button: window.dispatchEvent(new Event(OPEN_JUMP)). */
export const OPEN_JUMP = 'nomadsf:jump';

type Jump = { kind: 'tool'; tool: Tool } | { kind: 'place'; place: StudioPlace } | { kind: 'ai' };

/** Where a place is: Hub › Tool › Tab. */
const placePath = (p: StudioPlace): string =>
  [hubOf(p.tool).label, toolOf(p.tool)?.label, p.where].filter(Boolean).join(' › ');

/**
 * ⌘/Ctrl + K: a tool by name, or what you want to do in your own words ("stop a batch job", "who can edit cases")
 * → the place it is done, on the right tab. Nothing typed is sent anywhere, unless you choose "Ask AI where"
 * (only the sentence and the list of places go to your AI).
 */
export function QuickJump({
  ws,
  available,
  hostKind,
}: {
  ws: WorkspaceState;
  available: (tool: ToolId) => boolean;
  hostKind: HostKind;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [at, setAt] = useState(0);
  const [ai, setAi] = useState<{ asked: string; places?: StudioPlace[]; note?: string; error?: string }>();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setText('');
        setAt(0);
        setAi(undefined);
      } else if (e.key === 'Escape') setOpen(false);
    };
    // The header's Search button (VS Code keeps ⌘K for its own shortcuts)
    const fromButton = () => {
      setOpen(true);
      setText('');
      setAt(0);
      setAi(undefined);
    };
    window.addEventListener('keydown', key);
    window.addEventListener(OPEN_JUMP, fromButton);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener(OPEN_JUMP, fromButton);
    };
  }, []);
  const places = useMemo(() => PLACES.filter((p) => available(p.tool)), [available]);
  const found = useMemo((): Jump[] => {
    const q = text.trim().toLowerCase();
    const tools = TOOLS.filter((t) => available(t.id));
    if (!q) return tools.map((tool) => ({ kind: 'tool', tool }));
    // A tool by its name first, then what it is for (the places), then tools by hub or hint
    const named = tools
      .filter((t) => t.label.toLowerCase().includes(q))
      .sort((a, b) => Number(b.label.toLowerCase().startsWith(q)) - Number(a.label.toLowerCase().startsWith(q)));
    const asTasks = rankPlaces(q, [...places, ...tools.map(toolPlace)], 8)
      .filter((r) => r.score >= 0.45)
      .map((r) => r.place);
    const out: Jump[] = named.map((tool) => ({ kind: 'tool', tool }));
    for (const p of asTasks) {
      if ('id' in p) {
        if (!named.some((t) => t.id === p.id)) out.push({ kind: 'tool', tool: p as Tool });
      } else out.push({ kind: 'place', place: p });
    }
    if (q.split(/\s+/).length >= 2) out.push({ kind: 'ai' });
    return out.slice(0, 12);
  }, [text, available, places]);

  if (!open) return null;
  const goTool = (tool: ToolId, beside: boolean) => {
    if (beside) ws.openBeside(tool);
    else ws.show(tool);
    setOpen(false);
  };
  const goPlace = (p: StudioPlace, beside: boolean) => {
    for (const [k, v] of Object.entries(p.set ?? {})) storage.set(k, v);
    if (beside) ws.openBeside(p.tool);
    else if (p.set) ws.reopen(p.tool);
    else ws.show(p.tool);
    setOpen(false);
  };
  const askAiWhere = async () => {
    const asked = text.trim();
    setAi({ asked });
    try {
      const list = places.map((p, i) => `${i} | ${placePath(p)} | ${p.say}`).join('\n');
      const answer = await askAi(hostKind, { task: 'find-place', question: asked, places: list });
      const json = /\{[\s\S]*\}/.exec(answer.text)?.[0] ?? '{}';
      const parsed = JSON.parse(json) as { places?: Array<string | number>; note?: string };
      const picked = (parsed.places ?? []).map((id) => places[Number(id)]).filter(Boolean);
      setAi({ asked, places: picked, note: parsed.note });
      setAt(0);
    } catch (e) {
      setAi({ asked, error: (e as Error).message });
    }
  };
  const go = (j: Jump, beside: boolean) => {
    if (j.kind === 'tool') goTool(j.tool.id, beside);
    else if (j.kind === 'place') goPlace(j.place, beside);
    else void askAiWhere();
  };
  const shown: Jump[] = ai?.places?.length ? ai.places.map((place) => ({ kind: 'place', place })) : found;
  return (
    <div className="quick-jump-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="quick-jump" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Go to a tool, or say what you want to do (stop a batch job…)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAt(0);
            setAi(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setAt((a) => Math.min(shown.length - 1, a + 1));
            else if (e.key === 'ArrowUp') setAt((a) => Math.max(0, a - 1));
            else if (e.key === 'Enter' && shown[at]) go(shown[at], e.shiftKey);
            else return;
            e.preventDefault();
          }}
        />
        {ai && (
          <p className="qj-ai-note">
            {ai.error
              ? `❌ ${ai.error}`
              : !ai.places
              ? '✦ Asking your AI where…'
              : ai.places.length
              ? `✦ ${ai.note ?? 'Your AI suggests:'}`
              : '✦ Your AI found no place for that.'}
          </p>
        )}
        <ul>
          {shown.map((j, i) => (
            <li key={j.kind === 'tool' ? `t:${j.tool.id}` : j.kind === 'place' ? `p:${PLACES.indexOf(j.place)}` : 'ai'}>
              <button
                className={i === at ? 'active' : ''}
                onMouseEnter={() => setAt(i)}
                onClick={(e) => go(j, e.shiftKey)}
              >
                {j.kind === 'tool' && (
                  <>
                    <span className="icon">{j.tool.icon}</span>
                    <span className="qj-label">{j.tool.label}</span>
                    <span className="muted">{j.tool.hint}</span>
                    <span className="qj-hub">{hubOf(j.tool.id).label}</span>
                  </>
                )}
                {j.kind === 'place' && (
                  <>
                    <span className="icon">{toolOf(j.place.tool)?.icon}</span>
                    <span className="qj-label qj-say">{j.place.say}</span>
                    <span />
                    <span className="qj-hub">{placePath(j.place)}</span>
                  </>
                )}
                {j.kind === 'ai' && (
                  <>
                    <span className="icon">✦</span>
                    <span className="qj-label">Ask AI where</span>
                    <span className="muted">sends only your sentence and the list of places to your AI</span>
                    <span />
                  </>
                )}
              </button>
            </li>
          ))}
          {!shown.length && <li className="muted qj-none">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}

/** A tool as a place: its name and hint are what it is for. */
const toolPlace = (t: Tool): Tool & { say: string; also: string } => ({ ...t, say: t.label, also: t.hint });

/** ⤓ in a pane: every table on the page in an Excel workbook (a sheet each), a zip of CSVs, or JSON. */
function PageDownload({ tables, name }: { tables: PageTables; name: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const file = `${name.replace(/[^\w-]+/g, '-')}-${new Date().toLocaleDateString('en-CA')}`;
  const save = (bytes: Uint8Array, name: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const take = (as: 'xlsx' | 'zip' | 'json') => {
    setOpen(false);
    const list = tables.visible();
    if (!list.length) {
      setNote('No tables on this page yet');
      setTimeout(() => setNote(''), 2500);
      return;
    }
    if (as === 'xlsx')
      save(writeWorkbook(list), `${file}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    else if (as === 'json')
      download(
        `${file}.json`,
        JSON.stringify(Object.fromEntries(list.map((t) => [t.name, t.rows])), null, 2),
        'application/json'
      );
    else save(tablesZip(list), `${file}.zip`, 'application/zip');
  };
  return (
    <span className="page-download">
      <button className="pane-action" title="Download every table on this page" onClick={() => setOpen(!open)}>
        ⤓
      </button>
      {note && <span className="muted">{note}</span>}
      {open && (
        <span className="page-download-menu">
          <button onClick={() => take('xlsx')}>Excel workbook (a sheet per table)</button>
          <button onClick={() => take('zip')}>A zip with a CSV per table</button>
          <button onClick={() => take('json')}>All tables as JSON</button>
        </span>
      )}
    </span>
  );
}
