/**
 * Agent Whispers — hover any desk to see a tooltip with what they're doing.
 * Shows current activity, tool, recent messages. Optional TTS readout.
 */

import { eventBus } from '../../core/event-bus';
import { STATUS_COLORS, STATUS_LABEL, sourceLabel } from '../../world/palette';
import { icon } from '../../ui/icons';

interface WhisperData {
  agentId: string;
  name: string;
  role: string;
  source: string;
  status: string;
  activity: string;
  tool?: string;
  recentMessages: string[];
  position: { x: number; y: number }; // screen position
}

export class WhispersController {
  private tooltip: HTMLElement | null = null;
  private currentAgent: string | null = null;
  private hideTimer: number | null = null;
  private ttsEnabled = false;
  private ttsVoice: SpeechSynthesisVoice | null = null;

  constructor() {
    this.createTooltip();
    this.bindEvents();
    this.initTTS();
  }

  private createTooltip(): void {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'whisper-tooltip';
    this.tooltip.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 100;
      max-width: 320px;
      padding: 14px 16px;
      border-radius: 14px;
      background: rgba(20, 24, 33, 0.95);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      color: #eef1f5;
      font: 13px/1.5 "Geist Variable", system-ui, sans-serif;
      opacity: 0;
      transform: translateY(8px) scale(0.95);
      transition: opacity 150ms ease, transform 150ms ease;
      will-change: transform, opacity;
    `;
    document.body.appendChild(this.tooltip);
  }

  private bindEvents(): void {
    eventBus.on('agent:status', ({ id, status, activity }) => {
      this.updateFromStatus({ agentId: id, status, activity });
    });

    // Listen for agent hover from World (via custom event on canvas)
    window.addEventListener('agent:hover', ((e: CustomEvent) => this.show(e.detail)) as EventListener);
    window.addEventListener('agent:unhover', () => this.hide());
  }

  private initTTS(): void {
    if ('speechSynthesis' in window) {
      const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        this.ttsVoice = voices.find((v) => v.lang.startsWith('en') && v.name.includes('Natural')) ?? voices[0] ?? null;
      };
      loadVoices();
      speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  /** Show whisper for an agent */
  show(data: WhisperData): void {
    if (!this.tooltip) return;

    this.currentAgent = data.agentId;
    this.updateContent(data);
    this.position(data.position);

    this.tooltip.style.opacity = '1';
    this.tooltip.style.transform = 'translateY(0) scale(1)';

    if (this.hideTimer) clearTimeout(this.hideTimer);

    // Optional TTS
    if (this.ttsEnabled && this.ttsVoice && data.activity) {
      this.speak(`${data.name} is ${data.activity}`);
    }
  }

  /** Update from status event (minimal data) */
  updateFromStatus(data: { agentId: string; status: string; activity: string }): void {
    if (this.currentAgent !== data.agentId) return;
    this.updateContent({ agentId: data.agentId, status: data.status, activity: data.activity });
  }

  private updateContent(data: Partial<WhisperData>): void {
    if (!this.tooltip) return;

    const status = data.status ?? 'idle';
    const color = STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? '#8a93a3';
    const statusLabel = STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status;

    this.tooltip.innerHTML = `
      <div class="whisper-header">
        <span class="whisper-dot" style="background:${color}"></span>
        <strong class="whisper-name">${this.escape(data.name ?? '')}</strong>
        <span class="whisper-role">${this.escape(data.role ?? '')}</span>
      </div>
      <div class="whisper-status">
        <span class="whisper-badge" style="background:${color}20; color:${color}; border:1px solid ${color}40">
          ${statusLabel}
        </span>
        <span class="whisper-source">${this.escape(sourceLabel(data.source ?? ''))}</span>
      </div>
      <div class="whisper-activity">${this.escape(data.activity ?? 'Nothing yet')}</div>
      ${data.tool ? `<div class="whisper-tool">${icon('plug')} ${this.escape(data.tool)}</div>` : ''}
      ${data.recentMessages && data.recentMessages.length > 0 ? `
        <div class="whisper-history">
          ${data.recentMessages.slice(0, 3).map((m) => `<div class="whisper-msg">"${this.escape(m)}"</div>`).join('')}
        </div>
      ` : ''}
      ${this.ttsEnabled ? `<button class="whisper-tts-btn" title="Read aloud">${icon('play')}</button>` : ''}
    `;

    // TTS button handler
    const ttsBtn = this.tooltip.querySelector('.whisper-tts-btn');
    if (ttsBtn) {
      ttsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (data.activity) this.speak(`${data.name} is ${data.activity}`);
      });
    }
  }

  private position(pos: { x: number; y: number }): void {
    if (!this.tooltip) return;

    const padding = 16;
    const rect = this.tooltip.getBoundingClientRect();
    let x = pos.x + 20;
    let y = pos.y - rect.height - 12;

    // Keep on screen
    if (x + rect.width > window.innerWidth - padding) x = pos.x - rect.width - 20;
    if (y < padding) y = pos.y + 20;

    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
  }

  private speak(text: string): void {
    if (!('speechSynthesis' in window) || !this.ttsVoice) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = this.ttsVoice;
    utterance.rate = 1.1;
    utterance.pitch = 1;
    utterance.volume = 0.7;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }

  /** Toggle TTS on/off */
  setTTS(enabled: boolean): void {
    this.ttsEnabled = enabled;
  }

  /** Hide whisper */
  hide(): void {
    if (!this.tooltip) return;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this.tooltip) {
        this.tooltip.style.opacity = '0';
        this.tooltip.style.transform = 'translateY(8px) scale(0.95)';
      }
    }, 150);
    this.currentAgent = null;
  }

  private escape(s: string): string {
    const apos = '\u0027'; // apostrophe
    return s.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&': return '&';
        case '<': return '<';
        case '>': return '>';
        case '"': return '"';
        case apos: return '&apos;';
        default: return c;
      }
    });
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.tooltip) this.tooltip.remove();
  }
}

let whispersInstance: WhispersController | null = null;

export function initWhispers(): WhispersController {
  if (whispersInstance) whispersInstance.dispose();
  whispersInstance = new WhispersController();
  return whispersInstance;
}

export function getWhispers(): WhispersController | null {
  return whispersInstance;
}