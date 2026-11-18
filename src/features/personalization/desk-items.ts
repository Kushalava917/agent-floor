/**
 * Desk personalization — tiny decorative items placed on/around each agent's desk
 * based on their role and source. Purely visual, no gameplay effect.
 *
 * Items are baked into the desk mesh at build time via Workstation.ts
 */

import { Kit } from '../../world/kit';
import { M, rand, reseed, pick } from '../../world/props';
import { clay } from '../../world/materials';
import { hash } from '../../world/palette';
import {
  BoxGeometry,
  CylinderGeometry,
  ConeGeometry,
  SphereGeometry,
  LatheGeometry,
  Vector2,
} from 'three';

export interface DeskPersonality {
  mug: boolean;
  sticker: string | null;        // texture key or null
  figurine: FigurineType | null;
  plant: PlantType | null;
  note: NoteColor | null;
  cableColor: string;
}

export type FigurineType = 'robot' | 'cat' | 'rocket' | 'cube' | 'dino' | 'mug' | 'terminal' | 'cursor';
export type PlantType = 'succulent' | 'cactus' | 'bonsai' | 'airplant' | null;
export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'orange';

const FIGURINES: Record<string, FigurineType[]> = {
  // By role
  lead: ['robot', 'rocket'],
  engineer: ['cube', 'robot'],
  frontend: ['cat', 'dino'],
  backend: ['robot', 'cube'],
  security: ['robot', 'cube'],
  tests: ['dino', 'cat'],
  devops: ['rocket', 'robot'],
  designer: ['cat', 'dino'],
  pm: ['robot', 'rocket'],
  // By source
  'claude-code': ['terminal', 'robot'],
  codex: ['cursor', 'cube'],
  cursor: ['cursor', 'cat'],
  copilot: ['robot', 'rocket'],
  // Default
  default: ['mug', 'cube', 'robot', 'cat', 'dino', 'rocket'],
};

const PLANTS: PlantType[] = ['succulent', 'cactus', 'bonsai', 'airplant', null, null, null]; // 30% chance
const NOTES: NoteColor[] = ['yellow', 'pink', 'blue', 'green', 'orange'];
const CABLE_COLORS = ['#3a3f48', '#4a4f57', '#5b5f6b', '#2d3340', '#1e2430'];

function pickByRole(role: string): FigurineType[] {
  const r = role.toLowerCase();
  for (const [key, vals] of Object.entries(FIGURINES)) {
    if (r.includes(key)) return vals;
  }
  return FIGURINES.default;
}

function pickBySource(source: string): FigurineType[] {
  return FIGURINES[source] ?? FIGURINES.default;
}

/** Generate a deterministic personality for an agent */
export function generatePersonality(agentId: string, role: string, source: string): DeskPersonality {
  const seed = hash(agentId + role + source);
  reseed(seed);

  const roleFigs = pickByRole(role);
  const sourceFigs = pickBySource(source);
  const allFigs = [...new Set([...roleFigs, ...sourceFigs])];

  return {
    mug: rand() > 0.15,                           // 85% have a mug
    sticker: rand() > 0.7 ? pick(['react', 'vue', 'rust', 'go', 'ts', 'vim', 'docker', 'k8s', 'aws', 'linux']) : null,
    figurine: rand() > 0.4 ? pick(allFigs) : null, // 60% have a figurine
    plant: pick(PLANTS),
    note: rand() > 0.6 ? pick(NOTES) : null,       // 40% have a sticky note
    cableColor: pick(CABLE_COLORS),
  };
}

/** Add personalization items to a desk kit */
export function addDeskPersonality(
  k: Kit,
  personality: DeskPersonality,
  deskX: number,
  deskZ: number,
  deskRy: number
): void {
  k.push(deskX, 0, deskZ, deskRy);

  // Mug on right side of desk
  if (personality.mug) {
    const mugX = 0.55;
    const mugZ = -0.3;
    const mugGeo = mugGeometry();
    const mugMat = M.white();
    k.add(mugGeo, mugMat, mugX, 0.78, mugZ);
    // Steam when "working" - handled by Workstation update loop
  }

  // Sticker on laptop lid (handled in Workstation screen texture)

  // Figurine on left rear corner
  if (personality.figurine) {
    const figX = -0.55;
    const figZ = -0.35;
    addFigurine(k, personality.figurine, figX, 0.78, figZ);
  }

  // Small plant on left front
  if (personality.plant) {
    const plantX = -0.5;
    const plantZ = 0.3;
    addDeskPlant(k, personality.plant, plantX, 0.78, plantZ);
  }

  // Sticky note on monitor edge
  if (personality.note) {
    const noteX = 0.4;
    const noteZ = -0.4;
    addStickyNote(k, personality.note, noteX, 1.05, noteZ);
  }

  k.pop();
}

// --- Geometry builders (simple, low-poly) ---

const _mugGeometryCache: ReturnType<typeof makeLathe> | null = null;
function mugGeometry() {
  if (_mugGeometryCache) return _mugGeometryCache.geometry;
  const { geometry } = makeLathe({
    points: [
      [0.04, 0], [0.04, 0.06], [0.05, 0.07], [0.05, 0.085], [0.04, 0.085]
    ],
    segments: 12,
  });
  return geometry;
}

function addFigurine(k: Kit, type: FigurineType, x: number, y: number, z: number): void {
  switch (type) {
    case 'robot':
      k.add(box(0.04, 0.06, 0.03), M.steel(), x, y + 0.03, z);
      k.add(box(0.025, 0.025, 0.025), clay('#ffffff'), x, y + 0.07, z); // head
      k.add(box(0.008, 0.03, 0.008), M.steel(), x - 0.02, y + 0.045, z); // arms
      k.add(box(0.008, 0.03, 0.008), M.steel(), x + 0.02, y + 0.045, z);
      break;
    case 'cat':
      k.add(box(0.03, 0.04, 0.05), clay('#4a4f57'), x, y + 0.02, z); // body
      k.add(sphere(0.022), clay('#4a4f57'), x, y + 0.05, z - 0.02); // head
      k.add(cone(0.01, 0.02), clay('#4a4f57'), x - 0.015, y + 0.055, z - 0.025); // ears
      k.add(cone(0.01, 0.02), clay('#4a4f57'), x + 0.015, y + 0.055, z - 0.025);
      break;
    case 'rocket':
      k.add(cylinder(0.018, 0.018, 0.07, 8), M.white(), x, y + 0.035, z);
      k.add(cone(0.018, 0.03), M.charcoal(), x, y + 0.08, z);
      k.add(box(0.012, 0.02, 0.012), M.steel(), x - 0.02, y + 0.02, z); // fins
      k.add(box(0.012, 0.02, 0.012), M.steel(), x + 0.02, y + 0.02, z);
      break;
    case 'cube':
      k.add(box(0.045, 0.045, 0.045), M.charcoal(), x, y + 0.022, z);
      break;
    case 'dino':
      k.add(box(0.05, 0.025, 0.03), clay('#7d8f69'), x, y + 0.012, z); // body
      k.add(box(0.015, 0.035, 0.015), clay('#7d8f69'), x - 0.02, y + 0.03, z - 0.01); // tail
      k.add(box(0.015, 0.035, 0.015), clay('#7d8f69'), x + 0.02, y + 0.03, z - 0.01);
      break;
    case 'mug':
      k.add(mugGeometry(), M.white(), x, y + 0.01, z);
      break;
    case 'terminal':
      k.add(box(0.05, 0.008, 0.04), M.charcoal(), x, y + 0.004, z);
      k.add(box(0.048, 0.035, 0.002), M.screen(), x, y + 0.025, z - 0.019);
      break;
    case 'cursor':
      k.add(box(0.015, 0.025, 0.015), M.steel(), x, y + 0.012, z);
      k.add(box(0.005, 0.005, 0.025), clay('#ff5f2e'), x, y + 0.025, z); // cursor blink
      break;
  }
}

function addDeskPlant(k: Kit, type: PlantType, x: number, y: number, z: number): void {
  const potColor = M.terracotta();
  switch (type) {
    case 'succulent':
      k.add(cylinder(0.03, 0.03, 0.035, 8), potColor, x, y + 0.017, z);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        k.add(cone(0.012, 0.04), clay('#7d8f69'), x + Math.cos(a) * 0.015, y + 0.05, z + Math.sin(a) * 0.015);
      }
      break;
    case 'cactus':
      k.add(cylinder(0.025, 0.025, 0.035, 8), potColor, x, y + 0.017, z);
      k.add(cylinder(0.015, 0.012, 0.07, 6), clay('#4f8a5b'), x, y + 0.055, z);
      k.add(box(0.01, 0.03, 0.005), clay('#4f8a5b'), x - 0.015, y + 0.06, z);
      k.add(box(0.01, 0.03, 0.005), clay('#4f8a5b'), x + 0.015, y + 0.06, z);
      break;
    case 'bonsai':
      k.add(cylinder(0.035, 0.035, 0.03, 8), potColor, x, y + 0.015, z);
      k.add(sphere(0.035), clay('#386a45'), x, y + 0.05, z);
      break;
    case 'airplant':
      k.add(cylinder(0.025, 0.025, 0.025, 8), potColor, x, y + 0.012, z);
      for (let i = 0; i < 4; i++) {
        k.add(cone(0.008, 0.035), clay('#79a86b'), x + (rand() - 0.5) * 0.02, y + 0.04, z + (rand() - 0.5) * 0.02);
      }
      break;
  }
}

function addStickyNote(k: Kit, color: NoteColor, x: number, y: number, z: number): void {
  const colors: Record<NoteColor, string> = {
    yellow: '#ffe680', pink: '#ffb3c1', blue: '#a8e0ff', green: '#b9f2a1', orange: '#ffd1a1'
  };
  k.add(box(0.06, 0.001, 0.05), clay(colors[color]), x, y, z);
  k.add(box(0.058, 0.001, 0.008), clay('#2d3340'), x, y + 0.0005, z - 0.02); // pen line
}

// --- Primitive helpers (inline to avoid deps) ---

const _boxCache = new Map<string, BoxGeometry>();
function box(w: number, h: number, d: number): BoxGeometry {
  const key = `${w}:${h}:${d}`;
  let g = _boxCache.get(key);
  if (!g) {
    g = new BoxGeometry(w, h, d);
    _boxCache.set(key, g);
  }
  return g;
}

const _sphereCache = new Map<number, SphereGeometry>();
function sphere(r: number): SphereGeometry {
  let g = _sphereCache.get(r);
  if (!g) {
    g = new SphereGeometry(r, 12, 8);
    _sphereCache.set(r, g);
  }
  return g;
}

const _cylinderCache = new Map<string, CylinderGeometry>();
function cylinder(rt: number, rb: number, h: number, seg: number): CylinderGeometry {
  const key = `${rt}:${rb}:${h}:${seg}`;
  let g = _cylinderCache.get(key);
  if (!g) {
    g = new CylinderGeometry(rt, rb, h, seg);
    _cylinderCache.set(key, g);
  }
  return g;
}

const _coneCache = new Map<string, ConeGeometry>();
function cone(r: number, h: number): ConeGeometry {
  const key = `${r}:${h}`;
  let g = _coneCache.get(key);
  if (!g) {
    g = new ConeGeometry(r, h, 8);
    _coneCache.set(key, g);
  }
  return g;
}

function makeLathe({ points, segments }: { points: [number, number][]; segments: number }) {
  const pts = points.map(([x, y]) => new Vector2(x, y));
  return { geometry: new LatheGeometry(pts, segments) };
}