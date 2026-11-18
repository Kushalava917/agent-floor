/**
 * Weather on windows — shader-driven rain, snow, fog, condensation on north-facing glass.
 * Controlled via event bus, driven by time-of-day and season.
 */

import {
  MeshStandardMaterial,
  ShaderMaterial,
  Color,
  Vector2,
} from 'three';
import { eventBus } from '../../core/event-bus';

export type WeatherType = 'clear' | 'rain' | 'snow' | 'fog' | 'storm';
export type WeatherIntensity = number; // 0-1

interface WeatherUniforms {
  uTime: { value: number };
  uWeatherType: { value: number };      // 0=clear, 1=rain, 2=snow, 3=fog, 4=storm
  uIntensity: { value: number };
  uDropSize: { value: number };
  uDropSpeed: { value: number };
  uWind: { value: Vector2 };
  uFogDensity: { value: number };
  uCondensation: { value: number };
  uTint: { value: Color };
}

const WEATHER_SHADER = {
  uniforms: {
    uTime: { value: 0 },
    uWeatherType: { value: 0 },
    uIntensity: { value: 0 },
    uDropSize: { value: 0.008 },
    uDropSpeed: { value: 1.5 },
    uWind: { value: new Vector2(0.3, 1.0) },
    uFogDensity: { value: 0 },
    uCondensation: { value: 0 },
    uTint: { value: new Color(0x88aacc) },
  },
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    void main() {
      vUv = uv;
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform int uWeatherType;
    uniform float uIntensity;
    uniform float uDropSize;
    uniform float uDropSpeed;
    uniform vec2 uWind;
    uniform float uFogDensity;
    uniform float uCondensation;
    uniform vec3 uTint;
    varying vec2 vUv;
    varying vec3 vWorldPos;

    // Hash for pseudo-random
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // Rain drop
    float rain(vec2 uv, float t) {
      vec2 id = floor(uv / uDropSize);
      vec2 gv = fract(uv / uDropSize) - 0.5;
      float h = hash(id);
      float y = mod(h * 100.0 + t * uDropSpeed, 1.0);
      float drop = smoothstep(0.5, 0.5 - uDropSize * 2.0, abs(gv.y - y)) *
                   smoothstep(0.5, 0.5 - uDropSize * 0.5, abs(gv.x));
      return drop * (0.5 + h * 0.5);
    }

    // Snowflake
    float snow(vec2 uv, float t) {
      vec2 id = floor(uv * 20.0);
      vec2 gv = fract(uv * 20.0) - 0.5;
      float h = hash(id);
      float y = mod(h * 50.0 + t * 0.3, 1.0);
      float x = mod(hash(id + 1.0) * 50.0 + t * uWind.x * 0.5, 1.0);
      float flake = smoothstep(0.5, 0.5 - 0.02, length(gv - vec2(x, y)));
      return flake * h;
    }

    // Fog/condensation noise
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p, int octaves) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p *= 2.0;
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec3 baseColor = vec3(0.15, 0.18, 0.22); // dark glass base
      float alpha = 0.15; // base glass transparency

      // Condensation (always present when cold)
      if (uCondensation > 0.0) {
        float cond = fbm(vUv * 10.0 + uTime * 0.01, 4);
        cond = smoothstep(0.3, 0.7, cond);
        alpha += cond * uCondensation * 0.4;
        baseColor = mix(baseColor, vec3(0.8, 0.85, 0.9), cond * uCondensation);
      }

      // Weather effects
      if (uIntensity > 0.0) {
        if (uWeatherType == 1 || uWeatherType == 4) { // rain or storm
          float r = rain(vUv * 50.0, uTime);
          alpha += r * uIntensity * 0.3;
          baseColor = mix(baseColor, vec3(0.4, 0.5, 0.7), r * uIntensity);
        }
        if (uWeatherType == 2) { // snow
          float s = snow(vUv * 30.0, uTime);
          alpha += s * uIntensity * 0.4;
          baseColor = mix(baseColor, vec3(0.9, 0.95, 1.0), s * uIntensity);
        }
        if (uWeatherType == 3 || uWeatherType == 4) { // fog or storm
          float fog = fbm(vUv * 5.0 + uTime * 0.02, 3);
          alpha += fog * uFogDensity * uIntensity * 0.25;
          baseColor = mix(baseColor, uTint, fog * uFogDensity * uIntensity);
        }
      }

      // Night tint
      float nightFactor = smoothstep(0.5, 0.0, sin(uTime * 0.001));
      baseColor = mix(baseColor, uTint * 0.3, nightFactor * 0.5);

      gl_FragColor = vec4(baseColor, clamp(alpha, 0.05, 0.6));
    }
  `,
};

export class WeatherController {
  private materials = new Map<string, ShaderMaterial>();
  private currentWeather: WeatherType = 'clear';
  private intensity: WeatherIntensity = 0;
  private condensation = 0;
  private time = 0;
  private animationId: number | null = null;
  private readonly weatherParams: Record<WeatherType, Partial<WeatherUniforms>> = {
    clear: { uWeatherType: { value: 0 }, uIntensity: { value: 0 }, uFogDensity: { value: 0 } },
    rain: { uWeatherType: { value: 1 }, uIntensity: { value: 0.6 }, uFogDensity: { value: 0.2 } },
    snow: { uWeatherType: { value: 2 }, uIntensity: { value: 0.5 }, uFogDensity: { value: 0.1 } },
    fog: { uWeatherType: { value: 3 }, uIntensity: { value: 0.4 }, uFogDensity: { value: 0.7 } },
    storm: { uWeatherType: { value: 4 }, uIntensity: { value: 0.8 }, uFogDensity: { value: 0.4 } },
  };

  constructor() {
    this.bindEvents();
    this.startLoop();
  }

  private bindEvents(): void {
    eventBus.on('weather:change', ({ type, intensity }) => this.setWeather(type, intensity));
    eventBus.on('time:tick', ({ hour }) => this.updateCondensation(hour));
    eventBus.on('season:change', ({ season }) => this.updateSeasonalDefaults(season));
  }

  /** Register a window material (call from Building when creating north wall glass) */
  registerWindow(key: string, material: MeshStandardMaterial): ShaderMaterial {
    if (this.materials.has(key)) return this.materials.get(key)!;

    const shader = new ShaderMaterial({
      ...WEATHER_SHADER,
      transparent: true,
      depthWrite: false,
      side: 2, // DoubleSide
    });

    // Copy original material properties
    shader.uniforms.uTint.value = new Color(material.color);
    if (material.map) shader.uniforms.uTint.value = new Color(0x88aacc);

    this.materials.set(key, shader);
    return shader;
  }

  unregisterWindow(key: string): void {
    const mat = this.materials.get(key);
    if (mat) mat.dispose();
    this.materials.delete(key);
  }

  setWeather(type: WeatherType, intensity?: number): void {
    this.currentWeather = type;
    this.intensity = intensity ?? 1;

    const params = this.weatherParams[type];
    for (const mat of this.materials.values()) {
      if (params.uWeatherType) mat.uniforms.uWeatherType.value = params.uWeatherType.value;
      if (params.uIntensity) mat.uniforms.uIntensity.value = params.uIntensity.value * this.intensity;
      if (params.uFogDensity) mat.uniforms.uFogDensity.value = params.uFogDensity.value * this.intensity;
    }
  }

  private updateCondensation(hour: number): void {
    // More condensation at night/early morning (18:00-8:00)
    const night = hour >= 18 || hour < 8;
    const target = night ? 0.6 : 0.1;
    this.condensation += (target - this.condensation) * 0.02;

    for (const mat of this.materials.values()) {
      mat.uniforms.uCondensation.value = this.condensation;
    }
  }

  private updateSeasonalDefaults(season: string): void {
    // Adjust base intensity by season
    const multipliers: Record<string, number> = {
      spring: 1.0,
      summer: 0.5,  // less rain/fog
      autumn: 1.2,  // more rain/fog
      winter: 1.5,  // snow, heavy condensation
    };
    const mult = multipliers[season] ?? 1.0;
    this.setWeather(this.currentWeather, this.intensity * mult);
  }

  private startLoop(): void {
    const tick = () => {
      this.time += 16;
      for (const mat of this.materials.values()) {
        mat.uniforms.uTime.value = this.time * 0.001;
      }
      this.animationId = requestAnimationFrame(tick);
    };
    tick();
  }

  dispose(): void {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
  }
}

export const weather = new WeatherController();