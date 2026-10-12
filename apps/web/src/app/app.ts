import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme.service';
import { ConfirmDialogComponent } from './shared/confirm-dialog.component';
import { ToastsComponent } from './shared/toasts.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ConfirmDialogComponent, ToastsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet />
    <app-confirm-dialog />
    <app-toasts />
  `,
})
export class App {
  // Instantiated eagerly so the theme is applied before the first route renders.
  protected readonly theme = inject(ThemeService);
}
