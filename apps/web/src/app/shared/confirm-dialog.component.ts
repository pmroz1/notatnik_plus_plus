import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ConfirmService } from './confirm.service';

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="dialog-panel w-[min(28rem,calc(100vw-2rem))]"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      (cancel)="$event.preventDefault(); confirm.answer(false)"
    >
      @if (confirm.current(); as req) {
        <form method="dialog" class="flex flex-col gap-4 p-5" (submit)="submit($event)">
          <h2 id="confirm-title" class="text-base font-semibold">{{ req.title }}</h2>
          <p id="confirm-message" class="whitespace-pre-line text-sm text-muted">{{ req.message }}</p>
          @if (req.requireText) {
            <label class="flex flex-col gap-1 text-sm">
              <span>
                Type <code class="rounded bg-hover px-1">{{ req.requireText }}</code> to confirm
              </span>
              <input
                #typed
                class="input"
                autocomplete="off"
                [value]="typedText()"
                (input)="typedText.set(typed.value)"
                data-testid="confirm-text"
              />
            </label>
          }
          <div class="flex justify-end gap-2">
            <button type="button" class="btn" (click)="confirm.answer(false)" data-testid="confirm-cancel">
              {{ req.cancelLabel ?? 'Cancel' }}
            </button>
            <button
              type="submit"
              class="btn"
              [class.btn-danger]="req.danger"
              [class.btn-primary]="!req.danger"
              [disabled]="!canConfirm()"
              data-testid="confirm-ok"
            >
              {{ req.confirmLabel ?? 'Confirm' }}
            </button>
          </div>
        </form>
      }
    </dialog>
  `,
})
export class ConfirmDialogComponent {
  readonly confirm = inject(ConfirmService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly typedText = signal('');
  readonly canConfirm = computed(() => {
    const req = this.confirm.current();
    return !!req && (!req.requireText || this.typedText() === req.requireText);
  });
  private previousFocus: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const open = this.confirm.current() !== null;
      const el = this.dialog().nativeElement;
      if (open && !el.open) {
        this.typedText.set('');
        this.previousFocus = document.activeElement as HTMLElement | null;
        el.showModal();
      } else if (!open && el.open) {
        el.close();
        this.previousFocus?.focus?.();
        this.previousFocus = null;
      }
    });
  }

  submit(event: Event): void {
    event.preventDefault();
    if (this.canConfirm()) {
      this.confirm.answer(true);
    }
  }
}
