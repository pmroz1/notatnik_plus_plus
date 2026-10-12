import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      @for (t of toasts.toasts(); track t.id) {
        <div
          class="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm shadow-lg"
          [class.border-red-500]="t.kind === 'error'"
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
          data-testid="toast"
        >
          <span class="min-w-0 flex-1 break-words">{{ t.message }}</span>
          @if (t.action; as action) {
            <button
              type="button"
              class="font-medium text-accent hover:underline"
              (click)="action.run(); toasts.dismiss(t.id)"
            >
              {{ action.label }}
            </button>
          }
          <button
            type="button"
            class="text-muted hover:text-ink"
            aria-label="Dismiss notification"
            (click)="toasts.dismiss(t.id)"
          >
            ✕
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastsComponent {
  readonly toasts = inject(ToastService);
}
