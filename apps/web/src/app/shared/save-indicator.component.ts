import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { SaveStatus } from '../autosave/page-save-controller';

const LABELS: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved',
  error: 'Save failed',
  conflict: 'Conflict',
};

@Component({
  selector: 'app-save-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      [class]="tone()"
      role="status"
      aria-live="polite"
      data-testid="save-status"
      [attr.data-status]="status()"
      [title]="detail() ?? label()"
    >
      <span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true"></span>
      {{ label() }}
    </span>
    @if (status() === 'error') {
      <button
        type="button"
        class="ml-1 text-xs font-medium text-accent underline"
        (click)="retry.emit()"
      >
        Retry now
      </button>
    }
  `,
  host: { class: 'inline-flex items-center' },
})
export class SaveIndicatorComponent {
  readonly status = input.required<SaveStatus>();
  readonly detail = input<string | null>(null);
  readonly retry = output<void>();
  readonly label = computed(() => LABELS[this.status()]);
  readonly tone = computed(() => {
    switch (this.status()) {
      case 'saved':
        return 'text-muted';
      case 'saving':
      case 'unsaved':
        return 'text-amber-600 dark:text-amber-400';
      case 'error':
      case 'conflict':
        return 'bg-red-500/10 text-danger';
    }
  });
}
