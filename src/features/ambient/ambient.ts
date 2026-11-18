/**
 * Ambient life — courier pathfinding through corridors, plant sway (vertex shader),
 * coffee steam particles, screen glow pulse.
 */

import {
  Vector3,
  Points,
  BufferGeometry,
  BufferAttribute,
  PointsMaterial,
  Color,
  AdditiveBlending,
  Object3D,
} from 'three';
import { eventBus } from '../../core/event-bus';
import { rand } from '../../world/props';

interface AmbientConfig {
  enabled: boolean;
  plantSwaySpeed: number;
  particleCount: number;
  courierInterval: number;
}

const DEFAULT_CONFIG: AmbientConfig = {
  enabled: true,
  plantSwaySpeed: 0.8,
  particleCount: 50,
  courierInterval: 15000,
};

interface PlantSwayData {
  mesh: any; // Three.js Mesh with vertex shader
  originalPositions: Float32Array;
  swayOffset: number;
}

interface ParticleData {
  geometry: BufferGeometry;
  material: PointsMaterial;
  points: Points;
  positions: Float32Array;
  velocities: Float32Array;
  lifetimes: Float32Array;
  maxLifetime: number;
}

export class AmbientLifeController {
  private config: AmbientConfig;
  private plantSwayData: PlantSwayData[] = [];
  private particles: ParticleData | null = null;
  private courierTimer: number | null = null;
  private time = 0;
  private animationId: number | null = null;
  private scene: Object3D | null = null;
  private courierPath: Vector3[] = [];

  constructor(config: Partial<AmbientConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Initialize with scene reference (called from World) */
  init(scene: Object3D): void {
    this.scene = scene;
    this.buildCourierPath();
    if (this.config.enabled) {
      this.createParticles();
      this.startCourier();
      this.startLoop();
    }
  }

  /** Register a plant mesh for swaying (call from Building/TeamRoom when creating plants) */
  registerPlant(mesh: any): void {
    if (!mesh.geometry || !mesh.geometry.attributes.position) return;

    const positions = mesh.geometry.attributes.position.array as Float32Array;
    const originalPositions = new Float32Array(positions);
    const swayOffset = rand() * Math.PI * 2;

    this.plantSwayData.push({ mesh, originalPositions, swayOffset });
    mesh.geometry.attributes.position.needsUpdate = true;
  }

  /** Unregister plant (on dispose) */
  unregisterPlant(mesh: any): void {
    const idx = this.plantSwayData.findIndex((d) => d.mesh === mesh);
    if (idx >= 0) this.plantSwayData.splice(idx, 1);
  }

  private buildCourierPath(): void {
    // Simple corridor path - will be refined by World with actual layout
    this.courierPath = [
      new Vector3(-20, 0.5, 0),
      new Vector3(-10, 0.5, 0),
      new Vector3(0, 0.5, 0),
      new Vector3(10, 0.5, 0),
      new Vector3(20, 0.5, 0),
      new Vector3(30, 0.5, 0),
    ];
  }

  /** Set courier path from actual building layout */
  setCourierPath(path: Vector3[]): void {
    this.courierPath = path;
  }

  private createParticles(): void {
    if (!this.scene) return;

    const count = this.config.particleCount;
    const geometry = new BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const lifetimes = new Float32Array(count);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      this.resetParticle(i, positions, velocities, lifetimes, sizes);
    }

    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('size', new BufferAttribute(sizes, 1));

    const material = new PointsMaterial({
      size: 0.02,
      sizeAttenuation: true,
      color: new Color('#ffe2b0'),
      transparent: true,
      opacity: 0.6,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    const points = new Points(geometry, material);
    points.frustumCulled = false;
    this.scene.add(points);

    this.particles = { geometry, material, points, positions, velocities, lifetimes, maxLifetime: 8 };
  }

  private resetParticle(i: number, positions: Float32Array, velocities: Float32Array, lifetimes: Float32Array, sizes: Float32Array): void {
    // Spawn near coffee machines / desks / courier path
    const pathIdx = Math.floor(rand() * this.courierPath.length);
    const base = this.courierPath[pathIdx];

    positions[i * 3] = base.x + (rand() - 0.5) * 4;
    positions[i * 3 + 1] = 0.8 + rand() * 1.5;
    positions[i * 3 + 2] = base.z + (rand() - 0.5) * 4;

    velocities[i * 3] = (rand() - 0.5) * 0.01;
    velocities[i * 3 + 1] = 0.005 + rand() * 0.02; // upward drift
    velocities[i * 3 + 2] = (rand() - 0.5) * 0.01;

    lifetimes[i] = 0;
    sizes[i] = 0.015 + rand() * 0.015;
  }

  private startCourier(): void {
    if (!this.scene || this.courierPath.length < 2) return;

    // Create a simple courier mesh (will be replaced by World's Courier)
    const courierTimer = () => {
      // Just trigger event - actual courier is in World
      eventBus.emit('ambient:courier', { path: this.courierPath });
      this.courierTimer = window.setTimeout(courierTimer, this.config.courierInterval * (0.8 + rand() * 0.4));
    };
    this.courierTimer = window.setTimeout(courierTimer, 2000);
  }

  private startLoop(): void {
    const tick = () => {
      this.time += 16;
      this.updatePlantSway();
      this.updateParticles();
      this.animationId = requestAnimationFrame(tick);
    };
    tick();
  }

  private updatePlantSway(): void {
    const t = this.time * 0.001 * this.config.plantSwaySpeed;
    for (const data of this.plantSwayData) {
      const positions = data.mesh.geometry.attributes.position.array as Float32Array;
      const original = data.originalPositions;
      const count = positions.length / 3;

      for (let i = 0; i < count; i++) {
        // Only sway top portion of plant (y > 0.5)
        const y = original[i * 3 + 1];
        if (y > 0.5) {
          const swayAmount = (y - 0.5) * 0.02;
          positions[i * 3] = original[i * 3] + Math.sin(t + data.swayOffset + i * 0.5) * swayAmount;
          positions[i * 3 + 2] = original[i * 3 + 2] + Math.cos(t + data.swayOffset + i * 0.5) * swayAmount * 0.5;
        }
      }
      data.mesh.geometry.attributes.position.needsUpdate = true;
    }
  }

  private updateParticles(): void {
    if (!this.particles) return;

    const { positions, lifetimes, maxLifetime, geometry } = this.particles;
    const count = lifetimes.length;
    const dt = 16; // ms

    for (let i = 0; i < count; i++) {
      lifetimes[i] += dt;
      if (lifetimes[i] >= maxLifetime * 1000) {
        this.resetParticle(i, positions, this.particles!.velocities, lifetimes, (geometry.getAttribute('size') as BufferAttribute).array as Float32Array);
      } else {
        positions[i * 3] += this.particles!.velocities[i * 3];
        positions[i * 3 + 1] += this.particles!.velocities[i * 3 + 1];
        positions[i * 3 + 2] += this.particles!.velocities[i * 3 + 2];

        // Fade out
        const lifeRatio = lifetimes[i] / (maxLifetime * 1000);
        const sizeAttr = geometry.getAttribute('size') as BufferAttribute;
        sizeAttr.array[i] = (1 - lifeRatio) * 0.03;
        sizeAttr.needsUpdate = true;
      }
    }
    geometry.attributes.position.needsUpdate = true;
  }

  /** Enable/disable ambient life */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (enabled && !this.animationId) {
      this.startLoop();
    } else if (!enabled && this.animationId) {
      this.stop();
    }
  }

  /** Update config */
  setConfig(config: Partial<AmbientConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Advance ambient life by dt seconds (for integration with external render loop) */
  tick(dt: number): void {
    this.time += dt * 1000; // dt is in seconds, convert to ms
    this.updatePlantSway();
    this.updateParticles();
  }

  stop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.courierTimer) {
      clearTimeout(this.courierTimer);
      this.courierTimer = null;
    }
    if (this.particles && this.scene) {
      this.scene.remove(this.particles.points);
      this.particles.geometry.dispose();
      this.particles.material.dispose();
      this.particles = null;
    }
    this.plantSwayData = [];
  }

  dispose(): void {
    this.stop();
  }
}

let ambientInstance: AmbientLifeController | null = null;

export function initAmbient(config?: Partial<AmbientConfig>): AmbientLifeController {
  if (ambientInstance) ambientInstance.dispose();
  ambientInstance = new AmbientLifeController(config);
  return ambientInstance;
}

export function getAmbient(): AmbientLifeController | null {
  return ambientInstance;
}