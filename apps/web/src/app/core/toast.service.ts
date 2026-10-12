import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
  action?: { label: string; run: () => void };
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;

  show(kind: Toast['kind'], message: string, action?: Toast['action'], timeoutMs?: number): void {
    const id = this.nextId++;
    this.toasts.update((list) => [...list.slice(-4), { id, kind, message, action }]);
    const ms = timeoutMs ?? (kind === 'error' ? 8000 : 3500);
    setTimeout(() => this.dismiss(id), ms);
  }

  success(message: string, action?: Toast['action']): void {
    this.show('success', message, action);
  }

  error(message: string): void {
    this.show('error', message);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
