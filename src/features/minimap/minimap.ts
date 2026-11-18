/**
 * Mini-map — top-right canvas showing orthographic view of the entire campus.
 * Click a floor to jump there. Shows active floor highlight and agent dots.
 */

import { Vector3, Box3, Matrix4 } from 'three';
import { eventBus } from '../../core/event-bus';
import { getBuildingName, getFloorName, getPavilionName } from '../personalization/office-names';

interface MinimapFloor {
  key: string;
  building: number;
  level: number;
  bounds: Box3;
  worldBounds: Box3;
  active: boolean;
  pavilion: boolean;
  agentCount: number;
}

interface MinimapConfig {
  size: number;           // canvas size in pixels (square)
  margin: number;         // margin from viewport edge
  updateInterval: number; // ms
  showAgents: boolean;
  showLabels: boolean;
}

const DEFAULT_CONFIG: MinimapConfig = {
  size: 200,
  margin: 16,
  updateInterval: 500,
  showAgents: true,
  showLabels: true,
};

export class MinimapController {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private config: MinimapConfig;
  private floors: MinimapFloor[] = [];
  private worldToMap = new Matrix4();
  private mapToWorld = new Matrix4();
  private siteBounds = new Box3();
  private animationId: number | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private hoverFloor: MinimapFloor | null = null;

  constructor(private container: HTMLElement, config: Partial<MinimapConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.createCanvas();
    this.bindEvents();
    this.startLoop();
  }

  private createCanvas(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.config.size;
    this.canvas.height = this.config.size;
    this.canvas.className = 'minimap';
    this.canvas.setAttribute('aria-label', 'Campus map');
    this.canvas.setAttribute('role', 'img');
    this.ctx = this.canvas.getContext('2d')!;
    this.container.appendChild(this.canvas);

    // Click handler
    this.clickHandler = (e) => this.onClick(e);
    this.canvas.addEventListener('click', this.clickHandler);

    // Hover effect
    this.canvas.addEventListener('mousemove', (e) => this.onHover(e));
    this.canvas.addEventListener('mouseleave', () => { this.hoverFloor = null; });
  }

  /** Update floor data from World (call after sync) */
  updateFloors(floorData: Array<{
    key: string;
    building: number;
    level: number;
    bounds: Box3;
    active: boolean;
    pavilion: boolean;
    agentCount: number;
  }>): void {
    this.floors = floorData.map((f) => ({
      ...f,
      worldBounds: f.bounds.clone(),
    }));
    this.computeTransform();
  }

  /** Compute world-to-minimap transform matrix */
  private computeTransform(): void {
    if (this.floors.length === 0) return;

    // Compute overall site bounds
    this.siteBounds.makeEmpty();
    for (const f of this.floors) {
      this.siteBounds.union(f.worldBounds);
    }

    // Add padding
    const padding = Math.max(this.siteBounds.max.x - this.siteBounds.min.x, this.siteBounds.max.z - this.siteBounds.min.z) * 0.1;
    this.siteBounds.expandByScalar(padding);

    // Orthographic projection: map world X/Z to canvas pixels
    const worldWidth = this.siteBounds.max.x - this.siteBounds.min.x;
    const worldHeight = this.siteBounds.max.z - this.siteBounds.min.z;
    const scale = Math.min(this.config.size, this.config.size) / Math.max(worldWidth, worldHeight) * 0.9;

    // Build transform matrix manually (translate * scale * translate)
    const tx = -this.siteBounds.min.x - worldWidth / 2;
    const tz = -this.siteBounds.min.z - worldHeight / 2;
    const cx = this.config.size / 2;
    const cz = this.config.size / 2;

    this.worldToMap.set(
      scale, 0, 0, tx * scale + cx,
      0, 1, 0, 0,
      0, 0, scale, tz * scale + cz,
      0, 0, 0, 1
    );

    this.mapToWorld.copy(this.worldToMap).invert();
  }

  private bindEvents(): void {
    // Click and hover handlers are added directly in createCanvas
  }

  /** Main render loop */
  private render(): void {
    const ctx = this.ctx;
    const size = this.config.size;

    // Clear
    ctx.clearRect(0, 0, size, size);

    // Background
    ctx.fillStyle = 'rgba(20, 24, 33, 0.95)';
    ctx.fillRect(0, 0, size, size);

    // Draw floors. Storeys in a tower share a footprint, so paint the
    // occupied one last: otherwise a vacant upper floor hides it.
    const ordered = [...this.floors].sort((a, b) => Number(a.active) - Number(b.active));
    for (const floor of ordered) {
      this.drawFloor(ctx, floor);
    }

    // Draw agents as dots
    if (this.config.showAgents) {
      this.drawAgents(ctx);
    }

    // Draw hover highlight
    if (this.hoverFloor) {
      this.drawHover(ctx, this.hoverFloor);
    }
  }

  private drawFloor(ctx: CanvasRenderingContext2D, floor: MinimapFloor): void {
    const bounds = floor.worldBounds;
    const min = new Vector3();
    const max = new Vector3();
    bounds.getCenter(min);
    bounds.getSize(max);

    const size = this.config.size;
    // Project corners to canvas
    const corners = [
      new Vector3(bounds.min.x, 0, bounds.min.z),
      new Vector3(bounds.max.x, 0, bounds.min.z),
      new Vector3(bounds.max.x, 0, bounds.max.z),
      new Vector3(bounds.min.x, 0, bounds.max.z),
    ];

    const points = corners.map((c) => {
      const v = c.clone().applyMatrix4(this.worldToMap);
      return { x: v.x, y: size - v.z }; // Flip Y for canvas
    });

    // Floor color based on state
    if (floor.pavilion) {
      ctx.fillStyle = floor.active ? '#22c55e' : '#4ade80';
    } else if (floor.active) {
      ctx.fillStyle = '#ff5f2e';
    } else {
      ctx.fillStyle = 'rgba(138, 147, 163, 0.3)';
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fill();

    // Border for active floor
    if (floor.active) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Label
    if (this.config.showLabels) {
      const centerX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
      const centerY = points.reduce((sum, p) => sum + p.y, 0) / points.length;

      ctx.fillStyle = floor.active ? '#fff' : '#8a93a3';
      ctx.font = '10px "Geist Mono Variable", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const label = floor.pavilion ? '☕' : (floor.level === 0 ? 'G' : `L${floor.level}`);
      ctx.fillText(label, centerX, centerY - 6);

      // Agent count
      if (floor.agentCount > 0) {
        ctx.font = '9px "Geist Mono Variable", monospace';
        ctx.fillText(`${floor.agentCount}`, centerX, centerY + 8);
      }
    }
  }

  private drawAgents(_ctx: CanvasRenderingContext2D): void {
    // Agents are drawn as tiny dots on their floor
    // This would need agent positions from World - simplified for now
  }

  private drawHover(ctx: CanvasRenderingContext2D, floor: MinimapFloor): void {
    const bounds = floor.worldBounds;
    const corners = [
      new Vector3(bounds.min.x, 0, bounds.min.z),
      new Vector3(bounds.max.x, 0, bounds.min.z),
      new Vector3(bounds.max.x, 0, bounds.max.z),
      new Vector3(bounds.min.x, 0, bounds.max.z),
    ];

    const points = corners.map((c) => {
      const v = c.clone().applyMatrix4(this.worldToMap);
      return { x: v.x, y: this.config.size - v.z };
    });

    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private onClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find floor under cursor
    for (const floor of this.floors) {
      if (this.pointInFloor(x, y, floor)) {
        eventBus.emit('floor:focus', { key: floor.key });
        this.showToast(floor.pavilion ? `Jumped to ${getPavilionName()}` : `Jumped to ${getFloorName(floor.key)} (${getBuildingName(`b${floor.building}`)})`);
        break;
      }
    }
  }

  private onHover(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    this.hoverFloor = null;
    for (const floor of this.floors) {
      if (this.pointInFloor(x, y, floor)) {
        this.hoverFloor = floor;
        this.canvas.style.cursor = 'pointer';
        this.render();
        return;
      }
    }
    this.canvas.style.cursor = 'crosshair';
    this.render();
  }

  private pointInFloor(x: number, y: number, floor: MinimapFloor): boolean {
    const bounds = floor.worldBounds;
    const corners = [
      new Vector3(bounds.min.x, 0, bounds.min.z),
      new Vector3(bounds.max.x, 0, bounds.min.z),
      new Vector3(bounds.max.x, 0, bounds.max.z),
      new Vector3(bounds.min.x, 0, bounds.max.z),
    ];

    const points = corners.map((c) => {
      const v = c.clone().applyMatrix4(this.worldToMap);
      return { x: v.x, y: this.config.size - v.z };
    });

    // Point-in-polygon test
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x, yi = points[i].y;
      const xj = points[j].x, yj = points[j].y;
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  private showToast(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'minimap-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('in'));
    setTimeout(() => {
      toast.classList.remove('in');
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  }

  private startLoop(): void {
    // The map is static between data updates (agent dots are counts, not
    // positions), so redraw at the update cadence instead of every frame.
    this.render();
    this.animationId = window.setInterval(() => {
      if (!document.hidden) this.render();
    }, this.config.updateInterval);
  }

  /** Show/hide minimap */
  setVisible(visible: boolean): void {
    this.canvas.style.opacity = visible ? '1' : '0';
    this.canvas.style.pointerEvents = visible ? 'auto' : 'none';
    this.canvas.style.transform = visible ? 'scale(1)' : 'scale(0.9)';
  }

  dispose(): void {
    if (this.animationId) clearInterval(this.animationId);
    if (this.clickHandler) this.canvas.removeEventListener('click', this.clickHandler);
    this.canvas.remove();
  }
}

let minimapInstance: MinimapController | null = null;

export function initMinimap(container: HTMLElement, config?: Partial<MinimapConfig>): MinimapController {
  if (minimapInstance) minimapInstance.dispose();
  minimapInstance = new MinimapController(container, config);
  return minimapInstance;
}

export function getMinimap(): MinimapController | null {
  return minimapInstance;
}