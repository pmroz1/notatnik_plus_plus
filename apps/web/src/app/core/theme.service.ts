import { Injectable, effect, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'notatnik.theme';

/** Appearance preference, stored only in this browser's localStorage. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(readPreference());
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(this.media.matches);

  constructor() {
    this.media.addEventListener('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      const pref = this.preference();
      const dark = pref === 'dark' || (pref === 'system' && this.systemDark());
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      try {
        localStorage.setItem(STORAGE_KEY, pref);
      } catch {
        // Storage may be unavailable (private mode); the preference then lasts for this session.
      }
    });
  }

  cycle(): void {
    const order: ThemePreference[] = ['system', 'light', 'dark'];
    this.preference.set(order[(order.indexOf(this.preference()) + 1) % order.length]);
  }
}

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') {
      return v;
    }
  } catch {
    // ignore unavailable storage
  }
  return 'system';
}
