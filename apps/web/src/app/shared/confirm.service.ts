import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** If set, the user must type this exact text before confirming. */
  requireText?: string;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

/** Promise-based confirmation dialogs rendered by ConfirmDialogComponent. */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<PendingConfirm | null>(null);

  ask(request: ConfirmRequest): Promise<boolean> {
    // Only one dialog at a time: a new request cancels the previous one.
    this.current()?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.current.set({ ...request, resolve });
    });
  }

  answer(ok: boolean): void {
    const pending = this.current();
    if (pending) {
      this.current.set(null);
      pending.resolve(ok);
    }
  }
}
