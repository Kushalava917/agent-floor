/**
 * Communication arcs — curved bezier lines between desks of agents who messaged.
 * Thickness = message count, fade after 5min silence, color by team.
 * Uses instanced mesh for performance with many arcs.
 */

import {
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Color,
  Vector3,
  Float32BufferAttribute,
} from 'three';
import { eventBus } from '../../core/event-bus';
import { teamAccent } from '../../world/palette';

interface ArcData {
  fromAgent: string;
  toAgent: string;
  fromTeam: string;
  toTeam: string;
  count: number;
  lastActive: number;
  color: Color;
}

interface ArcPoint {
  from: Vector3;
  to: Vector3;
  color: Color;
  thickness: number;
}

const ARC_LIFETIME = 5 * 60 * 1000; // 5 minutes
const MAX_ARCS = 500;
const CURVE_SEGMENTS = 16;

export class CommArcsController {
  private arcs = new Map<string, ArcData>();
  private lines: Line[] = [];
  private scene: any = null;
  private agentPositions = new Map<string, Vector3>();
  private cleanupTimer: number | null = null;
  private animationId: number | null = null;
  private materialCache = new Map<string, LineBasicMaterial>();

  constructor() {}

  /** Initialize with scene reference */
  init(scene: any): void {
    this.scene = scene;
    this.bindEvents();
    this.startCleanupLoop();
    this.startRenderLoop();
  }

  private bindEvents(): void {
    eventBus.on('agent:message', ({ from, to }) => {
      this.onMessage(from, to);
    });

    window.addEventListener('agent:position', ((e: CustomEvent) => {
      const { id, position } = e.detail;
      this.agentPositions.set(id, position.clone());
      this.updateArcGeometry();
    }) as EventListener);
  }

  private onMessage(from: string, to: string | string[]): void {
    const targets = Array.isArray(to) ? to : [to];
    const now = Date.now();

    for (const target of targets) {
      const key = `${from}->${target}`;
      let arc = this.arcs.get(key);

      if (!arc) {
        arc = {
          fromAgent: from,
          toAgent: target,
          fromTeam: 'unknown',
          toTeam: 'unknown',
          count: 0,
          lastActive: now,
          color: new Color(0xff5f2e),
        };
        this.arcs.set(key, arc);
      }

      arc.count++;
      arc.lastActive = now;
    }

    this.updateArcGeometry();
  }

  /** Update agent team colors (called from World when teams change) */
  updateAgentTeams(agentTeams: Map<string, string>): void {
    for (const [_key, arc] of this.arcs) {
      const fromTeam = agentTeams.get(arc.fromAgent);
      const toTeam = agentTeams.get(arc.toAgent);

      if (fromTeam) arc.fromTeam = fromTeam;
      if (toTeam) arc.toTeam = toTeam;

      // teamAccent expects a hue number; use hash of team name for consistent color
      const hue = fromTeam ? this.hashString(fromTeam) : 0;
      arc.color.copy(teamAccent(hue));
    }
    this.updateArcGeometry();
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 360;
  }

  /** Register agent world position (called from World each frame) */
  updateAgentPosition(agentId: string, position: Vector3): void {
    this.agentPositions.set(agentId, position.clone());
  }

  private updateArcGeometry(): void {
    if (!this.scene) return;

    const now = Date.now();
    const activeArcs: ArcPoint[] = [];

    // Filter active arcs and build geometry data
    for (const [key, arc] of this.arcs) {
      if (now - arc.lastActive > ARC_LIFETIME) {
        this.arcs.delete(key);
        continue;
      }

      const fromPos = this.agentPositions.get(arc.fromAgent);
      const toPos = this.agentPositions.get(arc.toAgent);

      if (!fromPos || !toPos) continue;

      // Thickness based on message count (clamped)
      const thickness = Math.min(0.05 + arc.count * 0.01, 0.15);

      activeArcs.push({
        from: fromPos.clone(),
        to: toPos.clone(),
        color: arc.color.clone(),
        thickness,
      });
    }

    // Limit to max arcs
    if (activeArcs.length > MAX_ARCS) {
      activeArcs.sort((a, b) => b.thickness - a.thickness);
      activeArcs.length = MAX_ARCS;
    }

    // Rebuild Line2 geometries
    this.rebuildLines(activeArcs);
  }

  private rebuildLines(arcs: ArcPoint[]): void {
    // Dispose old lines
    for (const line of this.lines) {
      this.scene.remove(line);
      line.geometry.dispose();
      if (line.material instanceof LineBasicMaterial) {
        line.material.dispose();
      }
    }
    this.lines = [];

    // Create new lines for each arc
    for (const arc of arcs) {
      const curvePoints = this.computeBezierCurve(arc.from, arc.to);
      const geometry = new BufferGeometry();
      const positions = new Float32Array(curvePoints.length * 3);
      const colors = new Float32Array(curvePoints.length * 3);

      for (let i = 0; i < curvePoints.length; i++) {
        const p = curvePoints[i];
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;

        const c = arc.color.clone();
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }

      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));

      // Get or create material for this thickness
      const thicknessKey = `thickness_${arc.thickness.toFixed(3)}`;
      let material = this.materialCache.get(thicknessKey);
      if (!material) {
        material = new LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          linewidth: Math.max(1, Math.round(arc.thickness * 100)),
        });
        this.materialCache.set(thicknessKey, material);
      }

      const line = new Line(geometry, material);
      this.scene.add(line);
      this.lines.push(line);
    }
  }

  /** Compute quadratic bezier curve between two points with a nice arc */
  private computeBezierCurve(from: Vector3, to: Vector3): Vector3[] {
    const points: Vector3[] = [];
    const mid = new Vector3().addVectors(from, to).multiplyScalar(0.5);
    const height = from.distanceTo(to) * 0.3;
    mid.y += height;

    for (let i = 0; i <= CURVE_SEGMENTS; i++) {
      const t = i / CURVE_SEGMENTS;
      const invT = 1 - t;

      // Quadratic bezier: P = (1-t)²*P0 + 2(1-t)t*P1 + t²*P2
      const x = invT * invT * from.x + 2 * invT * t * mid.x + t * t * to.x;
      const y = invT * invT * from.y + 2 * invT * t * mid.y + t * t * to.y;
      const z = invT * invT * from.z + 2 * invT * t * mid.z + t * t * to.z;

      points.push(new Vector3(x, y, z));
    }

    return points;
  }

  private startCleanupLoop(): void {
    this.cleanupTimer = window.setInterval(() => {
      this.updateArcGeometry();
    }, 10000); // Clean up every 10 seconds
  }

  private startRenderLoop(): void {
    const tick = () => {
      // Lines are recreated in updateArcGeometry, so just ensure they're visible
      for (let i = 0; i < this.lines.length; i++) {
        this.lines[i].visible = true;
      }
      this.animationId = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Enable/disable arcs */
  setEnabled(enabled: boolean): void {
    for (const line of this.lines) {
      line.visible = enabled;
    }
  }

  dispose(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer!);
    if (this.animationId) cancelAnimationFrame(this.animationId!);
    for (const line of this.lines) {
      this.scene.remove(line);
      line.geometry.dispose();
      if (line.material instanceof LineBasicMaterial) {
        line.material.dispose();
      }
    }
    for (const material of this.materialCache.values()) {
      material.dispose();
    }
    this.materialCache.clear();
    this.lines = [];
    this.arcs.clear();
    this.agentPositions.clear();
  }
}

let commArcsInstance: CommArcsController | null = null;

export function initCommArcs(): CommArcsController {
  if (commArcsInstance) commArcsInstance.dispose();
  commArcsInstance = new CommArcsController();
  return commArcsInstance;
}

export function getCommArcs(): CommArcsController | null {
  return commArcsInstance;
}