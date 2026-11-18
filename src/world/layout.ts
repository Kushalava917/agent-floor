import type { Agent, Team, WorldState } from '../../shared/protocol';

// One building. Units are roughly metres.
//
//   z-   ┌───────┬────────┬────────┬─────────┬─────────┐  north wing (tall windows)
//        │       │ office │ office │ meeting │ kitchen │
//        │ lobby ├────────┴────────┴─────────┴─────────┤
//   door ▸       │              corridor               │
//        │       ├────────┬────────┬───────────────────┤
//        │       │ office │ office │      lounge       │  south wing (cut-away wall)
//   z+   └───────┴────────┴────────┴───────────────────┘
//        x-                                          x+
//
// Offices are laid out in their own frame: the door side (+Z) faces the corridor.
// North offices have yaw 0, south offices are turned around (yaw PI).

export const DESK_PITCH = 1.95;
export const SEAT_Z = 1.22;
export const OFFICE_D = 8.2;
export const CORRIDOR = 3.4;
export const WALL_H = 3.0;
const LEAD_SPACE = 2.7;
const LEFT_ROOM = 2.2; // bookshelf, reading nook, coat rack
const RIGHT_ROOM = 3.0; // walking lane, water cooler, plants
const LOBBY_W = 10;
const KITCHEN_W = 7.5;
const MEETING_W = 6.5;
const LOUNGE_W = 9;
export const CAFETERIA_W = 13;
export const LOUNGE_WIDTH = LOUNGE_W;
export const LOBBY_WIDTH = LOBBY_W;
export const BUILDING_X0 = -24;
/** Static sections of the shell are built in fixed-width segments and cached. */
export const SEGMENT = 13.2;

export interface Seat {
  /** Room-local seat position (where the chair is). */
  x: number;
  z: number;
  /** Direction the seated agent faces, radians around Y. 0 = facing -Z. */
  yaw: number;
  /** Room-local path from the office door to the seat. Last point is the seat. */
  path: [number, number][];
  isLead: boolean;
}

export interface RoomLayout {
  team: Team;
  /** World-space centre and rotation of the office. */
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  side: 'north' | 'south';
  /** Local x of the door in the corridor wall. */
  doorX: number;
  podLeft: number;
  podRight: number;
  hasLead: boolean;
  seats: Map<string, Seat>;
  /** Local path from the building entrance to just inside this office's door. */
  entry: [number, number][];
}

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export type AmenityKind = 'kitchen' | 'meeting' | 'lounge' | 'games' | 'booths' | 'cafeteria' | 'vacant';

export interface Amenity {
  kind: AmenityKind;
  rect: Rect;
  side: 'north' | 'south';
}

export interface FloorMeta {
  level: number;
  building: number;
  ground: boolean;
  top: boolean;
  pavilion: boolean;
  capacity: number;
}

export interface FloorOptions {
  meta?: Partial<FloorMeta>;
  /** A planned but not-yet-used floor: open-plan desks instead of a team wing. */
  vacant?: boolean;
  /** Ground floors get a cafeteria in place of the pantry. */
  cafeteria?: boolean;
  /** Minimum wing length, used to size vacant floors. */
  padWidth?: number;
}

export interface BuildingLayout {
  /** Outer footprint, local to the floor group, centred on the origin. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  lobby: Rect;
  corridor: Rect;
  amenities: Amenity[];
  rooms: Map<string, RoomLayout>;
  /** Where people come in (local, just outside the door). */
  entrance: [number, number];
  /** Changes whenever the building shell has to be rebuilt. */
  key: string;
  meta: FloorMeta;
}

/** Remembers seats, leads and which wing each team sits in, so nothing jumps around. */
export class SeatBook {
  private slots = new Map<string, Map<string, number>>();
  private leads = new Map<string, string>();
  readonly wings = new Map<string, 'north' | 'south'>();

  assign(state: WorldState) {
    const byTeam = new Map<string, Agent[]>();
    for (const a of Object.values(state.agents)) {
      if (!byTeam.has(a.team)) byTeam.set(a.team, []);
      byTeam.get(a.team)!.push(a);
    }
    for (const [teamId, map] of this.slots) {
      const present = new Set((byTeam.get(teamId) || []).map((a) => a.id));
      for (const id of map.keys()) if (!present.has(id)) map.delete(id);
      if (!byTeam.has(teamId)) {
        this.slots.delete(teamId);
        this.wings.delete(teamId);
      }
      const lead = this.leads.get(teamId);
      if (lead && !present.has(lead)) this.leads.delete(teamId);
    }
    for (const [teamId, agents] of byTeam) {
      agents.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
      if (!this.leads.has(teamId)) {
        const lead =
          agents.find((a) => a.role.toLowerCase() === 'lead') ||
          agents.find((a) => !a.parent && agents.some((b) => b.parent === a.id));
        if (lead) this.leads.set(teamId, lead.id);
      }
      let map = this.slots.get(teamId);
      if (!map) this.slots.set(teamId, (map = new Map()));
      const leadId = this.leads.get(teamId);
      for (const a of agents) {
        if (a.id === leadId || map.has(a.id)) continue;
        const used = new Set(map.values());
        let slot = 0;
        while (used.has(slot)) slot++;
        map.set(a.id, slot);
      }
    }
  }

  lead(teamId: string) {
    return this.leads.get(teamId);
  }

  slotsFor(teamId: string) {
    return this.slots.get(teamId) || new Map<string, number>();
  }
}

function officeWidth(podSlots: number, hasLead: boolean) {
  const cols = Math.max(1, Math.ceil(podSlots / 2));
  const need = LEFT_ROOM + (hasLead ? LEAD_SPACE : 0) + cols * DESK_PITCH + RIGHT_ROOM;
  const w = Math.max(9, need);
  return { w, cols, extra: w - need };
}

/** Rotate a world-space point into an office's local frame. */
export function toLocal(room: { x: number; z: number; yaw: number }, p: [number, number]): [number, number] {
  const dx = p[0] - room.x;
  const dz = p[1] - room.z;
  const c = Math.cos(room.yaw);
  const s = Math.sin(room.yaw);
  // Inverse of three.js's rotation around Y by yaw.
  return [dx * c - dz * s, dx * s + dz * c];
}

type Draft = Omit<RoomLayout, 'x' | 'z' | 'yaw' | 'entry'>;

export function computeLayout(state: WorldState, book: SeatBook, options: FloorOptions = {}): BuildingLayout {
  book.assign(state);
  const teams = Object.values(state.teams).sort((a, b) => a.order - b.order);
  const vacant = Boolean(options.vacant);

  // --- size every office and place it in a wing
  const wing: Record<'north' | 'south', Draft[]> = { north: [], south: [] };
  const wingLen = { north: 0, south: 0 };
  for (const team of teams) {
    const slots = book.slotsFor(team.id);
    const leadId = book.lead(team.id);
    const maxSlot = slots.size ? Math.max(...slots.values()) + 1 : 0;
    // Offices grow four seats at a time, so the building is reshaped rarely.
    const podSlots = Math.max(4, Math.ceil(maxSlot / 4) * 4);
    const { w, cols, extra } = officeWidth(podSlots, Boolean(leadId));
    const d = OFFICE_D;
    let side = book.wings.get(team.id);
    if (!side) {
      side = wingLen.north <= wingLen.south ? 'north' : 'south';
      book.wings.set(team.id, side);
    }
    wingLen[side] += w;

    const podWidth = cols * DESK_PITCH;
    const podLeft = -w / 2 + LEFT_ROOM + extra / 2 + (leadId ? LEAD_SPACE : 0);
    const podRight = podLeft + podWidth;
    const front = d / 2 - 0.9;
    const lane = podRight + 0.85;
    const doorX = Math.min(w / 2 - 0.9, lane);
    const seats = new Map<string, Seat>();

    if (leadId) {
      const lx = podLeft - 1.25;
      seats.set(leadId, {
        x: lx,
        z: 0,
        yaw: -Math.PI / 2,
        isLead: true,
        path: [
          [doorX, front],
          [lx - 0.8, front],
          [lx - 0.8, 0],
          [lx, 0],
        ],
      });
    }
    for (const [agentId, slot] of slots) {
      const col = Math.floor(slot / 2);
      const back = slot % 2 === 0;
      const x = podLeft + DESK_PITCH * (col + 0.5);
      if (back) {
        // Back row faces the corridor; reach it round the end of the pod.
        const behind = -SEAT_Z - 0.75;
        seats.set(agentId, {
          x,
          z: -SEAT_Z,
          yaw: Math.PI,
          isLead: false,
          path: [
            [lane, front],
            [lane, behind],
            [x, behind],
            [x, -SEAT_Z],
          ],
        });
      } else {
        seats.set(agentId, {
          x,
          z: SEAT_Z,
          yaw: 0,
          isLead: false,
          path: [
            [doorX, front],
            [x, front],
            [x, SEAT_Z],
          ],
        });
      }
    }
    wing[side].push({ team, w, d, side, doorX, podLeft, podRight, hasLead: Boolean(leadId), seats });
  }

  // --- amenities close each wing, then pad the shorter wing so the building is a box
  let amenities: { kind: AmenityKind; w: number; side: 'north' | 'south' }[];
  if (options.meta?.pavilion) {
    // The campus cafeteria: one wide counter hall and a lounge.
    amenities = [
      { kind: 'cafeteria', w: CAFETERIA_W + 4, side: 'north' },
      { kind: 'lounge', w: LOUNGE_W, side: 'south' },
    ];
  } else if (vacant) {
    // An unused floor is an open-plan shell: a run of empty desks and a lounge.
    const open = Math.max(12, (options.padWidth ?? 20) - LOUNGE_W);
    amenities = [
      { kind: 'vacant', w: open, side: 'north' },
      { kind: 'lounge', w: LOUNGE_W, side: 'south' },
    ];
  } else {
    amenities = [
      { kind: 'meeting', w: MEETING_W, side: 'north' },
      options.cafeteria
        ? { kind: 'cafeteria', w: CAFETERIA_W, side: 'north' }
        : { kind: 'kitchen', w: KITCHEN_W, side: 'north' },
      { kind: 'lounge', w: LOUNGE_W, side: 'south' },
    ];
  }

  const sumSide = (side: 'north' | 'south') =>
    amenities.filter((a) => a.side === side).reduce((total, a) => total + a.w, 0);
  let lenN = wingLen.north + sumSide('north');
  let lenS = wingLen.south + sumSide('south');

  // An under-filled floor keeps room for expansion rather than shrinking to a shed.
  const minWing = vacant ? 0 : (options.padWidth ?? 0);
  if (minWing > Math.max(lenN, lenS) + 0.01) {
    const side = lenN >= lenS ? 'north' : 'south';
    amenities.push({ kind: 'vacant', w: minWing - Math.max(lenN, lenS), side });
    if (side === 'north') lenN = minWing;
    else lenS = minWing;
  }

  const pad = (gap: number): AmenityKind => (gap > 5.5 ? 'games' : 'booths');
  if (lenS < lenN - 0.01) {
    amenities.push({ kind: pad(lenN - lenS), w: lenN - lenS, side: 'south' });
    lenS = lenN;
  }
  if (lenN < lenS - 0.01) {
    amenities.push({ kind: pad(lenS - lenN), w: lenS - lenN, side: 'north' });
    lenN = lenS;
  }
  const wingLength = Math.max(lenN, lenS);

  const length = LOBBY_W + wingLength;
  const depth = CORRIDOR + OFFICE_D * 2;
  // The west end is fixed so the building grows east without moving what exists.
  const x0 = BUILDING_X0;
  const z0 = -depth / 2;
  const wingZ = { north: -(CORRIDOR / 2 + OFFICE_D / 2), south: CORRIDOR / 2 + OFFICE_D / 2 };
  const ground = options.meta?.ground !== false;
  // Upper floors start at the lift lobby; the ground floor comes in from the street.
  const entrance: [number, number] = ground ? [x0 - 2.2, 0] : [x0 + LOBBY_W - 1.1, 0];
  const corridorStart: [number, number] = [x0 + LOBBY_W - 0.5, 0];

  const rooms = new Map<string, RoomLayout>();
  const placedAmenities: Amenity[] = [];
  for (const side of ['north', 'south'] as const) {
    let x = x0 + LOBBY_W;
    for (const dft of wing[side]) {
      const cx = x + dft.w / 2;
      const yaw = side === 'north' ? 0 : Math.PI;
      const pos = { x: cx, z: wingZ[side], yaw };
      // From the lift lobby (or the street), down the corridor to this door.
      const doorWorldX = cx + (side === 'north' ? dft.doorX : -dft.doorX);
      const entryWorld: [number, number][] = ground
        ? [entrance, [x0 + 1.5, 0], corridorStart, [doorWorldX, 0]]
        : [entrance, corridorStart, [doorWorldX, 0]];
      const entry = entryWorld.map((p) => toLocal(pos, p));
      entry.push([dft.doorX, dft.d / 2 + 0.3]);
      rooms.set(dft.team.id, { ...dft, x: cx, z: wingZ[side], yaw, entry });
      x += dft.w;
    }
    for (const a of amenities.filter((a) => a.side === side)) {
      placedAmenities.push({ kind: a.kind, side, rect: { x: x + a.w / 2, z: wingZ[side], w: a.w, d: OFFICE_D } });
      x += a.w;
    }
  }

  const meta: FloorMeta = {
    level: options.meta?.level ?? 0,
    building: options.meta?.building ?? 0,
    ground: options.meta?.ground ?? true,
    top: options.meta?.top ?? true,
    pavilion: options.meta?.pavilion ?? false,
    capacity: options.meta?.capacity ?? 0,
  };
  const key = [
    `m:${meta.level}:${meta.ground ? 1 : 0}:${meta.pavilion ? 1 : 0}`,
    length.toFixed(2),
    ...amenities.map((a) => `${a.kind}:${a.side}:${a.w.toFixed(2)}`),
    ...[...rooms.values()].map((r) => `${r.team.id}:${r.side}:${r.x.toFixed(2)}:${r.w.toFixed(2)}:${r.doorX.toFixed(2)}`),
  ].join('|');

  return {
    x0,
    x1: x0 + length,
    z0,
    z1: z0 + depth,
    lobby: { x: x0 + LOBBY_W / 2, z: 0, w: LOBBY_W, d: depth },
    corridor: { x: x0 + LOBBY_W + wingLength / 2, z: 0, w: wingLength, d: CORRIDOR },
    amenities: placedAmenities,
    rooms,
    entrance,
    key,
    meta,
  };
}
