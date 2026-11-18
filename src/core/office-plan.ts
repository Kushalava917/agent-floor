import type { Team } from '../../shared/protocol';

/**
 * Office scale. The founder answer decides the shell we build; the live event
 * stream can still force extra floors when more teams connect than planned.
 *
 *   studio  1 floor, one building
 *   tower   2-4 stacked floors, one building
 *   campus  2-storey buildings around a courtyard, plus a cafeteria pavilion
 */
export type OfficeMode = 'studio' | 'tower' | 'campus';

export const CAPACITY_KEY = 'agent-floor:agents';
export const CAPACITY_MIN = 1;
export const CAPACITY_MAX = 200;

/** Agents per floor before we add another level. */
export const SOFT_AGENTS_PER_FLOOR = 18;
/** Four offices per floor keeps the wing readable and the camera framing sane. */
export const MAX_TEAMS_PER_FLOOR = 4;
export const TOWER_THRESHOLD = 25;
export const CAMPUS_THRESHOLD = 65;
/** Storey height: 3.0 m of room plus slab, services and facade band. */
export const FLOOR_H = 4.45;

export interface OfficeSpec {
  mode: OfficeMode;
  capacity: number;
  floors: number;
  buildings: number;
  floorsPerBuilding: number;
}

export interface FloorPlan {
  /** Stable across syncs: `b0:l1`. */
  key: string;
  building: number;
  level: number;
  ground: boolean;
  top: boolean;
  capacity: number;
  teams: string[];
  /** No live team yet: draw the open-plan desks so the space reads as ready. */
  vacant: boolean;
  pavilion?: boolean;
  /** Human-readable label: "Floor 1", "Building A Ground", etc. */
  label: string;
  /** Which agent source owns this floor/building (for FCFS assignment). */
  assignedSource?: string;
}

export interface SitePlan {
  spec: OfficeSpec;
  floors: FloorPlan[];
  /** Campus only. */
  cafeteria: boolean;
}

function clamp(n: number) {
  return Math.max(CAPACITY_MIN, Math.min(CAPACITY_MAX, Math.round(n)));
}

/** Read the answer from ?agents= first, then the saved choice. */
export function readCapacity(): number | null {
  if (typeof location !== 'undefined') {
    const raw = new URLSearchParams(location.search).get('agents');
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return clamp(n);
    }
  }
  try {
    const raw = localStorage.getItem(CAPACITY_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return clamp(n);
    }
  } catch {
    /* storage blocked: use the default */
  }
  return null;
}

export function saveCapacity(n: number) {
  try {
    localStorage.setItem(CAPACITY_KEY, String(clamp(n)));
  } catch {
    /* storage blocked: the office still rebuilds for this visit */
  }
}

export function chooseSpec(capacity: number): OfficeSpec {
  const n = clamp(capacity);
  if (n < TOWER_THRESHOLD) {
    return { mode: 'studio', capacity: n, floors: 1, buildings: 1, floorsPerBuilding: 1 };
  }
  if (n < CAMPUS_THRESHOLD) {
    const floors = Math.max(2, Math.min(4, Math.ceil(n / SOFT_AGENTS_PER_FLOOR)));
    return { mode: 'tower', capacity: n, floors, buildings: 1, floorsPerBuilding: floors };
  }
  const buildings = Math.max(2, Math.min(4, Math.ceil(n / 36)));
  return {
    mode: 'campus',
    capacity: n,
    floors: buildings * 2,
    buildings,
    floorsPerBuilding: 2,
  };
}

export function modeLabel(mode: OfficeMode) {
  return mode === 'studio' ? 'Studio' : mode === 'tower' ? 'Tower' : 'Campus';
}

/** Create a spec from the user's chosen office type and agent count. */
export function chooseSpecByType(type: OfficeMode, capacity: number): OfficeSpec {
  const n = clamp(capacity);
  if (type === 'studio') {
    return { mode: 'studio', capacity: n, floors: 1, buildings: 1, floorsPerBuilding: 1 };
  }
  if (type === 'tower') {
    const floors = Math.max(2, Math.min(4, Math.ceil(n / SOFT_AGENTS_PER_FLOOR)));
    return { mode: 'tower', capacity: n, floors, buildings: 1, floorsPerBuilding: floors };
  }
  // campus
  const buildings = Math.max(2, Math.min(4, Math.ceil(n / 36)));
  return {
    mode: 'campus',
    capacity: n,
    floors: buildings * 2,
    buildings,
    floorsPerBuilding: 2,
  };
}

/** One-line promise for the setup dialog. */
export function describeSpec(spec: OfficeSpec) {
  if (spec.mode === 'studio') return `One open floor for up to ${spec.capacity} agents`;
  if (spec.mode === 'tower') return `${spec.floors}-floor tower · ${spec.buildings} building`;
  return `${spec.buildings} buildings · 2 floors each · cafeteria pavilion`;
}

export function buildingLabel(index: number, count: number) {
  if (count <= 1) return '';
  return `Building ${String.fromCharCode(65 + index)}`;
}

export function floorLabel(level: number) {
  return level === 0 ? 'Ground' : `Level ${level}`;
}

export function floorDisplayLabel(building: number, level: number, buildings: number) {
  if (buildings <= 1) {
    return level === 0 ? 'Floor 1' : `Floor ${level + 1}`;
  }
  const buildingName = String.fromCharCode(65 + building);
  return level === 0 ? `Building ${buildingName} Ground` : `Building ${buildingName} Level ${level}`;
}

function emptyBucket(): { teams: string[]; agents: number } {
  return { teams: [], agents: 0 };
}

/**
 * Pack teams into floors, then pad with vacant floors up to the planned size.
 * The first bucket is always the ground floor, so the building fills from the
 * bottom and the extra capacity reads as expansion space above.
 * 
 * For FCFS assignment: each unique agent source (codex, opencode, claude, etc.)
 * gets their own floor (tower) or building (campus).
 */
export function planSite(
  teams: Team[], 
  agentCounts: Map<string, number>, 
  capacity: number, 
  spec?: OfficeSpec,
  sourceAssignments?: Map<string, { building: number; level: number }>
): SitePlan {
  const chosenSpec = spec ?? chooseSpec(capacity);
  const buckets: { teams: string[]; agents: number }[] = [];
  const ordered = [...teams].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  for (const team of ordered) {
    const agents = agentCounts.get(team.id) || 0;
    let bucket = buckets.find(
      (b) => b.teams.length < MAX_TEAMS_PER_FLOOR && b.agents + agents <= SOFT_AGENTS_PER_FLOOR,
    );
    if (!bucket) {
      bucket = emptyBucket();
      buckets.push(bucket);
    }
    bucket.teams.push(team.id);
    bucket.agents += agents;
  }

  while (buckets.length < chosenSpec.floors) buckets.push(emptyBucket());

  const perFloor = Math.max(4, Math.ceil(chosenSpec.capacity / chosenSpec.floors));
  const floors: FloorPlan[] = buckets.map((bucket, i) => {
    const campus = chosenSpec.mode === 'campus';
    const building = campus ? Math.floor(i / 2) : 0;
    const level = campus ? i % 2 : i;
    const top = campus ? level === 1 : i === buckets.length - 1;
    return {
      key: `b${building}:l${level}`,
      building,
      level,
      ground: level === 0,
      top,
      capacity: perFloor,
      teams: bucket.teams,
      vacant: bucket.teams.length === 0,
      label: floorDisplayLabel(building, level, campus ? chosenSpec.buildings : 1),
    };
  });

  // Apply FCFS source assignments if provided
  if (sourceAssignments && sourceAssignments.size > 0) {
    let assignmentIndex = 0;
    for (const [source] of sourceAssignments) {
      if (assignmentIndex < floors.length) {
        const floor = floors[assignmentIndex];
        if (floor.vacant || floor.assignedSource === source) {
          floor.assignedSource = source;
          floor.vacant = false;
        }
      }
      assignmentIndex++;
    }
  }

  // Teams may have overflowed the planned shell: relabel building/level from
  // scratch so a growing campus stays coherent.
  if (chosenSpec.mode === 'campus') {
    floors.forEach((f, i) => {
      f.building = Math.floor(i / 2);
      f.level = i % 2;
      f.key = `b${f.building}:l${f.level}`;
      f.ground = f.level === 0;
      f.top = f.level === 1;
      f.label = floorDisplayLabel(f.building, f.level, Math.floor(chosenSpec.floors / 2));
    });
  }

  const buildings = floors.reduce((max, f) => Math.max(max, f.building + 1), 1);
  const finalSpec = { ...chosenSpec, floors: floors.length, buildings };
  return {
    spec: finalSpec,
    floors,
    cafeteria: finalSpec.mode === 'campus',
  };
}
