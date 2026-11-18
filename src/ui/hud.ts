import type { Agent, WorldState } from '../../shared/protocol';
import type { ConnectionMode } from '../core/store';
import type { Anchor, FloorInfo, SiteInfo } from '../world/World';
import { chooseSpec, describeSpec, readCapacity } from '../core/office-plan';
import { eventBus } from '../core/event-bus';
import { looksFor, shirtFor, sourceLabel, STATUS_COLORS, STATUS_LABEL, teamAccent } from '../world/palette';
import { icon, type IconName } from './icons';
import { REPO_URL } from '../config';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const FLOORS_KEY_PREFIX = 'agent-floor:floors-collapsed:';

/** Collapsed is a personal preference per office type, so it outlives a reload. */
function readFloorsCollapsed(type: string) {
  try {
    return localStorage.getItem(FLOORS_KEY_PREFIX + type) === '1';
  } catch {
    return false;
  }
}

function saveFloorsCollapsed(type: string, on: boolean) {
  try {
    localStorage.setItem(FLOORS_KEY_PREFIX + type, on ? '1' : '0');
  } catch {
    /* storage unavailable: the rail still collapses for this visit */
  }
}

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

interface Tag {
  root: HTMLDivElement;
  /** Last values written to the DOM, so unchanged frames cost nothing. */
  last: { x: number; y: number; scale: number; o: string; z: number; near: boolean; sel: boolean };
  name: HTMLElement;
  role: HTMLElement;
  dot: HTMLElement;
  activity: HTMLElement;
  key: string;
}

interface Bubble {
  root: HTMLDivElement;
  until: number;
  last: { x: number; y: number; scale: number; o: string; z: number };
}

export interface HudActions {
  select(id: string | null): void;
  focusTeam(id: string): void;
  focusFloor(key: string): void;
  setCapacity(n: number, type?: 'studio' | 'tower' | 'campus'): void;
  frameAll(): void;
  clearFloorFocus(): void;
  toggleTheme(): void;
  toggleDollhouse(): void;
  startDemo(): void;
}

const SETUP: Record<string, { title: string; steps: { label: string; code: string }[]; note: string }> = {
  claude: {
    title: 'Claude Code',
    steps: [
      { label: 'Install', code: 'npm i -g agent-floor' },
      { label: 'Add the hooks to ~/.claude/settings.json', code: 'agent-floor setup claude --write' },
    ],
    note: 'Agent Floor opens by itself when a session starts. Every session gets an office named after its project folder; subagents walk in, get briefed, and report back.',
  },
  codex: {
    title: 'Codex',
    steps: [
      { label: 'Install', code: 'npm i -g agent-floor' },
      { label: 'Print the notify line for ~/.codex/config.toml', code: 'agent-floor setup codex' },
    ],
    note: 'Codex reports at the end of each turn, so its desk updates once per reply.',
  },
  cursor: {
    title: 'Cursor',
    steps: [
      { label: 'Install', code: 'npm i -g agent-floor' },
      { label: 'Add the hooks to ~/.cursor/hooks.json', code: 'agent-floor setup cursor --write' },
    ],
    note: 'Agent Floor only listens. It never answers a permission prompt for you.',
  },
  http: {
    title: 'Anything else',
    steps: [
      { label: 'Start the floor', code: 'npx agent-floor' },
      {
        label: 'Post an event from any language',
        code: `curl -X POST localhost:4317/events \\\n  -H 'content-type: application/json' \\\n  -d '{"type":"tool","agent":"bot-1","team":"Payments","tool":"Bash","activity":"Running tests"}'`,
      },
    ],
    note: 'Events: join, status, tool, message, task, leave. See docs/protocol.md.',
  },
};

export class Hud {
  private root = el('div', 'hud');
  private tagsLayer = el('div', 'tags');
  private bubblesLayer = el('div', 'bubbles');
  private tags = new Map<string, Tag>();
  private bubbles = new Map<string, Bubble>();
  private modePill = el('div', 'mode');
  private sitePill = el('span', 'site-pill');
  private floorsRail = el('nav', 'floors glass');
  private setup = el('div', 'setup-wrap');
  private demoNote = el('div', 'demo-note glass');
  private teamsDock = el('nav', 'teams glass');
  private card = el('aside', 'card glass');
  private sheet = el('div', 'sheet-wrap');
  private empty = el('div', 'empty glass');
  private themeBtn: HTMLButtonElement;
  private dollhouseBtn: HTMLButtonElement;
  private floorsBtn: HTMLButtonElement;
  private teamsKey = '';
  private cardKey = '';
  private floorsKey = '';
  private site: SiteInfo | null = null;
  private activeFloor: string | null = null;
  private setupFirst = false;
  private setupInput: HTMLInputElement | null = null;
  private setupPreview: HTMLElement | null = null;
  private state: WorldState | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private mode: ConnectionMode = 'connecting';
  private floorsCollapsed = false;

  constructor(container: HTMLElement, private actions: HudActions) {
    this.root.append(this.tagsLayer, this.bubblesLayer);

    // Top bar
    const top = el('header', 'topbar');
    const brand = el('div', 'brand glass');
    brand.innerHTML = `<span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="brand-name">Agent Floor</span>`;
    brand.append(this.sitePill, this.modePill);
    const tools = el('div', 'tools glass');
    const btn = (name: Parameters<typeof icon>[0], label: string, fn: () => void) => {
      const b = el('button', 'icon-btn', icon(name)) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.addEventListener('click', fn);
      tools.append(b);
      return b;
    };
    btn('cornersOut', 'Show everyone (F)', () => actions.frameAll());
    this.themeBtn = btn('moon', 'Switch theme (T)', () => actions.toggleTheme());
    this.dollhouseBtn = btn('houseSimple', 'Dollhouse view (V)', () => actions.toggleDollhouse());
    this.floorsBtn = btn('sidebarSimple', 'Hide the floor list (L)', () => this.setFloorsCollapsed(!this.floorsCollapsed));
    this.floorsBtn.setAttribute('aria-pressed', String(this.floorsCollapsed));
    btn('plug', 'Connect your agents', () => this.openSheet());
    const gh = el('a', 'icon-btn gh', icon('github')) as HTMLAnchorElement;
    gh.href = REPO_URL;
    gh.target = '_blank';
    gh.rel = 'noreferrer';
    gh.setAttribute('aria-label', 'Source on GitHub');
    gh.title = 'Source on GitHub';
    tools.append(gh);
    top.append(brand, tools);

    this.demoNote.innerHTML = `<span>You are looking at a demo floor.</span>`;
    const connect = el('button', 'link-btn', 'Connect your agents') as HTMLButtonElement;
    connect.type = 'button';
    connect.addEventListener('click', () => this.openSheet());
    this.demoNote.append(connect);

    const hint = el('div', 'hint', '<span>Drag to pan</span><span>Right-drag to orbit</span><span>Scroll to zoom</span><span>Click anyone</span>');

    this.empty.innerHTML = `<h2>The floor is empty</h2><p>Start an agent with the hooks installed and it will walk in and take a desk.</p>`;
    const emptyActions = el('div', 'row');
    const e1 = el('button', 'btn primary', `${icon('plug')}<span>Connect</span>`) as HTMLButtonElement;
    e1.type = 'button';
    e1.addEventListener('click', () => this.openSheet());
    const e2 = el('button', 'btn', `${icon('play')}<span>Watch demo</span>`) as HTMLButtonElement;
    e2.type = 'button';
    e2.addEventListener('click', () => actions.startDemo());
    emptyActions.append(e1, e2);
    this.empty.append(emptyActions);

    this.card.setAttribute('aria-live', 'polite');
    this.buildSheet();
    this.buildSetup();
    this.root.append(top, this.demoNote, this.teamsDock, this.card, this.empty, hint, this.sheet, this.floorsRail, this.setup);
    container.append(this.root);

    this.floorsRail.id = 'floors-rail';
    this.floorsBtn.setAttribute('aria-controls', this.floorsRail.id);
    this.applyFloorsCollapsed(this.floorsCollapsed);

    this.bindKeys();
    this.bindFloorEvents();
  }

  /**
   * World owns floor focus; every entry point (rail, minimap, number keys)
   * ends in `floor:selected`. The rail mirrors it, and a focused floor closes
   * the agent card because both live in the right-hand column.
   */
  private bindFloorEvents() {
    eventBus.on('floor:selected', ({ key }) => {
      if (key) this.actions.select(null);
      if (this.activeFloor === key) return;
      this.activeFloor = key;
      this.floorsKey = '';
      this.renderFloors();
    });
  }

  // ---------------------------------------------------------------- state

  setTheme(dark: boolean) {
    this.themeBtn.innerHTML = icon(dark ? 'sun' : 'moon');
  }

  setDollhouse(on: boolean) {
    this.dollhouseBtn.classList.toggle('active', on);
    this.dollhouseBtn.setAttribute('aria-pressed', String(on));
  }

  setMode(mode: ConnectionMode) {
    this.mode = mode;
    const label = { live: 'Live', demo: 'Demo', connecting: 'Connecting', offline: 'Offline' }[mode];
    this.modePill.className = `mode ${mode}`;
    this.modePill.innerHTML = `<span class="pulse" aria-hidden="true"></span>${label}`;
    this.root.classList.toggle('is-demo', mode === 'demo');
    this.updateEmpty();
  }

  setState(state: WorldState, selected: string | null) {
    this.state = state;
    this.selected = selected;
    this.renderTeams();
    this.renderCard();
    this.updateEmpty();
  }

  // ---------------------------------------------------------------- site & floors

  /** The building plan from the world: mode, storeys and live occupancy. */
  setSite(site: SiteInfo, selectedFloor: string | null) {
    if (selectedFloor) this.activeFloor = selectedFloor;
    else if (this.activeFloor && !site.floors.some((f) => f.key === this.activeFloor)) this.activeFloor = null;
    this.site = site;
    const key = `${site.key}|${this.activeFloor}|${site.floors
      .map((f) => `${f.key}:${f.agents}:${f.capacity}:${f.vacant ? 1 : 0}`)
      .join('|')}`;
    if (key === this.floorsKey) return;
    this.floorsKey = key;
    // Read persisted collapsed preference for this office type.
    this.floorsCollapsed = readFloorsCollapsed(site.mode);
    this.applyFloorsCollapsed(this.floorsCollapsed);
    this.renderFloors();
  }

  private renderFloors() {
    const site = this.site;
    this.floorsRail.innerHTML = '';
    this.sitePill.textContent = site ? site.label : '';
    if (!site || !site.floors.length) {
      this.floorsRail.classList.remove('show');
      return;
    }
    this.floorsRail.classList.add('show');
    this.floorsRail.setAttribute('aria-label', `${site.label} floors`);

    // Minimised state: one compact pill, so the columns stay clear but the
    // office is still one click away.
    const mini = el('button', 'rail-mini') as HTMLButtonElement;
    mini.type = 'button';
    mini.title = `Show the floor list (L)`;
    mini.setAttribute('aria-label', 'Show the floor list');
    mini.innerHTML = `${icon('buildings')}<span class="rail-mini-label">${esc(site.label)}</span><b>${site.agents}/${site.capacity}</b>${icon('caretRight')}`;
    mini.addEventListener('click', () => this.setFloorsCollapsed(false));
    this.floorsRail.append(mini);

    const body = el('div', 'floors-body');
    const head = el('div', 'floors-head');
    head.append(el('span', 'floors-mode', esc(site.label)));
    const size = el('button', 'size-btn', `<span>${site.agents}/${site.capacity}</span>`) as HTMLButtonElement;
    size.type = 'button';
    size.title = 'Change the office size';
    size.setAttribute('aria-label', 'Change the office size');
    size.addEventListener('click', () => this.openSetup(false));
    head.append(size);
    body.append(head);

    const groups = new Map<string, FloorInfo[]>();
    for (const f of site.floors) {
      const list = groups.get(f.building) ?? [];
      list.push(f);
      groups.set(f.building, list);
    }

    for (const [building, list] of groups) {
      const section = el('div', 'floor-group');
      if (building) section.append(el('p', 'floor-building', esc(building)));
      // Top floor first, like a section through the building.
      for (const f of [...list].sort((a, b) => b.level - a.level)) {
        const pct = f.capacity > 0 ? Math.min(100, Math.round((f.agents / f.capacity) * 100)) : 0;
        const b = el(
          'button',
          `floor-btn${f.key === this.activeFloor ? ' active' : ''}${f.vacant ? ' vacant' : ''}${f.pavilion ? ' pavilion' : ''}`,
        ) as HTMLButtonElement;
        b.type = 'button';
        b.dataset.key = f.key;
        b.title = f.pavilion
          ? 'Cafeteria'
          : `${f.building || site.label} · ${f.label} · ${f.agents} of ${f.capacity} desks`;
        b.innerHTML = `<span class="floor-level">${esc(f.label)}</span><span class="floor-bar"><i style="width:${pct}%"></i></span><span class="floor-count">${f.pavilion ? 'Café' : `${f.agents}/${f.capacity}`}</span>`;
        b.addEventListener('click', () => {
          this.activeFloor = f.key;
          this.floorsKey = '';
          this.renderFloors();
          this.actions.focusFloor(f.key);
        });
        section.append(b);
      }
      body.append(section);
    }

    this.floorsRail.append(body);
  }

  /** Collapse the rail to a pill. The topbar button and the L key use it. */
  private setFloorsCollapsed(on: boolean) {
    if (on === this.floorsCollapsed) return;
    this.applyFloorsCollapsed(on);
    const type = this.site?.mode ?? 'studio';
    saveFloorsCollapsed(type, on);
  }

  private applyFloorsCollapsed(on: boolean) {
    this.floorsCollapsed = on;
    this.floorsRail.classList.toggle('collapsed', on);
    this.floorsBtn.classList.toggle('active', on);
    this.floorsBtn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Show the floor list (L)' : 'Hide the floor list (L)';
    this.floorsBtn.setAttribute('aria-label', label);
    this.floorsBtn.title = label;
  }

  // ---------------------------------------------------------------- office size

  private setupStep: 'type' | 'count' = 'type';
  private setupType: 'studio' | 'tower' | 'campus' = 'studio';

  private buildSetup() {
    const typeOptions: { value: 'studio' | 'tower' | 'campus'; label: string; desc: string; icon: IconName }[] = [
      { value: 'studio', label: 'Studio', desc: 'One open floor, up to 24 desks', icon: 'houseSimple' },
      { value: 'tower', label: 'Tower', desc: '2–4 stacked floors, shared lobby', icon: 'building' },
      { value: 'campus', label: 'Campus', desc: 'Multiple 2-storey buildings + café', icon: 'squaresFour' },
    ];
    const typeHtml = typeOptions
      .map(
        (t) => `
        <button type="button" class="type-btn" data-type="${t.value}">
          <span class="icon-wrap">${icon(t.icon)}</span>
          <b>${t.label}</b>
          <span>${esc(t.desc)}</span>
        </button>`,
      )
      .join('');

    const presets = [8, 20, 40, 80];
    const presetHtml = presets
      .map((n) => {
        const spec = chooseSpec(n);
        const caption = spec.mode === 'studio' ? 'Studio' : spec.mode === 'tower' ? `${spec.floors}-floor tower` : `${spec.buildings} buildings`;
        return `<button type="button" class="preset" data-n="${n}"><b>${n}</b><span>${esc(caption)}</span></button>`;
      })
      .join('');

    this.setup.innerHTML = `
      <div class="scrim"></div>
      <section class="setup glass" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <p class="setup-kicker">New office</p>
        <h2 id="setup-title">What kind of office do you want?</h2>
        <p class="setup-lede">Choose the layout first, then the size. You can change this any time.</p>
        <div class="type-grid" role="group" aria-label="Office type">${typeHtml}</div>
        <div class="count-step" hidden>
          <h3>How many agents do you run?</h3>
          <div class="presets" role="group" aria-label="Agent count presets">${presetHtml}</div>
          <label class="setup-field"><span>Exact number</span><input type="number" min="1" max="200" step="1" inputmode="numeric" value="${readCapacity() ?? 14}" /></label>
          <p class="setup-preview" aria-live="polite"></p>
        </div>
        <div class="setup-actions">
          <button type="button" class="btn primary next">Next</button>
          <button type="button" class="btn skip">Not now</button>
        </div>
      </section>`;
    this.setupInput = this.setup.querySelector<HTMLInputElement>('input')!;
    this.setupPreview = this.setup.querySelector<HTMLElement>('.setup-preview')!;
    const input = this.setupInput;
    const preview = this.setupPreview;
    const countStep = this.setup.querySelector<HTMLElement>('.count-step')!;
    const nextBtn = this.setup.querySelector<HTMLButtonElement>('.next')!;
    const typeBtns = this.setup.querySelectorAll<HTMLButtonElement>('.type-btn');

    const syncType = (t: 'studio' | 'tower' | 'campus') => {
      this.setupType = t;
      typeBtns.forEach((b) => b.classList.toggle('selected', b.dataset.type === t));
      nextBtn.disabled = false;
    };
    const syncCount = (n: number) => {
      const value = Number.isFinite(n) && n > 0 ? Math.min(200, Math.round(n)) : 14;
      input.value = String(value);
      preview.textContent = describeSpec(chooseSpec(value));
      this.setup.querySelectorAll<HTMLButtonElement>('.preset').forEach((b) => {
        b.classList.toggle('selected', Number(b.dataset.n) === value);
      });
    };

    typeBtns.forEach((b) =>
      b.addEventListener('click', () => syncType(b.dataset.type as 'studio' | 'tower' | 'campus')),
    );
    nextBtn.addEventListener('click', () => {
      if (this.setupStep === 'type') {
        this.setupStep = 'count';
        countStep.hidden = false;
        nextBtn.textContent = 'Build my office';
        nextBtn.classList.add('build');
        nextBtn.classList.remove('next');
      } else {
        this.actions.setCapacity(
          Math.max(1, Math.min(200, Math.round(Number(input.value) || 14))),
          this.setupType,
        );
        this.closeSetup();
      }
    });
    input.addEventListener('input', () => syncCount(Number(input.value)));
    this.setup.querySelectorAll<HTMLButtonElement>('.preset').forEach((b) =>
      b.addEventListener('click', () => syncCount(Number(b.dataset.n))),
    );
    this.setup.querySelector<HTMLButtonElement>('.skip')!.addEventListener('click', () => this.closeSetup());
    this.setup.querySelector('.scrim')!.addEventListener('click', () => {
      if (!this.setupFirst) this.closeSetup();
    });
    syncType(this.setupType);
    syncCount(readCapacity() ?? 14);
  }

  openSetup(firstRun = false) {
    this.setupFirst = firstRun;
    this.setupStep = 'type';
    this.setup.classList.toggle('first-run', firstRun);
    this.setup.classList.add('show');
    const current = readCapacity();
    if (current && this.setupInput && this.setupPreview) {
      this.setupInput.value = String(current);
      this.setupPreview.textContent = describeSpec(chooseSpec(current));
    }
    this.setup.querySelector<HTMLInputElement>('input')?.focus();
    this.setup.querySelector<HTMLInputElement>('input')?.select();
    // Reset UI for first step
    const countStep = this.setup.querySelector<HTMLElement>('.count-step');
    const nextBtn = this.setup.querySelector<HTMLButtonElement>('.build, .next');
    if (countStep) countStep.hidden = true;
    if (nextBtn) {
      nextBtn.textContent = 'Next';
      nextBtn.classList.add('next');
      nextBtn.classList.remove('build');
      nextBtn.disabled = false;
    }
    this.setup.querySelectorAll<HTMLButtonElement>('.type-btn').forEach((b) =>
      b.classList.toggle('selected', b.dataset.type === this.setupType),
    );
  }

  closeSetup() {
    this.setup.classList.remove('show', 'first-run');
    this.setupFirst = false;
  }

  setHovered(id: string | null) {
    this.hovered = id;
  }

  private updateEmpty() {
    const count = this.state ? Object.keys(this.state.agents).length : 0;
    this.empty.classList.toggle('show', this.mode === 'live' && count === 0);
  }

  // ---------------------------------------------------------------- teams dock

  private renderTeams() {
    const s = this.state!;
    const teams = Object.values(s.teams).sort((a, b) => a.order - b.order);
    const counts = new Map<string, number>();
    const attention = new Map<string, boolean>();
    for (const a of Object.values(s.agents)) {
      counts.set(a.team, (counts.get(a.team) || 0) + 1);
      if (a.status === 'waiting' || a.status === 'error') attention.set(a.team, true);
    }
    const key = teams.map((t) => `${t.id}:${t.name}:${counts.get(t.id)}:${attention.get(t.id) ? 1 : 0}`).join('|');
    if (key === this.teamsKey) return;
    this.teamsKey = key;
    this.teamsDock.innerHTML = '';
    this.teamsDock.classList.toggle('show', teams.length > 0);
    for (const t of teams) {
      const b = el('button', 'team-chip') as HTMLButtonElement;
      b.type = 'button';
      b.innerHTML = `<span class="swatch" style="background:${teamAccent(t.hue).getStyle()}"></span><span class="team-name">${esc(t.name)}</span><span class="count">${counts.get(t.id) || 0}</span>${attention.get(t.id) ? '<span class="flag" title="Someone needs attention"></span>' : ''}`;
      b.addEventListener('click', () => this.actions.focusTeam(t.id));
      this.teamsDock.append(b);
    }
    // Fade the right edge only when a chip is actually cut off.
    this.teamsDock.classList.toggle('overflowing', this.teamsDock.scrollWidth > this.teamsDock.clientWidth + 1);
  }

  // ---------------------------------------------------------------- agent card

  private renderCard() {
    const s = this.state!;
    const a = this.selected ? s.agents[this.selected] : undefined;
    if (!a) {
      this.card.classList.remove('show');
      this.cardKey = '';
      return;
    }
    const key = `${a.id}|${a.status}|${a.activity}|${a.history.length}|${a.history.at(-1)?.ts}|${this.activeFloor}|${Math.floor(Date.now() / 10000)}`;
    if (key === this.cardKey) return;
    this.cardKey = key;
    const team = s.teams[a.team];
    const parent = a.parent ? s.agents[a.parent] : undefined;
    const crew = Object.values(s.agents).filter((x) => x.parent === a.id);
    const hist = [...a.history].reverse().slice(0, 7);
    const color = STATUS_COLORS[a.status];
    const look = looksFor(a.id);
    const floor = this.site?.floors.find((f) => f.key === this.activeFloor);
    const where = floor ? (floor.pavilion ? 'Café' : `${floor.building ? `${floor.building} · ` : ''}${floor.label}`) : '';

    this.card.innerHTML = `
      <div class="card-head">
        <span class="avatar" style="--shirt:${shirtFor(a.role)};--skin:${look.skin};--hair:${look.hair}" aria-hidden="true"><i></i></span>
        <div class="who">
          <h2>${esc(a.name)}</h2>
          <p>${esc(a.role)} in ${esc(team?.name || a.team)}</p>
        </div>
        <button type="button" class="icon-btn close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="status-row">
        <span class="status-chip" style="--c:${color}"><span class="dot"></span>${STATUS_LABEL[a.status]}</span>
        ${where ? `<span class="where">${esc(where)}</span>` : ''}
        <span class="source">${esc(sourceLabel(a.source))}</span>
      </div>
      <div class="now">
        <p class="now-text">${esc(a.activity || 'Nothing yet')}</p>
        ${a.tool ? `<p class="now-tool">${esc(a.tool)}</p>` : ''}
      </div>
      ${
        parent || crew.length
          ? `<div class="links">${parent ? `<button type="button" class="person" data-id="${esc(parent.id)}">Reports to ${esc(parent.name)}</button>` : ''}${crew
              .map((c) => `<button type="button" class="person" data-id="${esc(c.id)}"><span class="mini-dot" style="background:${STATUS_COLORS[c.status]}"></span>${esc(c.name)}</button>`)
              .join('')}</div>`
          : ''
      }
      <ol class="history">
        ${hist
          .map(
            (h) =>
              `<li><span class="h-kind k-${h.kind}"></span><span class="h-text">${esc(h.kind === 'message' ? `Said "${h.text}"` : h.text)}</span><time>${ago(h.ts)}</time></li>`,
          )
          .join('')}
      </ol>`;
    this.card.querySelector('.close')!.addEventListener('click', () => this.actions.select(null));
    this.card.querySelectorAll<HTMLButtonElement>('.person').forEach((b) => b.addEventListener('click', () => this.actions.select(b.dataset.id!)));
    this.card.classList.add('show');
  }

  // ---------------------------------------------------------------- tags & bubbles (every frame)

  frame(anchors: Anchor[]) {
    const s = this.state;
    if (!s) return;
    const seen = new Set<string>();
    for (const an of anchors) {
      const agent = s.agents[an.id];
      if (!agent) continue;
      seen.add(an.id);
      let tag = this.tags.get(an.id);
      if (!tag) tag = this.makeTag(agent);
      this.updateTag(tag, agent);
      const near = an.depth < 15 || an.id === this.hovered || an.id === this.selected;
      const sel = an.id === this.selected;
      const show = an.visible && (an.depth < 70 || sel);
      const scale = Math.max(0.62, Math.min(1, 16 / an.depth));
      const L = tag.last;
      const o = show ? '1' : '0';
      if (o !== L.o) {
        tag.root.style.opacity = o;
        tag.root.style.visibility = show ? '' : 'hidden';
        L.o = o;
      }
      if (show) {
        // Only touch style/transform when the point moved enough to see.
        if (Math.abs(an.x - L.x) >= 0.5 || Math.abs(an.y - L.y) >= 0.5 || Math.abs(scale - L.scale) >= 0.002) {
          tag.root.style.transform = `translate3d(${an.x.toFixed(1)}px, ${an.y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
          L.x = an.x;
          L.y = an.y;
          L.scale = scale;
        }
        const z = 1000 - Math.round(an.depth * 4);
        if (z !== L.z) {
          tag.root.style.zIndex = String(z);
          L.z = z;
        }
      }
      if (near !== L.near) {
        tag.root.classList.toggle('near', near);
        L.near = near;
      }
      if (sel !== L.sel) {
        tag.root.classList.toggle('selected', sel);
        L.sel = sel;
      }

      const bubble = this.bubbles.get(an.id);
      if (bubble) {
        const lift = near ? 66 : 44;
        const by = an.y - lift * scale;
        const b = bubble.last;
        if (Math.abs(an.x - b.x) >= 0.5 || Math.abs(by - b.y) >= 0.5 || Math.abs(scale - b.scale) >= 0.002) {
          bubble.root.style.transform = `translate3d(${an.x.toFixed(1)}px, ${by.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
          b.x = an.x;
          b.y = by;
          b.scale = scale;
        }
        const op = show ? '' : '0';
        if (op !== b.o) {
          bubble.root.style.opacity = op;
          b.o = op;
        }
        const bz = 2000 - Math.round(an.depth * 10);
        if (bz !== b.z) {
          bubble.root.style.zIndex = String(bz);
          b.z = bz;
        }
      }
    }
    for (const [id, tag] of this.tags) {
      if (!seen.has(id)) {
        tag.root.remove();
        this.tags.delete(id);
      }
    }
    const now = performance.now();
    for (const [id, b] of this.bubbles) {
      if (now > b.until || !seen.has(id)) {
        b.root.classList.add('out');
        const r = b.root;
        setTimeout(() => r.remove(), 260);
        this.bubbles.delete(id);
      }
    }
  }

  private makeTag(agent: Agent): Tag {
    const root = el('div', 'tag');
    root.innerHTML = `<div class="tag-line"><span class="dot"></span><b></b><span class="role"></span></div><div class="activity"></div>`;
    root.addEventListener('click', () => this.actions.select(agent.id));
    this.tagsLayer.append(root);
    const tag: Tag = {
      root,
      name: root.querySelector('b')!,
      role: root.querySelector('.role')!,
      dot: root.querySelector('.dot')!,
      activity: root.querySelector('.activity')!,
      key: '',
      last: { x: -1, y: -1, scale: 0, o: '', z: 0, near: false, sel: false },
    };
    this.tags.set(agent.id, tag);
    return tag;
  }

  private updateTag(tag: Tag, a: Agent) {
    const key = `${a.name}|${a.role}|${a.status}|${a.activity}`;
    if (key === tag.key) return;
    tag.key = key;
    tag.name.textContent = a.name;
    tag.role.textContent = a.role.toLowerCase() === a.name.toLowerCase() ? '' : a.role;
    tag.dot.style.background = STATUS_COLORS[a.status];
    tag.root.dataset.status = a.status;
    tag.activity.textContent = a.activity || STATUS_LABEL[a.status];
  }

  say(id: string, text: string, toName?: string) {
    if (!text) return;
    let b = this.bubbles.get(id);
    if (!b) {
      const root = el('div', 'bubble') as HTMLDivElement;
      this.bubblesLayer.append(root);
      b = { root, until: 0, last: { x: -1, y: -1, scale: 0, o: '', z: 0 } };
      this.bubbles.set(id, b);
    }
    b.root.innerHTML = `${toName ? `<span class="to">To ${esc(toName)}</span>` : ''}<span class="said">${esc(text)}</span>`;
    b.root.classList.remove('out');
    // Restart the entrance animation for a fresh line.
    b.root.classList.remove('in');
    void b.root.offsetWidth;
    b.root.classList.add('in');
    b.until = performance.now() + Math.min(6500, 2600 + text.length * 45);
  }

  // ---------------------------------------------------------------- connect sheet

  private buildSheet() {
    this.sheet.innerHTML = `
      <div class="scrim"></div>
      <section class="sheet glass" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet-head">
          <h2 id="sheet-title">Connect your agents</h2>
          <button type="button" class="icon-btn close" aria-label="Close">${icon('x')}</button>
        </div>
        <p class="sheet-lede">Agent Floor runs on your machine. Your agents report what they are doing through hooks, and nothing leaves localhost.</p>
        <div class="tabs" role="tablist">
          ${Object.entries(SETUP)
            .map(([k, v], i) => `<button type="button" role="tab" class="tab${i === 0 ? ' active' : ''}" data-tab="${k}" aria-selected="${i === 0}">${v.title}</button>`)
            .join('')}
        </div>
        <div class="tab-body"></div>
      </section>`;
    const body = this.sheet.querySelector<HTMLDivElement>('.tab-body')!;
    const show = (k: string) => {
      const v = SETUP[k];
      body.innerHTML = `${v.steps
        .map(
          (s) => `<div class="step"><p>${esc(s.label)}</p><div class="code"><pre><code>${esc(s.code)}</code></pre><button type="button" class="icon-btn copy" aria-label="Copy">${icon('copy')}</button></div></div>`,
        )
        .join('')}<p class="note">${esc(v.note)}</p>`;
      body.querySelectorAll<HTMLButtonElement>('.copy').forEach((b) =>
        b.addEventListener('click', async () => {
          const code = b.parentElement!.querySelector('code')!.textContent || '';
          try {
            await navigator.clipboard.writeText(code);
            b.innerHTML = icon('check');
            setTimeout(() => (b.innerHTML = icon('copy')), 1400);
          } catch {
            /* clipboard blocked: the text is still selectable */
          }
        }),
      );
      this.sheet.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.tab === k);
        t.setAttribute('aria-selected', String(t.dataset.tab === k));
      });
    };
    show('claude');
    this.sheet.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab!)));
    this.sheet.querySelector('.close')!.addEventListener('click', () => this.closeSheet());
    this.sheet.querySelector('.scrim')!.addEventListener('click', () => this.closeSheet());
  }

  openSheet() {
    this.sheet.classList.add('show');
    this.sheet.querySelector<HTMLButtonElement>('.tab.active')?.focus();
  }

  closeSheet() {
    this.sheet.classList.remove('show');
  }

  // ---------------------------------------------------------------- keys

  private bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.setup.classList.contains('show')) {
        // The first-run question is modal; later visits can be dismissed.
        if (e.key === 'Escape' && !this.setupFirst) this.closeSetup();
        return;
      }
      if (e.key === 'Escape') {
        if (this.sheet.classList.contains('show')) this.closeSheet();
        else if (this.activeFloor) this.actions.clearFloorFocus();
        else this.actions.select(null);
      } else if (e.key === 'f' || e.key === 'F') this.actions.frameAll();
      else if (e.key === 't' || e.key === 'T') this.actions.toggleTheme();
      else if (/^[1-9]$/.test(e.key)) {
        const floor = this.site?.floors[Number(e.key) - 1];
        if (!floor) return;
        this.activeFloor = floor.key;
        this.floorsKey = '';
        this.renderFloors();
        this.actions.focusFloor(floor.key);
      } else if (e.key === 'c' || e.key === 'C') {
        if (!this.site?.floors.some((f) => f.pavilion)) return;
        this.activeFloor = 'pavilion';
        this.floorsKey = '';
        this.renderFloors();
        this.actions.focusFloor('pavilion');
      } else if (e.key === 'v' || e.key === 'V') {
        this.actions.toggleDollhouse();
      } else if (e.key === 'l' || e.key === 'L') {
        this.setFloorsCollapsed(!this.floorsCollapsed);
      } else if (e.key === ']' || e.key === '[') {
        const ids = Object.values(this.state?.agents || {})
          .sort((a, b) => (this.state!.teams[a.team]?.order ?? 0) - (this.state!.teams[b.team]?.order ?? 0) || a.joinedAt - b.joinedAt)
          .map((a) => a.id);
        if (!ids.length) return;
        const i = this.selected ? ids.indexOf(this.selected) : -1;
        const next = ids[(i + (e.key === ']' ? 1 : -1) + ids.length) % ids.length];
        this.actions.select(next);
      }
    });
  }
}
