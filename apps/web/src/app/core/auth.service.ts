import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  readonly username = signal<string | null>(null);
  private checked = false;

  /** Resolves to true if a valid session exists. Cached after the first successful check. */
  async ensureSession(): Promise<boolean> {
    if (this.checked && this.username()) {
      return true;
    }
    try {
      const me = await this.api.me();
      this.username.set(me.username);
      this.checked = true;
      return true;
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        this.username.set(null);
        return false;
      }
      throw err;
    }
  }

  async login(username: string, password: string): Promise<void> {
    const me = await this.api.login(username, password);
    this.username.set(me.username);
    this.checked = true;
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this.markLoggedOut();
  }

  markLoggedOut(): void {
    this.username.set(null);
    this.checked = false;
  }
}
