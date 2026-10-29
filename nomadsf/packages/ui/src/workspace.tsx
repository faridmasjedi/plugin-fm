import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { writeWorkbook } from '@nomadsf/core';
import { storage } from './context';
import { openExternal } from './embed';
import { PageTables, PageTablesProvider, tablesZip } from './pageTables';
import { download } from './components/DataTable';

/**
 * The Studio's layout: tools grouped into hubs (Develop, Data, Data protection, Release, Access, Org, and
 * Org to org for the tools that work on two orgs),
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
  | 'metadata'
  | 'orgdiff'
  | 'tests'
  | 'access'
  | 'apps'
  | 'health'
  | 'limits'
  | 'company'
  | 'events'
  | 'rest'
  | 'activity'
  | 'orgaccess'
  | 'permsets'
  | 'permissions'
  | 'assigned'
  | 'groups'
  | 'custperms'
  | 'compare'
  | 'accessmap'
  | 'objectaccess'
  | 'audit'
  | 'myaccess'
  | 'orgapps'
  | 'settings'
  | 'local-orgs'
  | 'local-ai';

export type Tool = { id: ToolId; label: string; icon: string; hint: string };

export const TOOLS: Tool[] = [
  { id: 'apex', label: 'Execute Apex', icon: '▶', hint: 'run anonymous Apex' },
  { id: 'code', label: 'Code', icon: '{}', hint: 'Apex, triggers, Visualforce, LWC, Aura' },
  { id: 'apextests', label: 'Apex tests', icon: '◎', hint: 'run tests, code coverage' },
  { id: 'logs', label: 'Debug Logs', icon: '☰', hint: 'logs and trace flags' },
  { id: 'automation', label: 'Automation', icon: '↯', hint: 'what runs when a record is saved' },
  { id: 'jobs', label: 'Jobs', icon: '⏲', hint: 'scheduled and background Apex' },
  { id: 'query', label: 'Query', icon: '⌕', hint: 'SOQL with a filterable table' },
  { id: 'record', label: 'Record', icon: 'ⓘ', hint: 'inspect and edit one record' },
  { id: 'data', label: 'Import / Update / Delete', icon: '⇅', hint: 'from a CSV file or a query' },
  { id: 'lookup', label: 'Lookup', icon: '⌖', hint: 'find Ids for a CSV column' },
  { id: 'csvcompare', label: 'Compare with CSV', icon: '≍', hint: 'a CSV next to the org; make the org match it' },
  { id: 'schema', label: 'Schema', icon: '⌗', hint: 'fields, relationships, record types' },
  { id: 'fields', label: 'Field usage', icon: '▦', hint: 'how full each field is, who can see it' },
  { id: 'backup', label: 'Backup', icon: '⛁', hint: 'backups, schedules, restore' },
  { id: 'migrate', label: 'Migrate', icon: '⇶', hint: 'copy records between orgs' },
  { id: 'lifecycle', label: 'Lifecycle', icon: '◷', hint: 'archive, anonymize, delete in steps' },
  { id: 'project', label: 'Project', icon: '⌂', hint: 'your repository, compare with the org' },
  { id: 'metadata', label: 'Metadata', icon: '◫', hint: 'retrieve, package.xml' },
  { id: 'orgdiff', label: 'Org compare', icon: '⇋', hint: 'differences between two orgs, deploy' },
  { id: 'deployments', label: 'Deployments', icon: '⇪', hint: 'deployment history, quick deploy' },
  { id: 'tests', label: 'E2E tests', icon: '✓', hint: 'Playwright (CLI app)' },
  { id: 'access', label: 'Users', icon: '☺', hint: 'a user and everything they have' },
  { id: 'permsets', label: 'Permission sets & groups', icon: '▣', hint: 'who has one, assign, remove' },
  { id: 'permissions', label: 'Permissions', icon: '⚿', hint: 'what a profile, set or group allows; edit' },
  { id: 'assigned', label: 'Assigned users', icon: '☷', hint: 'users of a set, group, license, profile, role' },
  { id: 'groups', label: 'Groups & queues', icon: '◎', hint: 'public groups, queues and their members' },
  { id: 'custperms', label: 'Custom permissions', icon: '✱', hint: 'who gives each one; grant it' },
  { id: 'compare', label: 'Compare', icon: '⇆', hint: 'two users, profiles or permission sets' },
  { id: 'accessmap', label: 'Access overview', icon: '▦', hint: 'every user and what they have' },
  { id: 'objectaccess', label: 'Object access', icon: '⛉', hint: 'who can use an object or field' },
  { id: 'audit', label: 'Logins & audit', icon: '⌛', hint: 'login history, setup audit trail' },
  { id: 'myaccess', label: 'Your access', icon: '✓', hint: 'what your user may do here' },
  { id: 'apps', label: 'Connected apps', icon: '⚷', hint: 'connected apps, OAuth usage' },
  { id: 'health', label: 'Org health', icon: '♥', hint: 'security check, licenses' },
  { id: 'company', label: 'Company', icon: '⌂', hint: 'company information: org Id, edition, locale, fiscal year' },
  { id: 'limits', label: 'Limits', icon: '▤', hint: 'org limits and storage' },
  { id: 'events', label: 'Events', icon: '⚡', hint: 'platform events, CDC' },
  { id: 'rest', label: 'REST Explorer', icon: '⇄', hint: 'any REST call' },
  { id: 'activity', label: 'Activity', icon: '⏱', hint: 'what was changed from here' },
  { id: 'orgaccess', label: 'Access', icon: '⚿', hint: 'users and permissions in two orgs' },
  { id: 'orgapps', label: 'Connected apps', icon: '⚷', hint: 'connected apps in two orgs' },
  { id: 'settings', label: 'Settings', icon: '⚙', hint: 'org, project, AI' },
  { id: 'local-orgs', label: 'CLI orgs', icon: '☁', hint: 'orgs of the CLI app' },
  { id: 'local-ai', label: 'AI settings', icon: '✦', hint: 'AI of the CLI app' },
];

export type Hub = { id: string; label: string; icon: string; tools: ToolId[] };

export const HUBS: Hub[] = [
  { id: 'develop', label: 'Develop', icon: '{}', tools: ['apex', 'code', 'apextests', 'logs', 'automation', 'jobs'] },
  {
    id: 'data',
    label: 'Data',
    icon: '⇅',
    tools: ['query', 'record', 'data', 'lookup', 'csvcompare', 'schema', 'fields'],
  },
  { id: 'protect', label: 'Data protection', icon: '⛁', tools: ['backup', 'lifecycle'] },
  { id: 'release', label: 'Release', icon: '⌂', tools: ['project', 'metadata', 'deployments', 'tests'] },
  {
    id: 'people',
    label: 'Access',
    icon: '⚿',
    tools: [
      'access',
      'permsets',
      'permissions',
      'assigned',
      'groups',
      'custperms',
      'compare',
      'accessmap',
      'objectaccess',
      'audit',
      'myaccess',
    ],
  },
  { id: 'org', label: 'Org', icon: '◈', tools: ['company', 'apps', 'health', 'limits', 'events', 'rest', 'activity'] },
  { id: 'between', label: 'Org to org', icon: '⇋', tools: ['orgdiff', 'migrate', 'orgaccess', 'orgapps'] },
  { id: 'local', label: 'Local app', icon: '☁', tools: ['local-orgs', 'local-ai'] },
  { id: 'settings', label: 'Settings', icon: '⚙', tools: ['settings'] },
];

/** Old page ids (links from the popup, VS Code, bookmarks) still open the right tool. */
const ALIASES: Record<string, ToolId> = { limits: 'limits' };

export const toolOf = (id: string): Tool | undefined => TOOLS.find((t) => t.id === (ALIASES[id] ?? id));

/** The guide's section for a tool (the website, docs/guide.html). */
const GUIDE = 'https://faridmasjedi.github.io/plugin-fm/guide.html';
const GUIDE_ANCHOR: Partial<Record<ToolId, string>> = { data: 'data-tool', 'local-orgs': 'cli', 'local-ai': 'ai' };
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
      i === active && initial !== p.tool && location.hash ? { ...p, tool: initial } : p
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

  return { ...layout, show, openHub, openBeside, close, resize, focus, full: layout.panes.length >= MAX_PANES };
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
  hasLocal,
}: {
  ws: WorkspaceState;
  available: (tool: ToolId) => boolean;
  hasLocal: boolean;
}) {
  const activeHub = hubOf(ws.panes[ws.active]?.tool ?? 'apex').id;
  const openHubs = new Set(ws.panes.map((p) => hubOf(p.tool).id));
  const hubs = HUBS.filter((h) => h.id !== 'settings' && (h.id !== 'local' || hasLocal) && h.tools.some(available));
  const entry = (h: Hub) => (
    <button
      key={h.id}
      className={`hub ${activeHub === h.id ? 'active' : ''} ${openHubs.has(h.id) ? 'open' : ''}`}
      onClick={() => ws.openHub(h)}
      draggable
      onDragStart={dragTool(
        (h.tools.includes(ws.lastTab[h.id]) ? ws.lastTab[h.id] : undefined) ?? h.tools.find(available) ?? h.tools[0]
      )}
      title={`${h.tools
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
                <span className="pane-hub" title={hub.label}>
                  <span className="icon">{hub.icon}</span>
                  <span className="hub-name">{hub.label}</span>
                </span>
                <div className="hub-tabs" role="tablist">
                  {tools.map((t) => {
                    const meta = toolOf(t)!;
                    return (
                      <button
                        key={t}
                        role="tab"
                        className={`hub-tab ${t === tool ? 'active' : ''}`}
                        ref={
                          t === tool ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined
                        }
                        title={`${meta.hint} · drag to the right to open beside`}
                        draggable
                        onDragStart={dragTool(t)}
                        onClick={() => ws.show(t, i)}
                      >
                        <span className="icon">{meta.icon}</span>
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
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
              <div className="pane-body">
                {kept.map((t) => (
                  <div key={`${t}:${resets[`${pane.key}:${t}`] ?? 0}`} className="tool-view" hidden={t !== tool}>
                    <PageTablesProvider tables={tablesOf(`${pane.key}:${t}`)}>{render(t, i)}</PageTablesProvider>
                  </div>
                ))}
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

/** ⌘/Ctrl + K: type a few letters, Enter opens the tool (Shift+Enter opens it beside). */
export function QuickJump({ ws, available }: { ws: WorkspaceState; available: (tool: ToolId) => boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [at, setAt] = useState(0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        setText('');
        setAt(0);
      } else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  // Names first (starting with the text, then containing it), then hubs, then descriptions
  const found = useMemo(() => {
    const q = text.trim().toLowerCase();
    const score = (t: Tool): number => {
      const label = t.label.toLowerCase();
      if (!q) return 1;
      if (label.startsWith(q)) return 4;
      if (label.includes(q)) return 3;
      if (hubOf(t.id).label.toLowerCase().includes(q)) return 2;
      return t.hint.toLowerCase().includes(q) ? 1 : 0;
    };
    return TOOLS.filter((t) => available(t.id))
      .map((t) => ({ t, s: score(t) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  }, [text, available]);
  if (!open) return null;
  const go = (tool: ToolId, beside: boolean) => {
    if (beside) ws.openBeside(tool);
    else ws.show(tool);
    setOpen(false);
  };
  return (
    <div className="quick-jump-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="quick-jump" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Jump to… (Enter opens, Shift+Enter opens beside)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setAt((a) => Math.min(found.length - 1, a + 1));
            else if (e.key === 'ArrowUp') setAt((a) => Math.max(0, a - 1));
            else if (e.key === 'Enter' && found[at]) go(found[at].id, e.shiftKey);
            else return;
            e.preventDefault();
          }}
        />
        <ul>
          {found.map((t, i) => (
            <li key={t.id}>
              <button
                className={i === at ? 'active' : ''}
                onMouseEnter={() => setAt(i)}
                onClick={(e) => go(t.id, e.shiftKey)}
              >
                <span className="icon">{t.icon}</span>
                <span className="qj-label">{t.label}</span>
                <span className="muted">{t.hint}</span>
                <span className="qj-hub">{hubOf(t.id).label}</span>
              </button>
            </li>
          ))}
          {!found.length && <li className="muted qj-none">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}

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
