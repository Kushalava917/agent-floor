/**
 * Seasonal themes — date-driven asset swap (leaves/snow/blossoms on garden, lights on façade).
 * Northern hemisphere seasons by default, configurable.
 */

import { eventBus } from '../../core/event-bus';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Hemisphere = 'north' | 'south';

interface SeasonConfig {
  hemisphere: Hemisphere;
  // Custom season start dates (month, day) - 1-indexed
  customStarts?: Record<Season, [number, number]>;
}

const DEFAULT_CONFIG: SeasonConfig = {
  hemisphere: 'north',
  customStarts: {
    spring: [3, 20],
    summer: [6, 21],
    autumn: [9, 22],
    winter: [12, 21],
  },
};

// Seasonal visual properties
export interface SeasonalTheme {
  season: Season;
  garden: {
    groundColor: string;
    leafColor: string;
    flowerColors: string[];
    treeType: 'bare' | 'leafy' | 'flowering' | 'conifer';
    particleType: 'none' | 'petals' | 'leaves' | 'snow';
  };
  facade: {
    lightColor: string;
    lightIntensity: number;
    decoration: 'none' | 'string-lights' | 'wreaths' | 'lanterns';
  };
  sky: {
    horizon: string;
    zenith: string;
    fogColor: string;
  };
  weatherBias: {
    rainChance: number;
    snowChance: number;
    fogChance: number;
  };
}

const SEASONAL_THEMES: Record<Season, SeasonalTheme> = {
  spring: {
    season: 'spring',
    garden: {
      groundColor: '#4a7c2e',
      leafColor: '#7dbf4f',
      flowerColors: ['#ffb3c1', '#ffe680', '#a8e0ff', '#ffd1a1'],
      treeType: 'flowering',
      particleType: 'petals',
    },
    facade: {
      lightColor: '#fff8e7',
      lightIntensity: 0.8,
      decoration: 'string-lights',
    },
    sky: {
      horizon: '#87ceeb',
      zenith: '#4da6ff',
      fogColor: '#c8e6ff',
    },
    weatherBias: { rainChance: 0.4, snowChance: 0, fogChance: 0.2 },
  },
  summer: {
    season: 'summer',
    garden: {
      groundColor: '#3d6b1f',
      leafColor: '#5a9c3a',
      flowerColors: ['#ff6b6b', '#ffd93d', '#6bcb77'],
      treeType: 'leafy',
      particleType: 'none',
    },
    facade: {
      lightColor: '#fff5e0',
      lightIntensity: 0.6,
      decoration: 'none',
    },
    sky: {
      horizon: '#87ceeb',
      zenith: '#1e90ff',
      fogColor: '#a8d0ff',
    },
    weatherBias: { rainChance: 0.3, snowChance: 0, fogChance: 0.1 },
  },
  autumn: {
    season: 'autumn',
    garden: {
      groundColor: '#8b6b2e',
      leafColor: '#c8734f',
      flowerColors: ['#d4a574', '#b8860b', '#cd853f'],
      treeType: 'bare',
      particleType: 'leaves',
    },
    facade: {
      lightColor: '#ffcc80',
      lightIntensity: 1.0,
      decoration: 'string-lights',
    },
    sky: {
      horizon: '#ffa07a',
      zenith: '#ff8c69',
      fogColor: '#ffdab9',
    },
    weatherBias: { rainChance: 0.5, snowChance: 0.1, fogChance: 0.4 },
  },
  winter: {
    season: 'winter',
    garden: {
      groundColor: '#e8f0f8',
      leafColor: '#ffffff',
      flowerColors: [],
      treeType: 'conifer',
      particleType: 'snow',
    },
    facade: {
      lightColor: '#ffe0b2',
      lightIntensity: 1.2,
      decoration: 'wreaths',
    },
    sky: {
      horizon: '#b0c4de',
      zenith: '#7890a8',
      fogColor: '#e0e8f0',
    },
    weatherBias: { rainChance: 0.2, snowChance: 0.5, fogChance: 0.3 },
  },
};

export class SeasonsController {
  private config: SeasonConfig;
  private currentSeason: Season;
  private updateTimer: number | null = null;
  private listeners: Set<(theme: SeasonalTheme) => void> = new Set();

  constructor(config: Partial<SeasonConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentSeason = this.computeSeason(new Date());
    this.startAutoUpdate();
  }

  private startAutoUpdate(): void {
    // Check daily at midnight
    const check = () => {
      const now = new Date();
      const season = this.computeSeason(now);
      if (season !== this.currentSeason) {
        this.currentSeason = season;
        this.notifyListeners();
        eventBus.emit('season:change', { season });
      }
      // Schedule next check at midnight
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      const msUntilMidnight = tomorrow.getTime() - now.getTime();
      this.updateTimer = window.setTimeout(check, msUntilMidnight);
    };
    check();
  }

  /** Compute season from date (northern hemisphere) */
  private computeSeason(date: Date): Season {
    const starts = this.config.customStarts ?? DEFAULT_CONFIG.customStarts!;
    const month = date.getMonth() + 1;
    const day = date.getDate();

    // Convert to day of year for comparison
    const doy = this.dayOfYear(month, day);
    const springStart = this.dayOfYear(...starts.spring);
    const summerStart = this.dayOfYear(...starts.summer);
    const autumnStart = this.dayOfYear(...starts.autumn);
    const winterStart = this.dayOfYear(...starts.winter);

    if (this.config.hemisphere === 'south') {
      // Southern hemisphere: seasons flipped
      if (doy >= springStart || doy < autumnStart) return 'autumn';
      if (doy >= autumnStart || doy < winterStart) return 'winter';
      if (doy >= winterStart || doy < summerStart) return 'spring';
      return 'summer';
    } else {
      // Northern hemisphere
      if (doy >= springStart && doy < summerStart) return 'spring';
      if (doy >= summerStart && doy < autumnStart) return 'summer';
      if (doy >= autumnStart && doy < winterStart) return 'autumn';
      return 'winter';
    }
  }

  private dayOfYear(month: number, day: number): number {
    const daysInMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    return daysInMonth[month - 1] + day;
  }

  /** Get current season */
  getSeason(): Season {
    return this.currentSeason;
  }

  /** Get theme for current season */
  getTheme(): SeasonalTheme {
    return SEASONAL_THEMES[this.currentSeason];
  }

  /** Subscribe to season changes */
  subscribe(listener: (theme: SeasonalTheme) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Force season (for testing) */
  setSeason(season: Season): void {
    if (season !== this.currentSeason) {
      this.currentSeason = season;
      this.notifyListeners();
      eventBus.emit('season:change', { season });
    }
  }

  /** Force update from current date */
  refresh(): void {
    const season = this.computeSeason(new Date());
    if (season !== this.currentSeason) {
      this.currentSeason = season;
      this.notifyListeners();
      eventBus.emit('season:change', { season });
    }
  }

  private notifyListeners(): void {
    const theme = this.getTheme();
    for (const listener of this.listeners) {
      listener(theme);
    }
  }

  dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.listeners.clear();
  }
}

let seasonsInstance: SeasonsController | null = null;

export function initSeasons(config?: Partial<SeasonConfig>): SeasonsController {
  if (seasonsInstance) seasonsInstance.dispose();
  seasonsInstance = new SeasonsController(config);
  return seasonsInstance;
}

export function getSeasons(): SeasonsController | null {
  return seasonsInstance;
}