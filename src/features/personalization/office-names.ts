/**
 * Custom office names — human-readable labels for buildings, floors, and the café.
 * Edit this file to rename without touching code.
 */

export interface OfficeNamesConfig {
  buildings: Record<string, string>;      // 'b0' → 'The Forge'
  floors: Record<string, string>;         // 'b0:l0' → 'Ground Floor'
  pavilion: string;                       // 'The Grind'
  lobby: Record<number, string>;          // 0 → 'Main Lobby', 1 → 'Sky Lobby'
}

export const officeNames: OfficeNamesConfig = {
  buildings: {
    b0: 'The Forge',
    b1: 'The Foundry',
    b2: 'The Workshop',
    b3: 'The Atelier',
  },
  floors: {
    'b0:l0': 'Ground Floor',
    'b0:l1': 'Upper Floor',
    'b1:l0': 'Ground Floor',
    'b1:l1': 'Upper Floor',
    'b2:l0': 'Ground Floor',
    'b2:l1': 'Upper Floor',
    'b3:l0': 'Ground Floor',
    'b3:l1': 'Upper Floor',
  },
  pavilion: 'The Grind',
  lobby: {
    0: 'Main Lobby',
    1: 'Sky Lobby',
  },
};

export function getBuildingName(key: string): string {
  return officeNames.buildings[key] ?? `Building ${key.toUpperCase()}`;
}

export function getFloorName(key: string): string {
  return officeNames.floors[key] ?? key;
}

export function getPavilionName(): string {
  return officeNames.pavilion;
}

export function getLobbyName(level: number): string {
  return officeNames.lobby[level] ?? `Level ${level} Lobby`;
}