/**
 * Time-of-day cycle — 24min = 24hr, sun position drives shadows/sky,
 * windows emit light at night, desk lamps auto-on for "working" agents after 20:00.
 */

import {
  DirectionalLight,
  HemisphereLight,
  Fog,
  Color,
} from 'three';
import { eventBus } from '../../core/event-bus';
import { PALETTES, type ThemeName } from '../../world/palette';

export type TimePhase = 'dawn' | 'day' | 'dusk' | 'night';

interface TimeOfDayConfig {
  cycleDuration: number;     // ms for full 24hr cycle (default: 24min = 1440000ms)
  startHour: number;         // 0-23, starting hour
  realtime: boolean;         // if true, syncs with system clock
}

const DEFAULT_CONFIG: TimeOfDayConfig = {
  cycleDuration: 24 * 60 * 1000, // 24 minutes = 24 hours
  startHour: 8,
  realtime: false,
};

interface TimeState {
  hour: number;          // 0-23
  minute: number;        // 0-59
  phase: TimePhase;
  progress: number;      // 0-1 through current phase
  sunAngle: number;      // radians, -PI/2 (midnight) to PI/2 (noon)
}

export class TimeOfDayController {
  private config: TimeOfDayConfig;
  private state: TimeState;
  private animationId: number | null = null;
  private startTime = 0;

  // Three.js objects (set by World)
  private sun!: DirectionalLight;
  private hemi!: HemisphereLight;
  private sceneFog!: Fog;
  private theme: ThemeName = 'light';

  constructor(config: Partial<TimeOfDayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.computeState(this.config.startHour, 0);
    this.bindEvents();
  }

  /** Initialize with Three.js objects (called from World after setup) */
  init(sun: DirectionalLight, hemi: HemisphereLight, sceneFog: Fog | null, theme: ThemeName): void {
    this.sun = sun;
    this.hemi = hemi;
    this.sceneFog = sceneFog!;
    this.theme = theme;
    this.applyLighting();
  }

  private bindEvents(): void {
    eventBus.on('ui:theme', ({ dark }) => {
      this.theme = dark ? 'dark' : 'light';
      this.applyLighting();
    });
    eventBus.on('weather:change', () => this.applyLighting());
  }

  /** Start the time cycle */
  start(): void {
    if (this.animationId) return;
    this.startTime = performance.now() - this.state.progress * this.config.cycleDuration;
    this.animate();
  }

  /** Stop the time cycle */
  stop(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /** Advance time by dt seconds (for integration with external render loop) */
  tick(dt: number): void {
    // Advance internal time by dt seconds
    const minutesToAdd = dt / 60; // dt is in seconds
    const totalMinutes = this.state.hour * 60 + this.state.minute + minutesToAdd;
    const newHour = Math.floor(totalMinutes / 60) % 24;
    const newMinute = Math.floor(totalMinutes % 60);
    this.state = this.computeState(newHour, newMinute);
    this.applyLighting();
    eventBus.emit('time:tick', this.getEventData());
  }

  /** Internal animation loop using requestAnimationFrame */
  private animate(): void {
    const now = performance.now();
    const elapsed = now - this.startTime;
    const cyclePos = (elapsed % this.config.cycleDuration) / this.config.cycleDuration;
    const totalMinutes = cyclePos * 24 * 60;
    const hour = Math.floor(totalMinutes / 60) % 24;
    const minute = Math.floor(totalMinutes % 60);

    this.state = this.computeState(hour, minute);
    this.applyLighting();
    eventBus.emit('time:tick', this.getEventData());

    this.animationId = requestAnimationFrame(() => this.animate());
  }

  /** Set specific time (hour 0-23, minute 0-59) */
  setTime(hour: number, minute: number = 0): void {
    this.state = this.computeState(hour, minute);
    this.applyLighting();
    eventBus.emit('time:tick', this.getEventData());
  }

  /** Get current time state */
  getState(): Readonly<TimeState> {
    return { ...this.state };
  }

  /** Get event data for bus */
  private getEventData() {
    return {
      hour: this.state.hour,
      minute: this.state.minute,
      phase: this.state.phase,
    };
  }

  private computeState(hour: number, minute: number): TimeState {
    const totalMinutes = hour * 60 + minute;
    const progress = (totalMinutes % (24 * 60)) / (24 * 60);

    let phase: TimePhase;
    let phaseProgress: number;

    if (hour >= 5 && hour < 7) { // Dawn: 5-7
      phase = 'dawn';
      phaseProgress = (totalMinutes - 5 * 60) / (2 * 60);
    } else if (hour >= 7 && hour < 18) { // Day: 7-18
      phase = 'day';
      phaseProgress = (totalMinutes - 7 * 60) / (11 * 60);
    } else if (hour >= 18 && hour < 20) { // Dusk: 18-20
      phase = 'dusk';
      phaseProgress = (totalMinutes - 18 * 60) / (2 * 60);
    } else { // Night: 20-5
      phase = 'night';
      const nightStart = hour >= 20 ? 20 * 60 : (24 + 5) * 60;
      const nightEnd = 29 * 60; // 5am next day
      phaseProgress = (totalMinutes - nightStart) / (nightEnd - nightStart);
    }

    // Sun angle: -PI/2 at midnight, 0 at sunrise/sunset, PI/2 at noon
    const sunAngle = Math.sin(progress * Math.PI * 2) * Math.PI / 2;

    return { hour, minute, phase, progress: phaseProgress, sunAngle };
  }

  /** Apply lighting based on current time and theme */
  private applyLighting(): void {
    if (!this.sun || !this.hemi) return;

    const p = PALETTES[this.theme];
    const { phase, sunAngle } = this.state;

    // Sun position
    const sunHeight = Math.max(0, Math.sin(sunAngle));
    const sunAzimuth = Math.cos(sunAngle);
    this.sun.position.set(
      sunAzimuth * 50,
      sunHeight * 50 + 10,
      30
    );
    this.sun.target.position.set(0, 0, 0);

    // Sun intensity and color based on phase
    let sunIntensity = 0;
    let sunColor = new Color(p.sunColor);
    let hemiIntensity = p.hemiIntensity;
    let hemiSky = new Color(p.hemiSky);
    let hemiGround = new Color(p.hemiGround);

    switch (phase) {
      case 'dawn':
        sunIntensity = 0.3 + this.state.progress * 0.7;
        sunColor = new Color('#ffb347').lerp(new Color(p.sunColor), this.state.progress);
        hemiSky = new Color('#ffcc80').lerp(new Color(p.hemiSky), this.state.progress);
        hemiGround = new Color('#444').lerp(new Color(p.hemiGround), this.state.progress);
        hemiIntensity = p.hemiIntensity * (0.5 + this.state.progress * 0.5);
        break;
      case 'day':
        sunIntensity = p.sunIntensity;
        sunColor.set(p.sunColor);
        hemiSky.set(p.hemiSky);
        hemiGround.set(p.hemiGround);
        hemiIntensity = p.hemiIntensity;
        break;
      case 'dusk':
        sunIntensity = p.sunIntensity * (1 - this.state.progress * 0.7);
        sunColor = new Color(p.sunColor).lerp(new Color('#ff6b35'), this.state.progress);
        hemiSky = new Color(p.hemiSky).lerp(new Color('#2a1a3a'), this.state.progress);
        hemiGround = new Color(p.hemiGround).lerp(new Color('#1a1a2e'), this.state.progress);
        hemiIntensity = p.hemiIntensity * (1 - this.state.progress * 0.5);
        break;
      case 'night':
        sunIntensity = 0;
        hemiSky = new Color(p.sky);
        hemiGround = new Color(p.hemiGround).multiplyScalar(0.3);
        hemiIntensity = p.hemiIntensity * 0.3;
        break;
    }

    this.sun.intensity = sunIntensity;
    this.sun.color.copy(sunColor);
    this.hemi.intensity = hemiIntensity;
    this.hemi.color.copy(hemiSky);
    this.hemi.groundColor.copy(hemiGround);

    // Fog changes with time
    if (this.sceneFog) {
      if (phase === 'night') {
        this.sceneFog.color.set(p.sky);
        this.sceneFog.near = 40;
        this.sceneFog.far = 180;
      } else if (phase === 'dawn' || phase === 'dusk') {
        this.sceneFog.color.set('#ffcc80');
        this.sceneFog.near = 60;
        this.sceneFog.far = 220;
      } else {
        this.sceneFog.color.set(p.sky);
        this.sceneFog.near = 80;
        this.sceneFog.far = 260;
      }
    }

    // Sky background
    // (World.setTheme handles scene.background, but we can adjust for time)
  }

  /** Check if desk lamps should be on (after 20:00 or before 6:00) */
  shouldLampsBeOn(): boolean {
    return this.state.hour >= 20 || this.state.hour < 6;
  }

  /** Get time string for display */
  getTimeString(): string {
    return `${this.state.hour.toString().padStart(2, '0')}:${this.state.minute.toString().padStart(2, '0')}`;
  }

  dispose(): void {
    this.stop();
  }
}

let timeOfDayInstance: TimeOfDayController | null = null;

export function initTimeOfDay(config?: Partial<TimeOfDayConfig>): TimeOfDayController {
  if (timeOfDayInstance) timeOfDayInstance.dispose();
  timeOfDayInstance = new TimeOfDayController(config);
  return timeOfDayInstance;
}

export function getTimeOfDay(): TimeOfDayController | null {
  return timeOfDayInstance;
}