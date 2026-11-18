/**
 * Room Inspector — side panel showing detailed team/floor info when a floor is clicked.
 * Replaces the agent card when a floor/building is selected.
 */

import { eventBus } from '../../core/event-bus';
import { getBuildingName, getFloorName, getPavilionName } from '../personalization/office-names';
import { STATUS_COLORS, STATUS_LABEL, teamAccent, sourceLabel } from '../../world/palette';
import { icon } from '../../ui/icons';

interface TeamInfo {
  id: string;
  name: string;
  hue: number;
  order: number;
  members: AgentInfo[];
  task?: string;
}

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  source: string;
  status: string;
  activity: string;
  tool?: string;
  parent?: string;
}

interface FloorInfo {
  key: string;
  building: number;
  level: number;
  pavilion: boolean;
  teams: TeamInfo[];
  totalAgents: number;
  capacity: number;
}

export class InspectorController {
  private panel!: HTMLElement;
  private currentFloor: FloorInfo | null = null;
  private updateTimer: number | null = null;
  private offFloor: (() => void) | null = null;

  constructor(private container: HTMLElement) {
    this.createPanel();
    this.bindEvents();
  }

  private createPanel(): void {
    this.panel = document.createElement('aside');
    this.panel.className = 'inspector glass';
    this.panel.setAttribute('aria-label', 'Floor details');
    this.panel.setAttribute('aria-hidden', 'true');
    this.panel.innerHTML = `
      <div class="inspector-head">
        <h2 class="inspector-title"></h2>
        <button type="button" class="inspector-close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="inspector-body"></div>
    `;
    this.container.appendChild(this.panel);

    this.panel.querySelector('.inspector-close')!.addEventListener('click', () => this.hide());
  }

  private bindEvents(): void {
    // World emits `floor:selected` once it has accepted the focus, so the panel
    // never opens on a floor that does not exist.
    this.offFloor = eventBus.on('floor:selected', ({ key }) => {
      if (key) this.showFloor(key);
      else this.hide();
    });
  }

  /** Show inspector for a floor key */
  showFloor(key: string): void {
    if (this.currentFloor?.key !== key) this.showLoading(key);
  }

  /** Update with actual floor data (called from World) */
  updateFloor(floor: FloorInfo): void {
    this.currentFloor = floor;
    this.render();
    this.show();
  }

  private showLoading(key: string): void {
    this.panel.querySelector('.inspector-title')!.textContent = getFloorName(key);
    this.panel.querySelector('.inspector-body')!.innerHTML = `
      <div class="inspector-loading">
        <div class="spinner"></div>
        <p>Loading floor details...</p>
      </div>
    `;
    this.show();
  }

  private render(): void {
    if (!this.currentFloor) return;

    const f = this.currentFloor;
    const isPavilion = f.pavilion;
    const buildingName = isPavilion ? '' : getBuildingName(`b${f.building}`);
    const floorName = isPavilion ? getPavilionName() : getFloorName(f.key);

    let html = `
      <div class="inspector-header">
        <div class="inspector-meta">
          <span class="inspector-badge${isPavilion ? ' pavilion' : ''}">${floorName}</span>
          ${buildingName ? `<span class="inspector-building">${buildingName}</span>` : ''}
        </div>
        <div class="inspector-stats">
          <div class="stat">
            <span class="stat-value">${f.totalAgents}/${f.capacity}</span>
            <span class="stat-label">Agents</span>
          </div>
          <div class="stat">
            <span class="stat-value">${f.teams.length}</span>
            <span class="stat-label">Teams</span>
          </div>
        </div>
      </div>
    `;

    if (f.teams.length > 0) {
      html += `<h3 class="inspector-section-title">Teams</h3>`;
      for (const team of f.teams) {
        const accent = teamAccent(team.hue).getStyle();
        const activeMembers = team.members.filter((m) => m.status !== 'offline').length;
        html += `
          <div class="team-card" data-team="${team.id}">
            <div class="team-header">
              <span class="team-swatch" style="background:${accent}"></span>
              <span class="team-name">${this.escape(team.name)}</span>
              <span class="team-count">${activeMembers}/${team.members.length}</span>
            </div>
            <p class="team-task">${this.escape(team.task || 'No active task')}</p>
            <div class="team-members">
        `;
        for (const member of team.members) {
          const statusColor = STATUS_COLORS[member.status as keyof typeof STATUS_COLORS] ?? '#8a93a3';
          const statusLabel = STATUS_LABEL[member.status as keyof typeof STATUS_LABEL] ?? member.status;
          html += `
            <div class="member-row" data-agent="${member.id}">
              <span class="member-dot" style="background:${statusColor}"></span>
              <span class="member-name">${this.escape(member.name)}</span>
              <span class="member-role">${this.escape(member.role)}</span>
              <span class="member-status" style="color:${statusColor}">${statusLabel}</span>
              <span class="member-source">${this.escape(sourceLabel(member.source))}</span>
            </div>
          `;
        }
        html += `
            </div>
          </div>
        `;
      }
    } else {
      html += `
        <div class="inspector-empty">
          <p>No teams on this floor yet.</p>
          <p class="inspector-note">Agents will appear when they connect.</p>
        </div>
      `;
    }

    this.panel.querySelector('.inspector-body')!.innerHTML = html;
    this.panel.querySelector('.inspector-title')!.textContent = '';
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  show(): void {
    this.panel.classList.add('show');
    this.panel.setAttribute('aria-hidden', 'false');
  }

  hide(): void {
    if (!this.panel.classList.contains('show')) return;
    this.panel.classList.remove('show');
    this.panel.setAttribute('aria-hidden', 'true');
    this.currentFloor = null;
  }

  dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.offFloor?.();
    this.offFloor = null;
    this.panel.remove();
  }
}

let inspectorInstance: InspectorController | null = null;

export function initInspector(container: HTMLElement): InspectorController {
  if (inspectorInstance) inspectorInstance.dispose();
  inspectorInstance = new InspectorController(container);
  return inspectorInstance;
}

export function getInspector(): InspectorController | null {
  return inspectorInstance;
}