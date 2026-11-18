/**
 * Easter eggs — konami code, coffee machine clicks, party mode.
 * Purely delightful, no gameplay impact.
 */

import { eventBus } from '../../core/event-bus';

const KONAMI_CODE = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyA',
];

export class EasterEggsController {
  private konamiIndex = 0;
  private coffeeClicks = 0;
  private coffeeTimer: number | null = null;
  private partyMode = false;
  private partyTimer: number | null = null;

  constructor() {
    this.bindKeys();
    this.bindEvents();
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      // Konami code
      if (e.code === KONAMI_CODE[this.konamiIndex]) {
        this.konamiIndex++;
        if (this.konamiIndex >= KONAMI_CODE.length) {
          this.triggerPartyMode();
          this.konamiIndex = 0;
        }
      } else {
        this.konamiIndex = 0;
      }
    });

    // Coffee machine click detection (via custom event from Building)
    window.addEventListener('coffee:click', () => this.onCoffeeClick());
  }

  private bindEvents(): void {
    eventBus.on('easter:party', ({ enabled }) => {
      if (enabled !== this.partyMode) this.setPartyMode(enabled);
    });
  }

  private onCoffeeClick(): void {
    this.coffeeClicks++;
    if (this.coffeeTimer) clearTimeout(this.coffeeTimer);
    this.coffeeTimer = window.setTimeout(() => { this.coffeeClicks = 0; }, 2000);

    if (this.coffeeClicks >= 10) {
      this.coffeeClicks = 0;
      this.unlockAchievement('barista');
    }
  }

  private triggerPartyMode(): void {
    this.setPartyMode(true);
    // Auto-disable after 30 seconds
    this.partyTimer = window.setTimeout(() => this.setPartyMode(false), 30000);
    this.showToast('🎉 PARTY MODE ACTIVATED! (Konami code)');
  }

  private setPartyMode(on: boolean): void {
    this.partyMode = on;
    if (on) {
      document.body.classList.add('party-mode');
      // Flash colors
      let hue = 0;
      const flash = () => {
        if (!this.partyMode) return;
        hue = (hue + 15) % 360;
        document.documentElement.style.setProperty('--accent', `hsl(${hue}, 85%, 55%)`);
        requestAnimationFrame(flash);
      };
      flash();
    } else {
      document.body.classList.remove('party-mode');
      document.documentElement.style.setProperty('--accent', '#ff5f2e');
      if (this.partyTimer) clearTimeout(this.partyTimer);
    }
    eventBus.emit('easter:party', { enabled: on });
  }

  private unlockAchievement(id: string): void {
    const achievements: Record<string, string> = {
      barista: '☕ Barista — Clicked the coffee machine 10 times in 2 seconds',
      konami: '🕹️ Konami Master — Entered the secret code',
      nightowl: '🦉 Night Owl — Active past midnight',
      earlybird: '🐦 Early Bird — Active before 6 AM',
    };
    const msg = achievements[id] ?? `Achievement unlocked: ${id}`;
    this.showToast(msg);
    console.log(`%c🏆 ${msg}`, 'font-size: 14px; color: #ff5f2e;');
  }

  private showToast(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'easter-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(100px);
      background: var(--glass-strong); backdrop-filter: blur(12px);
      border: 1px solid var(--glass-edge); border-radius: 12px;
      padding: 12px 20px; color: var(--text); font-weight: 500;
      z-index: 1000; box-shadow: var(--shadow);
      transition: transform 400ms cubic-bezier(0.34, 1.32, 0.64, 1), opacity 300ms;
    `;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.transform = 'translateX(-50%) translateY(0)'; });
    setTimeout(() => {
      toast.style.transform = 'translateX(-50%) translateY(100px)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }, 3000);
  }

  dispose(): void {
    if (this.partyTimer) clearTimeout(this.partyTimer);
    if (this.coffeeTimer) clearTimeout(this.coffeeTimer);
    this.setPartyMode(false);
  }
}

export const easterEggs = new EasterEggsController();