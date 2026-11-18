/**
 * Activity heatmap — floor material tinted by agent status density.
 * Green = working, Yellow = thinking/waiting, Red = error, Blue = idle, Gray = offline.
 * Updates every few seconds, smooth transitions.
 */

import { MeshStandardMaterial, Color } from 'three';
import { STATUS_COLORS } from '../../world/palette';
import { eventBus } from '../../core/event-bus';

interface HeatmapConfig {
  updateInterval: number;      // ms
  transitionDuration: number;  // ms
  intensity: number;           // 0-1, how strong the tint
}

const DEFAULT_CONFIG: HeatmapConfig = {
  updateInterval: 3000,
  transitionDuration: 2000,
  intensity: 0.35,
};

interface FloorZone {
  material: MeshStandardMaterial;
  originalColor: Color;
  targetColor: Color;
  currentColor: Color;
  lastUpdate: number;
}

export class HeatmapController {
  private zones = new Map<string, FloorZone>();
  private config: HeatmapConfig;
  private timer: number | null = null;
  private enabled = true;

  constructor(config: Partial<HeatmapConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.bindEvents();
  }

  private bindEvents(): void {
    eventBus.on('agent:status', () => this.scheduleUpdate());
    eventBus.on('agent:join', () => this.scheduleUpdate());
    eventBus.on('agent:leave', () => this.scheduleUpdate());
    eventBus.on('ui:theme', ({ dark }) => this.setEnabled(!dark)); // Heatmap only in light theme
  }

  /** Register a floor material zone (call from Building when creating floor segments) */
  registerZone(key: string, material: MeshStandardMaterial): void {
    if (this.zones.has(key)) return;
    const original = material.color.clone();
    this.zones.set(key, {
      material,
      originalColor: original,
      targetColor: original.clone(),
      currentColor: original.clone(),
      lastUpdate: 0,
    });
  }

  /** Unregister when floor is disposed */
  unregisterZone(key: string): void {
    this.zones.delete(key);
  }

  /** Enable/disable heatmap */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.resetAll();
    else this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.update();
    }, 0);
  }

  /** Compute status density per floor and update zone colors */
  private update(): void {
    if (!this.enabled) return;

    // Get current agent states from World (via event bus would need World reference)
    // For now, we'll use a simple approach: the World will call this with aggregated data
    // This method is called by World.syncInner after computing status counts
  }

  /** Called by World with aggregated status counts per floor */
  updateFromCounts(floorCounts: Map<string, Map<string, number>>): void {
    if (!this.enabled) return;

    for (const [floorKey, counts] of floorCounts) {
      const zone = this.zones.get(floorKey);
      if (!zone) continue;

      const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
      if (total === 0) {
        zone.targetColor.copy(zone.originalColor);
        continue;
      }

      // Weighted average of status colors
      const mixed = new Color(0, 0, 0);
      for (const [status, count] of counts) {
        const weight = count / total;
        const hex = STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? '#8a93a3';
        mixed.add(new Color(hex).multiplyScalar(weight));
      }

      // Blend with original floor color
      zone.targetColor.copy(zone.originalColor).lerp(mixed, this.config.intensity);
    }
  }

  /** Animation tick — call from World render loop */
  tick(dt: number): void {
    if (!this.enabled) return;

    const speed = 1 / (this.config.transitionDuration / 1000);
    for (const zone of this.zones.values()) {
      if (!zone.currentColor.equals(zone.targetColor)) {
        zone.currentColor.lerp(zone.targetColor, Math.min(1, speed * dt));
        zone.material.color.copy(zone.currentColor);
      }
    }
  }

  /** Reset all zones to original colors */
  private resetAll(): void {
    for (const zone of this.zones.values()) {
      zone.targetColor.copy(zone.originalColor);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.resetAll();
    this.zones.clear();
  }
}

// Singleton instance
export const heatmap = new HeatmapController();