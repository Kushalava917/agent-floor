import {
  ACESFilmicToneMapping,
  Frustum,
  Group,
  Matrix4,
  CanvasTexture,
  DirectionalLight,
  Fog,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  PCFShadowMap,
  PointLight,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  Object3D,
  Box3,
  Color,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Agent, Effect, WorldState } from '../../shared/protocol';
import { Character, findAgentId, PICK_LAYER } from './Character';
import { Courier } from './Courier';
import { computeLayout, SeatBook, type BuildingLayout } from './layout';
import { Building } from './Building';
import {
  buildingLabel,
  chooseSpec,
  chooseSpecByType,
  FLOOR_H,
  floorLabel,
  modeLabel,
  planSite,
  readCapacity,
  saveCapacity,
  type FloorPlan,
  type SitePlan,
} from '../core/office-plan';
import { setNightGlow } from './props';
import { applyThemeToMaterials } from './materials';
import { prefersReducedMotion } from './motion';
import { detectGpuTier, gfx, REC } from './quality';
import { PALETTES, teamAccent, type ThemeName } from './palette';
import { TeamRoom } from './TeamRoom';
import { setDeskLamps, Workstation } from './Workstation';
import { heatmap } from '../features/heatmap/heatmap';
import { initMinimap } from '../features/minimap/minimap';
import { initInspector } from '../features/inspector/inspector';
import { initWhispers } from '../features/whispers/whispers';
import { initTimeOfDay } from '../features/time-of-day/time-of-day';
import { initAmbient } from '../features/ambient/ambient';
import { initSeasons } from '../features/seasons/seasons';
import { initCommArcs } from '../features/comm-arcs/comm-arcs';
import { restoreGroup, setGroupGhost } from './ghost';
import { eventBus } from '../core/event-bus';

interface Seated {
  character: Character;
  desk: Workstation;
  team: string;
  floor: string;
  leaving: boolean;
}

interface FloorRuntime {
  key: string;
  spec: FloorPlan;
  group: Group;
  building: Building;
  layout: BuildingLayout;
  rooms: Map<string, TeamRoom>;
  book: SeatBook;
}

export interface FloorInfo {
  key: string;
  label: string;
  building: string;
  level: number;
  agents: number;
  capacity: number;
  vacant: boolean;
  pavilion: boolean;
  isGround: boolean;
  active: boolean;
}

export interface SiteInfo {
  key: string;
  mode: 'studio' | 'tower' | 'campus';
  label: string;
  floors: FloorInfo[];
  agents: number;
  capacity: number;
}

export interface Anchor {
  id: string;
  x: number;
  y: number;
  depth: number;
  visible: boolean;
}

export interface WorldCallbacks {
  onPick(agentId: string | null, teamId: string | null): void;
  onHover(agentId: string | null): void;
  onMessage(from: string, to: string, text: string): void;
}

function findTeamId(o: Object3D | null): string | undefined {
  while (o) {
    if (o.userData.teamId) return o.userData.teamId as string;
    o = o.parent;
  }
  return undefined;
}

export class World {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(34, 1, 0.1, 400);
  private controls: OrbitControls;
  /** Created lazily: only the night theme on a capable GPU needs the bloom pass. */
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private usePost = false;
  private hemi = new HemisphereLight();
  private sun = new DirectionalLight();
  private ground: Mesh;
  private groundMat: MeshStandardMaterial;
  private courier = new Courier();
  private agents = new Map<string, Seated>();
  private floors: FloorRuntime[] = [];
  private floorByKey = new Map<string, FloorRuntime>();
  private teamFloor = new Map<string, FloorRuntime>();
  private books = new Map<string, SeatBook>();
  private pavilion: FloorRuntime | null = null;
  private site: SitePlan | null = null;
  private siteKey = '';
  private capacity = readCapacity() ?? 14;
  /** User-chosen office type (studio/tower/campus). Defaults to auto. */
  private officeType: 'studio' | 'tower' | 'campus' | 'auto' = 'auto';
  /** The whole site's outline, the thing the camera frames. */
  private footprint() {
    const all = this.pavilion ? [...this.floors, this.pavilion] : this.floors;
    if (!all.length) return { cx: 0, cz: 0, w: 30, d: 20, h: 6, y0: 0, y1: 6 };
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0;
    for (const f of all) {
      const o = f.group.position;
      x0 = Math.min(x0, o.x + f.layout.x0);
      x1 = Math.max(x1, o.x + f.layout.x1);
      z0 = Math.min(z0, o.z + f.layout.z0);
      z1 = Math.max(z1, o.z + f.layout.z1);
      y1 = Math.max(y1, o.y + (this.dollhouse ? 3.4 : f.spec.top ? 3.4 : 3.0));
    }
    return {
      cx: (x0 + x1) / 2,
      cz: (z0 + z1) / 2,
      w: x1 - x0,
      d: z1 - z0,
      h: y1,
      y0: 0,
      y1,
    };
  }

  private floorOf(teamId: string) {
    return this.teamFloor.get(teamId);
  }
  private state: WorldState | null = null;
  private theme: ThemeName = 'light';
  private reduced = prefersReducedMotion();
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private pointerDirty = false;
  private downAt = new Vector2();
  private hovered: string | null = null;
  private selected: string | null = null;
  private last = performance.now();
  private elapsed = 0;
  private instantNext = true;
  private flight: { target: Vector3; position: Vector3; follow: string | null } | null = null;
  /** Camera flight velocities. Kept across re-targets so a new flight continues the motion. */
  private flightVel = { target: new Vector3(), position: new Vector3() };
  private following: string | null = null;
  private userDriving = false;
  private hasFramed = false;
  private portrait = false;
  /** Keep re-framing as teams arrive until the user takes the camera. */
  private autoFrame = true;
  private framedKey = '';
  /** Currently focused floor key (for inspector). */
  private activeFloor: string | null = null;
  /** Storeys faded out because a lower storey of the same building is focused. */
  private ghostedFloors = new Set<string>();
  /** Dollhouse mode: remove ceilings and lower walls so interiors are visible from above. */
  private dollhouse = false;

  // Feature controllers
  private minimap: ReturnType<typeof initMinimap> | null = null;
  private inspector: ReturnType<typeof initInspector> | null = null;
  private whispers: ReturnType<typeof initWhispers> | null = null;
  private timeOfDay: ReturnType<typeof initTimeOfDay> | null = null;
  private ambient: ReturnType<typeof initAmbient> | null = null;
  private seasons: ReturnType<typeof initSeasons> | null = null;
  private commArcs: ReturnType<typeof initCommArcs> | null = null;

  constructor(private container: HTMLElement, private cb: WorldCallbacks) {
    const bootStart = performance.now();
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Ask the GPU who it is before choosing shadow and pixel budgets.
    detectGpuTier(this.renderer.getContext());
    this.viewW = Math.max(1, container.clientWidth);
    this.viewH = Math.max(1, container.clientHeight);
    this.pixelRatio = this.idealPixelRatio();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    // The building barely moves; refresh shadows a few times a second, not every frame.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Count draws across every post-processing pass, not just the last one.
    this.renderer.info.autoReset = false;
    this.renderer.domElement.classList.add('scene');
    container.appendChild(this.renderer.domElement);

    // Lights: soft sky fill plus one sun for shadows.
    this.scene.add(this.hemi);
    this.sun.position.set(14, 24, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(REC ? 4096 : gfx.lite ? 1024 : 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    for (let i = 0; i < 6; i++) {
      const l = new PointLight('#ffd7a8', 0, 14, 1.6);
      l.position.set(0, -50, 0);
      this.nightLights.push(l);
      this.scene.add(l);
    }

    // Endless studio floor that fades into the sky.
    this.groundMat = new MeshStandardMaterial({ roughness: 0.95, map: floorTexture() });
    this.ground = new Mesh(new PlaneGeometry(600, 600), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.3;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground, this.courier.root);

    this.camera.position.set(18, 20, 24);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 420;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.32;
    // Map-like: drag to pan, right-drag to orbit, scroll to zoom.
    this.controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
    this.controls.addEventListener('start', () => {
      // The user grabbed the camera: hand control over immediately.
      this.userDriving = true;
      this.flight = null;
      this.flightVel.target.set(0, 0, 0);
      this.flightVel.position.set(0, 0, 0);
      this.following = null;
      this.autoFrame = false;
    });
    this.controls.addEventListener('end', () => (this.userDriving = false));

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => (this.reduced = e.matches));
    this.setTheme('light');
    this.initFeatures();

    // Listen for floor focus from the minimap / floor rail.
    eventBus.on('floor:focus', ({ key }) => this.focusFloor(key));

    // Build the planned shell behind the boot cover so the empty office reads.
    this.showPlan();
    // Pay the shader-compile bill now, behind the boot overlay, not mid-session.
    const warmStart = performance.now();
    this.warmUp();
    this.perf.warmMs = performance.now() - warmStart;
    this.perf.bootMs = performance.now() - bootStart;
    this.loop();
  }

  /**
   * Create (or recreate, after a reset) the feature controllers. They own DOM
   * overlays and scene props, so a demo reset has to rebuild them; reusing a
   * disposed instance leaves the campus map and floor inspector missing.
   */
  private initFeatures() {
    heatmap.setEnabled(true);
    this.minimap = initMinimap(this.container);
    this.inspector = initInspector(this.container);
    this.whispers = initWhispers();
    this.timeOfDay = initTimeOfDay({ cycleDuration: 24 * 60 * 1000 });
    this.ambient = initAmbient({ enabled: true });
    this.seasons = initSeasons({ hemisphere: 'north' });
    this.commArcs = initCommArcs();

    this.timeOfDay.init(this.sun, this.hemi, this.scene.fog as any, this.theme);
    this.timeOfDay.start();
    this.ambient.init(this.scene);
    this.commArcs.init(this.scene);
    this.seasons.subscribe((theme) => this.applySeasonalTheme(theme));
  }

  // ---------------------------------------------------------------- theme

  setTheme(theme: ThemeName) {
    this.theme = theme;
    const p = PALETTES[theme];
    this.scene.background = skyTexture(p.skyHorizon, p.sky);
    this.scene.fog = new Fog(p.sky, 80, 260);
    this.groundMat.color.set(p.floor);
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    // Bloom only matters at night, and integrated GPUs cannot afford the extra pass.
    this.usePost = theme === 'dark' && !gfx.lite && p.bloom > 0;
    if (this.usePost) this.ensureComposer();
    if (this.bloom) {
      this.bloom.strength = p.bloom;
      this.bloom.enabled = this.usePost;
    }
    applyThemeToMaterials(theme);
    setDeskLamps(p.lampIntensity);
    setNightGlow(theme === 'dark');
    // Heatmap only in light theme (more visible)
    heatmap.setEnabled(theme === 'light');
    for (const f of this.pavilion ? [...this.floors, this.pavilion] : this.floors) {
      f.building.setTheme(theme);
      for (const r of f.rooms.values()) r.setTheme(theme);
    }
    this.refreshRooms();
    if (this.ghostedFloors.size) this.applyFloorGhosts(true);
    this.shadowDirty = true;
    this.placeNightLights();
    eventBus.emit('ui:theme', { dark: theme === 'dark' });
  }

  /** Apply seasonal visual theme to the scene */
  private applySeasonalTheme(theme: import('../features/seasons/seasons').SeasonalTheme): void {
    // Sky colors
    this.scene.background = new Color(theme.sky.zenith);
    if (this.scene.fog) {
      this.scene.fog.color.set(theme.sky.fogColor);
    }

    // Ground color
    this.groundMat.color.set(theme.garden.groundColor);

    // Update garden vegetation (would need Building integration for full effect)
    // For now, emit event for Building to handle
    eventBus.emit('season:apply', { theme });
  }

  /** Toggle dollhouse view: remove ceilings, lower walls so you can see inside from above. */
  setDollhouse(on: boolean) {
    if (on === this.dollhouse) return;
    this.dollhouse = on;
    for (const f of this.pavilion ? [...this.floors, this.pavilion] : this.floors) {
      f.building.setDollhouse(on);
    }
    // The shell may have been rebuilt: re-apply any ghosting.
    this.applyFloorGhosts(true);
    // Heatmap less useful in dollhouse (see through walls)
    heatmap.setEnabled(!on && this.theme === 'light');
    this.shadowDirty = true;
    this.autoFrame = true;
    this.frameAll();
    eventBus.emit('ui:dollhouse', { enabled: on });
  }

  /** Current dollhouse state. */
  isDollhouse(): boolean {
    return this.dollhouse;
  }

  // ---------------------------------------------------------------- sync

  /** Reconcile the scene with world state. Cheap enough to call on every event. */
  private screenBudget = 0;
  private frustum = new Frustum();
  private projView = new Matrix4();
  /** ?rec (scripted recordings): fixed resolution, no adaptive drops. */
  private lockResolution = new URLSearchParams(location.search).has('rec');
  /** CSS-pixel viewport, cached so anchors() never reflows the HUD. */
  private viewW = 1;
  private viewH = 1;
  /** Set from idealPixelRatio(); the adaptive loop only moves within its budget. */
  private pixelRatio = 1;
  private slowFrames = 0;
  private fastFrames = 0;
  private frameNo = 0;
  private shadowDirty = true;
  /** A fixed pool of night lights that follows the camera: constant shader cost, no recompiles. */
  private nightLights: PointLight[] = [];

  private isNear(o: Object3D) {
    const p = o.getWorldPosition(this.tmpV);
    return p.distanceToSquared(this.camera.position) < 26 * 26 && this.frustum.containsPoint(p);
  }
  private tmpV = new Vector3();
  /** Reused by anchors(): no per-frame allocation. */
  private anchorV = new Vector3();
  private tmpSize = new Vector2();

  /**
   * Fraction of the viewport (in NDC, 1 = edge) that framing may use. Recordings
   * for Reels shrink it so content stays clear of the platform's overlays.
   */
  safeArea = { x: 1, y: 1 };

  readonly perf = { frameMs: 0, fps: 0, syncMs: 0, worstSyncMs: 0, calls: 0, triangles: 0, agents: 0, bootMs: 0, warmMs: 0 };

  sync(state: WorldState) {
    const t0 = performance.now();
    this.syncInner(state);
    const ms = performance.now() - t0;
    this.perf.syncMs = ms;
    this.perf.worstSyncMs = Math.max(this.perf.worstSyncMs * 0.995, ms);
  }

  private syncInner(state: WorldState) {
    this.state = state;
    const instant = this.instantNext;
    this.instantNext = false;

    const counts = new Map<string, number>();
    for (const a of Object.values(state.agents)) counts.set(a.team, (counts.get(a.team) || 0) + 1);
    const spec = this.officeType === 'auto' ? chooseSpec(this.capacity) : chooseSpecByType(this.officeType, this.capacity);
    const site = planSite(Object.values(state.teams), counts, this.capacity, spec);
    this.reconcile(site, state, instant);

    // Agents
    for (const agent of Object.values(state.agents)) {
      const floor = this.floorOf(agent.team);
      const room = floor?.layout.rooms.get(agent.team);
      const seat = room?.seats.get(agent.id);
      if (!floor || !room || !seat) continue;
      let s = this.agents.get(agent.id);
      if (s && (s.team !== agent.team || s.floor !== floor.key)) {
        this.dropAgent(agent.id);
        s = undefined;
      }
      if (!s) {
        const character = new Character(agent);
        const desk = new Workstation(agent);
        const roomObj = floor.rooms.get(agent.team)!;
        roomObj.floor.add(desk.root, character.root);
        desk.setSeat(seat, true);
        if (instant || this.reduced) character.setSeat(seat, true);
        else character.arrive(room.entry, seat);
        s = { character, desk, team: agent.team, floor: floor.key, leaving: false };
        this.agents.set(agent.id, s);
      } else {
        s.desk.setSeat(seat);
        s.character.setSeat(seat);
      }
      s.character.setStatus(agent.status);
      if (agent.status === 'offline' && !s.leaving) this.depart(agent.id);
    }

    // Departures: anyone no longer in state walks out.
    for (const id of this.agents.keys()) if (!state.agents[id]) this.depart(id);

    // Update heatmap with status counts per floor
    this.updateHeatmap(state);

    // Update minimap and inspector with current floor data
    this.updateFeatureControllers();

    this.refreshRooms();
    if (this.ghostedFloors.size) this.applyFloorGhosts();
    this.shadowDirty = true;

    this.fitShadows();
    if (!this.hasFramed && Object.keys(state.agents).length) {
      this.hasFramed = true;
      this.frameAll(true);
    } else if (this.autoFrame && !this.selected) {
      const b = this.footprint();
      const key = `${b.w.toFixed(1)}x${b.d.toFixed(1)}x${b.h.toFixed(1)}`;
      if (key !== this.framedKey) this.frameAll();
    }
  }

  /**
   * Bring the storeys in line with the plan. Shells and room furniture are kept
   * between syncs; only a changed shape or a new team builds anything.
   */
  private reconcile(site: SitePlan, state: WorldState, instant: boolean) {
    const seen = new Set<string>();
    for (const spec of site.floors) {
      seen.add(spec.key);
      let f = this.floorByKey.get(spec.key);
      if (!f) {
        const group = new Group();
        group.position.y = spec.level * FLOOR_H;
        const building = new Building({
          level: spec.level,
          ground: spec.ground,
          top: spec.top,
          street: spec.building === 0,
        });
        group.add(building.root);
        this.scene.add(group);
        f = {
          key: spec.key,
          spec,
          group,
          building,
          layout: null as unknown as BuildingLayout,
          rooms: new Map(),
          book: this.books.get(spec.key) ?? new SeatBook(),
        };
        this.books.set(spec.key, f.book);
        this.floorByKey.set(spec.key, f);
        this.floors.push(f);
        instant = true;
      }
      f.spec = spec;
      const sub = this.subset(state, spec.teams);
      const padWidth = spec.vacant
        ? Math.max(18, spec.capacity * 1.15)
        : Math.max(12, spec.capacity * 0.8);
      f.layout = computeLayout(sub, f.book, {
        vacant: spec.vacant,
        cafeteria: spec.ground && site.spec.mode !== 'campus',
        padWidth,
        meta: {
          level: spec.level,
          building: spec.building,
          ground: spec.ground,
          top: spec.top,
          capacity: spec.capacity,
        },
      });
      f.building.update(f.layout);
      this.syncRooms(f);
      if (!f.group.parent) this.scene.add(f.group);
    }

    for (const f of [...this.floors]) {
      if (seen.has(f.key)) continue;
      this.disposeFloor(f);
      this.floors = this.floors.filter((x) => x !== f);
      this.floorByKey.delete(f.key);
      this.books.delete(f.key);
    }

    // The campus cafeteria is a separate low pavilion south of the offices.
    if (site.cafeteria) {
      if (!this.pavilion) {
        const group = new Group();
        const building = new Building({ ground: true, top: true, pavilion: true, street: false });
        group.add(building.root);
        this.scene.add(group);
        this.pavilion = {
          key: 'pavilion',
          spec: { key: 'pavilion', building: 0, level: 0, ground: true, top: true, capacity: 0, teams: [], vacant: false, pavilion: true },
          group,
          building,
          layout: null as unknown as BuildingLayout,
          rooms: new Map(),
          book: new SeatBook(),
        };
        instant = true;
      }
      const empty = { teams: {}, agents: {}, seq: 0, updatedAt: 0 };
      this.pavilion.layout = computeLayout(empty, this.pavilion.book, {
        meta: { ground: true, top: true, pavilion: true, level: 0, capacity: 0 },
        padWidth: 22,
      });
      this.pavilion.building.update(this.pavilion.layout);
      this.syncRooms(this.pavilion);
    } else if (this.pavilion) {
      this.disposeFloor(this.pavilion);
      this.pavilion = null;
    }

    this.placeBuildings(site);
    this.teamFloor.clear();
    for (const f of this.floors) for (const id of f.spec.teams) this.teamFloor.set(id, f);

    this.site = site;
    this.siteKey = this.floors.map((f) => f.layout.key).join('~') + (this.pavilion ? '|p' : '');
    if (instant) this.autoFrame = true;
    this.shadowDirty = true;
  }

  private subset(state: WorldState, teamIds: string[]): WorldState {
    const keep = new Set(teamIds);
    const teams: WorldState['teams'] = {};
    const agents: WorldState['agents'] = {};
    for (const id of teamIds) if (state.teams[id]) teams[id] = state.teams[id];
    for (const a of Object.values(state.agents)) if (keep.has(a.team)) agents[a.id] = a;
    return { teams, agents, seq: state.seq, updatedAt: state.updatedAt };
  }

  private syncRooms(f: FloorRuntime) {
    for (const [id, room] of f.layout.rooms) {
      let r = f.rooms.get(id);
      if (!r) {
        r = new TeamRoom(room.team, this.theme);
        f.rooms.set(id, r);
        f.group.add(r.root);
      }
      r.layout(room);
    }
    for (const [id, r] of f.rooms) {
      if (!f.layout.rooms.has(id)) {
        r.dispose();
        f.rooms.delete(id);
      }
    }
  }

  /** Arrange buildings on the site: a row of campus pavilions, or one tower. */
  private placeBuildings(site: SitePlan) {
    if (site.spec.mode !== 'campus') {
      for (const f of this.floors) {
        const c = { x: (f.layout.x0 + f.layout.x1) / 2, z: (f.layout.z0 + f.layout.z1) / 2 };
        f.group.position.x = -c.x;
        f.group.position.z = -c.z;
        f.group.position.y = f.spec.level * FLOOR_H;
      }
      return;
    }

    const groups = new Map<number, FloorRuntime[]>();
    for (const f of this.floors) {
      const list = groups.get(f.spec.building) ?? [];
      list.push(f);
      groups.set(f.spec.building, list);
    }
    const gap = 18;
    const widths = new Map<number, number>();
    let total = 0;
    for (const [id, list] of [...groups].sort((a, b) => a[0] - b[0])) {
      const w = Math.max(...list.map((f) => f.layout.x1 - f.layout.x0));
      widths.set(id, w);
      total += w;
    }
    total += gap * Math.max(0, groups.size - 1);
    let x = -total / 2;
    for (const [id, list] of [...groups].sort((a, b) => a[0] - b[0])) {
      const w = widths.get(id)!;
      const cx = x + w / 2;
      for (const f of list) {
        const c = { x: (f.layout.x0 + f.layout.x1) / 2, z: (f.layout.z0 + f.layout.z1) / 2 };
        f.group.position.x = cx - c.x;
        f.group.position.z = -c.z;
        f.group.position.y = f.spec.level * FLOOR_H;
      }
      x += w + gap;
    }
    if (this.pavilion) {
      const c = {
        x: (this.pavilion.layout.x0 + this.pavilion.layout.x1) / 2,
        z: (this.pavilion.layout.z0 + this.pavilion.layout.z1) / 2,
      };
      this.pavilion.group.position.x = -c.x;
      this.pavilion.group.position.z = 32 - c.z;
      this.pavilion.group.position.y = 0;
    }
  }

  private disposeFloor(f: FloorRuntime) {
    for (const r of f.rooms.values()) r.dispose();
    f.rooms.clear();
    restoreGroup(f.group);
    f.building.dispose();
    f.group.removeFromParent();
  }

  /** Redraw door signs and whiteboards (cheap: each room skips when nothing changed). */
  private refreshRooms() {
    if (!this.state) return;
    const byTeam = new Map<string, Agent[]>();
    for (const a of Object.values(this.state.agents)) {
      if (!byTeam.has(a.team)) byTeam.set(a.team, []);
      byTeam.get(a.team)!.push(a);
    }
    for (const f of this.floors) {
      for (const r of f.rooms.values()) {
        const team = this.state.teams[r.id];
        if (team) r.refresh(team, byTeam.get(r.id) || [], this.theme === 'dark');
      }
    }
  }

  /** Compute status density per floor and update heatmap. */
  private updateHeatmap(state: WorldState): void {
    const floorCounts = new Map<string, Map<string, number>>();
    for (const f of this.floors) {
      const counts = new Map<string, number>();
      for (const teamId of f.spec.teams) {
        const teamAgents = Object.values(state.agents).filter((a) => a.team === teamId);
        for (const a of teamAgents) {
          counts.set(a.status, (counts.get(a.status) || 0) + 1);
        }
      }
      // Also count agents on this floor directly (for agents not in spec.teams yet)
      for (const a of Object.values(state.agents)) {
        const agentFloor = this.agents.get(a.id)?.floor;
        if (agentFloor === f.key) {
          counts.set(a.status, (counts.get(a.status) || 0) + 1);
        }
      }
      if (counts.size > 0) {
        floorCounts.set(f.key, counts);
      }
    }
    // Pavilion
    if (this.pavilion) {
      const counts = new Map<string, number>();
      for (const a of Object.values(state.agents)) {
        const agentFloor = this.agents.get(a.id)?.floor;
        if (agentFloor === 'pavilion') {
          counts.set(a.status, (counts.get(a.status) || 0) + 1);
        }
      }
      if (counts.size > 0) floorCounts.set('pavilion', counts);
    }
    heatmap.updateFromCounts(floorCounts);
  }

  /** Update minimap and inspector with current floor/agent data. */
  private updateFeatureControllers(): void {
    if (!this.minimap || !this.inspector) return;

    const floorData = this.floors.map((f) => {
      const agentCount = [...this.agents.values()].filter(
        (a) => a.floor === f.key && !a.leaving
      ).length;
      const bounds = this.storeyBounds(f);
      return {
        key: f.key,
        building: f.spec.building,
        level: f.spec.level,
        bounds,
        worldBounds: bounds.clone(),
        active: agentCount > 0,
        pavilion: false,
        agentCount,
      };
    });

    if (this.pavilion) {
      const agentCount = [...this.agents.values()].filter(
        (a) => a.floor === 'pavilion' && !a.leaving
      ).length;
      const bounds = this.storeyBounds(this.pavilion);
      floorData.push({
        key: 'pavilion',
        building: 0,
        level: 0,
        bounds,
        worldBounds: bounds.clone(),
        active: agentCount > 0,
        pavilion: true,
        agentCount,
      });
    }

    this.minimap.updateFloors(floorData);

    // Feature controllers that follow the focused floor.
    this.updateInspector();

    // Update comm arcs with agent team colors
    const agentTeams = new Map<string, string>();
    for (const [id, s] of this.agents) {
      if (!s.leaving) agentTeams.set(id, s.team);
    }
    this.commArcs?.updateAgentTeams?.(agentTeams);
  }

  /** Plan footprint of one storey, for the campus map (excludes yards and street). */
  private storeyBounds(f: FloorRuntime): Box3 {
    const o = f.group.position;
    const l = f.layout;
    return new Box3(
      new Vector3(o.x + l.x0, o.y, o.z + l.z0),
      new Vector3(o.x + l.x1, o.y + FLOOR_H, o.z + l.z1),
    );
  }

  /** Feed the focused floor's teams to the side panel. */
  private updateInspector(): void {
    if (!this.inspector) return;
    if (!this.activeFloor) {
      this.inspector.hide();
      return;
    }
    const floor = this.floorByKey.get(this.activeFloor) ?? (this.pavilion?.key === this.activeFloor ? this.pavilion : null);
    if (!floor?.layout) return;

    const teams = Array.from(floor.layout.rooms.values()).map((room) => {
      const teamAgents = [...this.agents.values()].filter((a) => a.team === room.team.id && !a.leaving);
      return {
        id: room.team.id,
        name: room.team.name,
        hue: room.team.hue,
        order: room.team.order,
        members: teamAgents.map((a) => {
          const agent = this.state?.agents[a.character.id];
          return {
            id: a.character.id,
            name: agent?.name ?? a.character.id,
            role: agent?.role ?? '',
            source: agent?.source ?? '',
            status: agent?.status ?? 'offline',
            activity: agent?.activity ?? '',
            tool: agent?.tool,
            parent: agent?.parent,
          };
        }),
        task: room.team.task,
      };
    });

    this.inspector.updateFloor({
      key: floor.key,
      building: floor.spec.building,
      level: floor.spec.level,
      pavilion: floor.spec.pavilion ?? false,
      teams,
      totalAgents: teams.reduce((sum, t) => sum + t.members.length, 0),
      capacity: floor.spec.capacity,
    });
  }

  private depart(id: string) {
    const s = this.agents.get(id);
    if (!s || s.leaving) return;
    s.leaving = true;
    const room = this.floorByKey.get(s.floor)?.layout.rooms.get(s.team);
    // Walk back out the way they came: through the office door, down the corridor, out the front.
    const exit: [number, number][] = room ? [...room.entry].reverse() : [[0, 6]];
    if (this.reduced) return this.dropAgent(id);
    s.character.leave(exit, () => this.dropAgent(id));
  }

  private dropAgent(id: string) {
    const s = this.agents.get(id);
    if (!s) return;
    s.character.dispose();
    s.desk.dispose();
    this.agents.delete(id);
    if (this.selected === id) this.cb.onPick(null, null);
    // Remove empty rooms once everyone has walked out.
    const team = s.team;
    const floor = this.floorByKey.get(s.floor);
    if (floor && ![...this.agents.values()].some((a) => a.team === team) && !floor.layout.rooms.has(team)) {
      floor.rooms.get(team)?.dispose();
      floor.rooms.delete(team);
    }
  }

  reset() {
    for (const id of [...this.agents.keys()]) this.dropAgent(id);
    for (const f of this.floors) this.disposeFloor(f);
    this.floors = [];
    this.floorByKey.clear();
    this.teamFloor.clear();
    this.books.clear();
    if (this.pavilion) {
      this.disposeFloor(this.pavilion);
      this.pavilion = null;
    }
    this.courier.clear();
    this.state = null;
    this.instantNext = true;
    this.hasFramed = false;
    this.autoFrame = true;
    this.activeFloor = null;
    this.ghostedFloors.clear();
    // Dispose feature controllers
    this.minimap?.dispose();
    this.inspector?.dispose();
    this.whispers?.dispose();
    this.timeOfDay?.dispose();
    this.ambient?.dispose();
    this.seasons?.dispose();
    this.commArcs?.dispose();
    this.minimap = null;
    this.inspector = null;
    this.whispers = null;
    this.timeOfDay = null;
    this.ambient = null;
    this.seasons = null;
    this.commArcs = null;
    this.showPlan();
    this.initFeatures();
  }

  handleEffect(effect: Effect) {
    if (effect.kind === 'reset') return this.reset();
    if (effect.kind !== 'message') return;
    const from = this.agents.get(effect.from);
    const to = this.agents.get(effect.to);
    if (!from || !to) return;
    const a = from.character.headWorld();
    const b = to.character.headWorld();
    from.character.lookAtWorld(b, 2.6, true);
    this.cb.onMessage(effect.from, effect.to, effect.text);
    const team = this.state?.teams[from.team];
    const color = team ? teamAccent(team.hue).getStyle() : '#ff5f2e';
    this.courier.send(a.add(new Vector3(0, 0.35, 0)), b.add(new Vector3(0, 0.35, 0)), color, this.reduced, () => {
      to.character.lookAtWorld(from.character.headWorld(), 1.8);
      this.courier.ripple(to.character.root.getWorldPosition(new Vector3()), color);
    });
  }

  // ---------------------------------------------------------------- selection & camera

  setSelected(id: string | null) {
    if (this.selected) this.agents.get(this.selected)?.character.setSelected(false);
    this.selected = id;
    if (id) {
      // Looking at a person while a floor is focused: keep the floor ghosting
      // so upper storeys stay hidden. Only clear floor focus if explicitly requested.
      this.agents.get(id)?.character.setSelected(true);
      this.focusAgent(id);
    }
  }

  focusAgent(id: string) {
    const s = this.agents.get(id);
    if (!s) return;
    // Someone chose what to look at: stop re-framing on their behalf.
    this.autoFrame = false;
    const p = s.character.root.getWorldPosition(new Vector3());
    const target = p.clone().add(new Vector3(0, 0.9, 0));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // Keep the viewing angle the user chose, just come closer.
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    this.flyTo(target, target.clone().add(dir.multiplyScalar(9)), id);
  }

  focusTeam(id: string) {
    const floor = this.floorOf(id);
    const r = floor?.rooms.get(id);
    if (!floor || !r) return;
    this.autoFrame = false;
    const { w, d } = r.size;
    const o = floor.group.position;
    const c = { x: o.x + r.center.x, z: o.z + r.center.z };
    const target = new Vector3(c.x, o.y + 0.6, c.z);
    const dir = new Vector3(0.55, 0.85, 1).normalize();
    const dist = this.fitDistance([{ x: c.x, z: c.z, w, d, y0: o.y, y1: o.y + 2.6 }], target, dir, 0.92);
    this.flyTo(target, target.clone().add(dir.multiplyScalar(dist)), null);
  }

  /** Jump to a storey, or the cafeteria pavilion. */
  focusFloor(key: string) {
    const f = key === 'pavilion' ? this.pavilion : this.floorByKey.get(key);
    if (!f) return;
    this.activeFloor = key;
    this.applyFloorGhosts();
    this.inspector?.showFloor(key);
    this.updateInspector();
    eventBus.emit('floor:selected', { key });
    this.autoFrame = false;
    const o = f.group.position;
    const l = f.layout;
    const c = { x: o.x + (l.x0 + l.x1) / 2, z: o.z + (l.z0 + l.z1) / 2 };
    const target = new Vector3(c.x, o.y + 0.8, c.z);
    const dir = new Vector3(0.4, 0.8, 1).normalize();
    const dist = this.fitDistance(
      [{ x: c.x, z: c.z, w: l.x1 - l.x0, d: l.z1 - l.z0, y0: o.y, y1: o.y + 3.1 }],
      target,
      dir,
      0.94,
    );
    // Ensure camera doesn't end up inside another building (campus mode).
    const position = target.clone().add(dir.multiplyScalar(dist));
    this.avoidBuildingCollision(target, position);
    this.flyTo(target, position, null);
  }

  /** Nudge camera out of other buildings' footprints in campus mode. */
  private avoidBuildingCollision(target: Vector3, position: Vector3) {
    if (this.site?.spec.mode !== 'campus') return;
    const buildings = new Map<number, { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number }>();
    for (const fl of this.floors) {
      if (fl.key === this.activeFloor) continue;
      const b = buildings.get(fl.spec.building);
      const o = fl.group.position;
      const l = fl.layout;
      const entry = b ?? { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, y0: o.y, y1: o.y + FLOOR_H };
      entry.minX = Math.min(entry.minX, o.x + l.x0);
      entry.maxX = Math.max(entry.maxX, o.x + l.x1);
      entry.minZ = Math.min(entry.minZ, o.z + l.z0);
      entry.maxZ = Math.max(entry.maxZ, o.z + l.z1);
      entry.y0 = Math.min(entry.y0, o.y);
      entry.y1 = Math.max(entry.y1, o.y + FLOOR_H);
      buildings.set(fl.spec.building, entry);
    }
    if (!buildings.size) return;
    // Ray from target to position: check if it passes through any building.
    const dir = position.clone().sub(target).normalize();
    const maxStep = 60;
    let p = target.clone();
    for (let step = 0; step < maxStep; step++) {
      let inside = false;
      for (const b of buildings.values()) {
        if (p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ && p.y > b.y0 && p.y < b.y1) {
          inside = true;
          break;
        }
      }
      if (!inside) break;
      p.addScaledVector(dir, 1.0);
    }
    if (p.distanceTo(target) > 0.5) position.copy(p);
  }

  /** Leave floor view: bring every storey back to full opacity. */
  clearFloorFocus() {
    if (!this.activeFloor) return;
    this.activeFloor = null;
    this.applyFloorGhosts();
    this.inspector?.hide();
    eventBus.emit('floor:selected', { key: null });
  }

  /** The floor currently in focus, if any. */
  activeFloorKey(): string | null {
    return this.activeFloor;
  }

  /**
   * Fade the storeys above the focused floor so the cutaway stays readable.
   * Only the same building is affected: campus neighbours keep their walls.
   */
  private applyFloorGhosts(refresh = false) {
    const active = this.activeFloor
      ? this.floorByKey.get(this.activeFloor) ?? (this.pavilion?.key === this.activeFloor ? this.pavilion : null)
      : null;
    const focusLevel = active && !active.spec.pavilion ? active.spec.level : null;
    const focusBuilding = active && !active.spec.pavilion ? active.spec.building : null;

    this.ghostedFloors.clear();
    for (const f of this.floors) {
      const above = focusLevel !== null && f.spec.building === focusBuilding && f.spec.level > focusLevel;
      if (above) {
        this.ghostedFloors.add(f.key);
        // A theme change recolours the originals; refresh the clones so the
        // ghost matches instead of keeping the colours it was born with.
        if (refresh && f.group.userData.ghosted) setGroupGhost(f.group, false);
        setGroupGhost(f.group, true);
      } else if (f.group.userData.ghosted) {
        setGroupGhost(f.group, false);
      }
    }
    if (this.pavilion?.group.userData.ghosted) setGroupGhost(this.pavilion.group, false);
    this.shadowDirty = true;
  }

  /** Snapshot for the HUD: the site summary and how full each storey is. */
  siteInfo(): SiteInfo {
    const mode = this.site?.spec.mode ?? chooseSpec(this.capacity).mode;
    const countOn = (key: string) => {
      let n = 0;
      for (const a of this.agents.values()) if (a.floor === key && !a.leaving) n++;
      return n;
    };
    const floors: FloorInfo[] = [...this.floors]
      .sort((a, b) => a.spec.building - b.spec.building || a.spec.level - b.spec.level)
      .map((f) => {
        const agents = countOn(f.key);
        return {
          key: f.key,
          label: floorLabel(f.spec.level),
          building: buildingLabel(f.spec.building, this.site?.spec.buildings ?? 1),
          level: f.spec.level,
          agents,
          capacity: f.spec.capacity,
          vacant: agents === 0,
          pavilion: false,
          isGround: f.spec.ground,
          active: agents > 0,
        };
      });
    if (this.pavilion) {
      floors.push({
        key: 'pavilion',
        label: 'Café',
        building: '',
        level: 0,
        agents: 0,
        capacity: 0,
        vacant: true,
        pavilion: true,
        isGround: true,
        active: false,
      });
    }
    return {
      key: `${this.siteKey}|${this.capacity}`,
      mode,
      label: modeLabel(mode),
      floors,
      agents: Object.keys(this.state?.agents ?? {}).length,
      capacity: this.capacity,
    };
  }

  /** Which floor an agent is standing on, for HUD badges. */
  floorOfAgent(id: string) {
    return this.agents.get(id)?.floor ?? null;
  }

  /**
   * Re-plan the whole site for a new agent count. Empty floors and the campus
   * pavilion are built straight away, so the answer is visible before the
   * first agent connects.
   */
  setCapacity(n: number, type?: 'studio' | 'tower' | 'campus') {
    if (type) this.officeType = type;
    if (n === this.capacity && this.floors.length) return;
    this.capacity = n;
    saveCapacity(n);
    this.instantNext = true;
    this.autoFrame = true;
    this.hasFramed = false;
    if (this.state) {
      this.syncInner(this.state);
      this.frameAll();
    } else {
      this.showPlan();
    }
    this.shadowDirty = true;
  }

  /** Build the planned shell with no agents in it. */
  private showPlan() {
    const empty: WorldState = { teams: {}, agents: {}, seq: 0, updatedAt: Date.now() };
    const spec = this.officeType === 'auto' ? chooseSpec(this.capacity) : chooseSpecByType(this.officeType, this.capacity);
    this.reconcile(planSite([], new Map(), this.capacity, spec), empty, true);
    this.frameAll(true);
    this.shadowDirty = true;
  }

  /**
   * Fit a set of floor rectangles into the viewport.
   * Binary-searches the distance along `dir`, then nudges the target in screen
   * space so the content is centred, and repeats. Mutates `target`.
   */
  private fitDistance(
    rects: { x: number; z: number; w: number; d: number; y0?: number; y1?: number }[],
    target: Vector3,
    dir: Vector3,
    margin: number,
  ) {
    const probe = this.camera.clone();
    const corners: Vector3[] = [];
    for (const r of rects)
      for (const x of [r.x - r.w / 2, r.x + r.w / 2])
        for (const z of [r.z - r.d / 2, r.z + r.d / 2])
          for (const y of [r.y0 ?? 0, r.y1 ?? 2.2]) corners.push(new Vector3(x, y, z));
    const v = new Vector3();
    const extent = (dist: number) => {
      probe.position.copy(target).addScaledVector(dir, dist);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of corners) {
        v.copy(p).project(probe);
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
      return { minX, maxX, minY, maxY };
    };
    // Vertical budget is smaller: the top bar and team dock take space.
    const fits = (dist: number) => {
      const e = extent(dist);
      const sx = margin * this.safeArea.x;
      const sy = this.safeArea.y;
      return e.minX >= -sx && e.maxX <= sx && e.minY >= Math.max(-margin + 0.16, -sy) && e.maxY <= Math.min(margin - 0.14, sy);
    };
    let dist = 30;
    for (let pass = 0; pass < 3; pass++) {
      let lo = 3;
      let hi = 200;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      dist = hi;
      const e = extent(dist);
      const cx = (e.minX + e.maxX) / 2;
      const cy = (e.minY + e.maxY) / 2 - 0.01;
      const halfH = dist * Math.tan(((probe.fov / 2) * Math.PI) / 180);
      const halfW = halfH * probe.aspect;
      const right = new Vector3().setFromMatrixColumn(probe.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(probe.matrixWorld, 1);
      target.addScaledVector(right, cx * halfW).addScaledVector(up, cy * halfH);
      target.y = Math.max(0, target.y);
    }
    return dist;
  }

  frameAll(instant = false) {
    const b = this.footprint();
    this.framedKey = `${b.w.toFixed(1)}x${b.d.toFixed(1)}x${b.h.toFixed(1)}`;
    this.autoFrame = true;
    const target = new Vector3(b.cx, 0.4, b.cz);
    // Portrait: look more head-on so the stacked rooms run up the screen.
    const dir = (this.portrait ? new Vector3(0.15, 1.5, 1) : new Vector3(0.55, 0.95, 1)).normalize();
    const dist = this.fitDistance([{ x: b.cx, z: b.cz, w: b.w, d: b.d, y0: 0, y1: b.y1 }], target, dir, 0.97);
    const position = target.clone().add(dir.multiplyScalar(Math.max(dist, 12)));
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.flight = null;
    } else this.flyTo(target, position, null);
  }

  private flyTo(target: Vector3, position: Vector3, follow: string | null) {
    if (this.reduced) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.following = follow;
      return;
    }
    this.flight = { target, position, follow };
  }

  private updateCamera(dt: number) {
    if (this.flight) {
      const { target, position } = this.flight;
      const t = this.controls.target;
      const c = this.camera.position;
      // Critically damped springs: start from the current velocity (zero when at
      // rest), accelerate smoothly, settle without overshoot. Interruptible.
      springStep(t, this.flightVel.target, target, FLIGHT_RESPONSE, dt);
      springStep(c, this.flightVel.position, position, FLIGHT_RESPONSE, dt);
      if (t.distanceTo(target) < 0.01 && c.distanceTo(position) < 0.02 && this.flightVel.position.length() < 0.05) {
        this.following = this.flight.follow;
        this.flight = null;
        this.flightVel.target.set(0, 0, 0);
        this.flightVel.position.set(0, 0, 0);
      }
    } else if (this.following && !this.userDriving) {
      // Keep a selected agent centred as it moves (walking in, standing up).
      const s = this.agents.get(this.following);
      if (s) {
        const p = s.character.root.getWorldPosition(new Vector3()).add(new Vector3(0, 0.9, 0));
        const delta = p.sub(this.controls.target).multiplyScalar(1 - Math.exp(-5 * dt));
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    this.controls.update();
  }

  private fitShadows() {
    const b = this.footprint();
    // The campus is 100 m wide by the time it holds four buildings: size the
    // shadow frustum from the diagonal so the far corners still get shadows.
    const half = Math.max(b.w, b.d, b.h * 1.6) / 2 + 12;
    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = half * 4 + 60;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(b.cx, b.h / 2, b.cz);
    this.sun.position.set(b.cx + half * 0.55, b.h + half, b.cz + half * 0.42);
  }

  // ---------------------------------------------------------------- pointer

  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerDirty = true;
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
    el.addEventListener('pointerdown', (e) => this.downAt.set(e.clientX, e.clientY));
    el.addEventListener('pointerup', (e) => {
      // A click, not the end of a drag.
      if (this.downAt.distanceTo(new Vector2(e.clientX, e.clientY)) > 6) return;
      const hit = this.pick(e);
      this.cb.onPick(hit.agent, hit.team);
    });
    el.addEventListener('dblclick', (e) => {
      const hit = this.pick(e);
      if (!hit.agent && !hit.team) this.frameAll();
    });
  }

  private pick(e: { clientX: number; clientY: number }) {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    const p = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    return this.raycast(p);
  }

  private raycast(p: Vector2): { agent: string | null; team: string | null } {
    this.raycaster.setFromCamera(p, this.camera);
    // Only hit boxes live on the pick layer: one box per agent, one slab per office.
    this.raycaster.layers.set(PICK_LAYER);
    const roots: Object3D[] = [];
    for (const f of this.floors) {
      if (this.ghostedFloors.has(f.key)) continue;
      for (const r of f.rooms.values()) roots.push(r.root);
    }
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      const agent = findAgentId(h.object);
      if (agent) return { agent, team: this.agents.get(agent)?.team ?? null };
      const team = findTeamId(h.object);
      if (team) return { agent: null, team };
    }
    return { agent: null, team: null };
  }

  private setHover(id: string | null) {
    if (id === this.hovered) return;
    if (this.hovered) this.agents.get(this.hovered)?.character.setHovered(false);
    this.hovered = id;
    if (id) this.agents.get(id)?.character.setHovered(true);
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    this.cb.onHover(id);
  }

  // ---------------------------------------------------------------- frame

  /** Screen positions above each head, for the HTML name tags. */
  anchors(): Anchor[] {
    const out: Anchor[] = [];
    const w = this.viewW;
    const h = this.viewH;
    const v = this.anchorV;
    for (const [id, s] of this.agents) {
      s.character.headWorld(v);
      v.y += 0.62;
      const depth = v.distanceTo(this.camera.position);
      v.project(this.camera);
      out.push({
        id,
        x: (v.x * 0.5 + 0.5) * w,
        y: (-v.y * 0.5 + 0.5) * h,
        depth,
        visible: v.z < 1 && s.character.root.visible && !s.leaving && !this.ghostedFloors.has(s.floor),
      });
    }
    return out;
  }

  agentIds() {
    return [...this.agents.keys()];
  }

  onFrame?: () => void;

  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.elapsed += dt;
    const dark = this.theme === 'dark';

    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.setHover(this.raycast(this.pointer).agent);
    }

    this.screenBudget = 10;
    this.frustum.setFromProjectionMatrix(this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    for (const [id, s] of this.agents) {
      s.character.update(dt, this.elapsed, this.reduced);
      const agent = this.state?.agents[id];
      if (agent) {
        // Monitors are canvas textures: only redraw the ones you can actually read.
        const near = this.screenBudget > 0 && this.isNear(s.character.root);
        if (near) this.screenBudget--;
        s.desk.update(dt, this.elapsed, agent, dark, s.character.isSeated(), s.character.root.rotation.y, near);
      }
      // Update comm arcs with agent world position
      const worldPos = s.character.root.getWorldPosition(new Vector3());
      this.commArcs?.updateAgentPosition?.(id, worldPos);
    }
    for (const f of this.floors) f.building.tick(dt, this.camera);
    this.pavilion?.building.tick(dt, this.camera);
    this.courier.update(dt);
    // Feature controllers
    heatmap.tick(dt);
    this.timeOfDay?.tick?.(dt);
    this.ambient?.tick?.(dt);
    this.updateCamera(dt);
    this.frameNo++;
    // Recordings refresh shadows every frame so moving shadows never step.
    // Otherwise the floor is mostly static: refresh on a cheap cadence.
    if (this.shadowDirty || this.lockResolution || this.frameNo % (gfx.lite ? 6 : 3) === 0) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    if (!this.lockResolution) this.adaptResolution(dt);
    if (this.frameNo % 30 === 0) this.placeNightLights();
    const r0 = performance.now();
    this.renderFrame();
    this.onFrame?.();
    const p = this.perf;
    p.frameMs = p.frameMs * 0.9 + (performance.now() - r0) * 0.1;
    p.fps = p.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    p.calls = this.renderer.info.render.calls;
    p.triangles = this.renderer.info.render.triangles;
    p.agents = this.agents.size;
  };

  private placeNightLights() {
    const night = this.theme === 'dark';
    const spots: Vector3[] = [];
    if (night) {
      const all = this.pavilion ? [...this.floors, this.pavilion] : this.floors;
      for (const f of all) {
        const o = f.group.position;
        for (const r of f.rooms.values()) spots.push(r.center.clone().setY(o.y + 2.9));
        for (const p of f.building.lightSpots()) spots.push(p.clone().setY(p.y + o.y));
      }
    }
    const t = this.controls.target;
    spots.sort((a, b) => a.distanceToSquared(t) - b.distanceToSquared(t));
    this.nightLights.forEach((l, i) => {
      const spot = spots[i];
      l.intensity = spot ? 10 : 0;
      if (spot) l.position.copy(spot);
    });
  }

  /** Dynamic resolution: step between a blurry floor and the pixel budget above. */
  private adaptResolution(dt: number) {
    if (dt > 1 / 40) this.slowFrames++;
    else if (dt < 1 / 55) this.fastFrames++;
    const cap = this.idealPixelRatio();
    const floor = Math.min(0.75, cap);
    let next = this.pixelRatio;
    if (this.slowFrames > 40) next = Math.max(floor, this.pixelRatio - 0.25);
    else if (this.fastFrames > 300 && this.pixelRatio < cap) next = Math.min(cap, this.pixelRatio + 0.25);
    if (this.slowFrames > 40 || this.fastFrames > 300) {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }
    if (Math.abs(next - this.pixelRatio) > 0.01) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  /**
   * Cap the drawing buffer by total pixels, not by DPR alone, so a 4K panel
   * does not quietly ask for four times the fill rate of a laptop screen.
   * Lite GPUs get a tighter budget and a lower ceiling.
   */
  private idealPixelRatio() {
    const dpr = devicePixelRatio || 1;
    if (this.lockResolution) return Math.min(dpr, 4);
    const budget = gfx.lite ? 2.1e6 : 3.6e6;
    const cap = gfx.lite ? 1.25 : 1.75;
    const pixels = Math.max(1, this.viewW * this.viewH);
    const byBudget = Math.sqrt(budget / pixels);
    return Math.max(0.75, Math.min(dpr, cap, byBudget));
  }

  private resize() {
    const w = (this.viewW = Math.max(1, this.container.clientWidth));
    const h = (this.viewH = Math.max(1, this.container.clientHeight));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const portrait = w / h < 0.8;
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      if (this.state && this.autoFrame) this.frameAll();
    }
    this.renderer.setSize(w, h);
    if (this.composer) {
      this.composer.setPixelRatio(this.pixelRatio);
      this.composer.setSize(w, h);
    }
  }

  // ---------------------------------------------------------------- rendering

  /** Bloom is only built for the first night frame on a GPU that can afford it. */
  private ensureComposer() {
    if (this.composer) return;
    const buffer = this.renderer.getDrawingBufferSize(this.tmpSize);
    const megapixels = (buffer.x * buffer.y) / 1e6;
    // At 4K-and-up the supersampling already smooths edges; 8x MSAA costs too much memory.
    const samples = REC && megapixels < 9 ? Math.min(8, this.renderer.capabilities.maxSamples) : gfx.lite ? 0 : 4;
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.2, 0.55, 1.02);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(this.viewW, this.viewH);
  }

  private renderFrame() {
    this.renderer.info.reset();
    if (this.usePost && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Re-draw canvas text once the webfonts have actually loaded. */
  refreshText() {
    for (const f of this.floors) for (const room of f.rooms.values()) room.invalidateText();
    for (const s of this.agents.values()) s.desk.screen.invalidate();
    this.refreshRooms();
  }

  /**
   * Compile the character and desk shaders once, off-screen, so the first agent
   * does not stall the frame it walks in. The meshes stay in the scene but
   * invisible: disposing a just-compiled program makes GL emit warnings, and
   * hidden objects cost nothing to draw.
   */
  private warmUp() {
    const sample: Agent = {
      id: '__warmup__',
      name: 'Warmup',
      role: 'Engineer',
      team: '__warmup__',
      source: 'local',
      status: 'working',
      activity: 'Compiling shaders',
      tool: 'Bash',
      joinedAt: 0,
      lastSeen: 0,
      history: [],
    };
    const group = new Group();
    group.position.y = -200;
    group.add(new Character(sample).root, new Workstation(sample).root);
    this.scene.add(group);
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch {
      /* compiling is an optimisation; never block the floor on it */
    }
    group.visible = false;
    this.renderer.info.reset();
  }
}

/** Seconds a camera flight takes to (almost) arrive. */
const FLIGHT_RESPONSE = 1.1;

/** One critically damped spring step per axis (Apple's response/damping model, damping = 1). */
function springStep(x: Vector3, v: Vector3, goal: Vector3, response: number, dt: number) {
  const k = Math.pow((2 * Math.PI) / response, 2);
  const c = (4 * Math.PI) / response;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = Math.min(dt, 0.1) / steps;
  for (let i = 0; i < steps; i++) {
    v.x += (-k * (x.x - goal.x) - c * v.x) * h;
    v.y += (-k * (x.y - goal.y) - c * v.y) * h;
    v.z += (-k * (x.z - goal.z) - c * v.z) * h;
    x.x += v.x * h;
    x.y += v.y * h;
    x.z += v.z * h;
  }
}

function skyTexture(horizon: string, top: string) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.75, horizon);
  g.addColorStop(1, horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Very low-contrast concrete tiles so the floor has scale without visual noise. */
function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const v = 236 + Math.floor(Math.random() * 16);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 256, 256);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(150, 150);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

