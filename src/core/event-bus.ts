import { Vector3 } from 'three';

/**
 * Tiny typed event bus for cross-feature communication.
 * Zero deps, ~50 lines, no singleton — instantiate once in World and pass around.
 */

type Listener<T> = (payload: T) => void;
type Unsubscribe = () => void;

interface EventMap {
  // Agent events
  'agent:join': { id: string; name: string; team: string; role: string; source: string };
  'agent:leave': { id: string };
  'agent:status': { id: string; status: string; activity: string };
  'agent:message': { from: string; to: string | string[]; text: string };

  // Floor/building events
  'floor:focus': { key: string };
  /** Confirmation from World: null means floor view was cleared. */
  'floor:selected': { key: string | null };
  'floor:change': { key: string; building: number; level: number };

  // UI events
  'ui:dollhouse': { enabled: boolean };
  'ui:theme': { dark: boolean };

  // Feature events
  'weather:change': { type: WeatherType; intensity: number };
  'time:tick': { hour: number; minute: number; phase: TimePhase };
  'season:change': { season: Season };
  'ambient:courier': { path: Vector3[] };
  'season:apply': { theme: any };

  // Easter eggs
  'easter:party': { enabled: boolean };
}

type WeatherType = 'clear' | 'rain' | 'snow' | 'fog';
type TimePhase = 'dawn' | 'day' | 'dusk' | 'night';
type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export class EventBus {
  private listeners = new Map<keyof EventMap, Set<Listener<any>>>();

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): Unsubscribe {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.listeners.get(event)?.forEach((l) => l(payload));
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const eventBus = new EventBus();