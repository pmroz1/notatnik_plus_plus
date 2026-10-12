import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/api-error';
import { ThemePreference, ThemeService } from '../core/theme.service';
import { ToastService } from '../core/toast.service';
import { SaveCoordinator } from '../autosave/save-coordinator.service';
import { PagesStore } from '../pages/pages.store';
import { ConfirmService } from '../shared/confirm.service';

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto flex max-w-[760px] flex-col gap-10 px-6 py-12">
      <h1 class="text-3xl font-bold">Settings</h1>

      <section aria-labelledby="appearance-h" class="flex flex-col gap-3">
        <h2 id="appearance-h" class="text-lg font-semibold">Appearance</h2>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Theme">
          @for (opt of themeOptions; track opt.value) {
            <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 has-[:checked]:border-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent">
              <input
                type="radio"
                name="theme"
                class="accent-[var(--color-accent)]"
                [value]="opt.value"
                [checked]="theme.preference() === opt.value"
                (change)="theme.preference.set(opt.value)"
              />
              {{ opt.label }}
            </label>
          }
        </div>
        <p class="text-sm text-muted">Stored only in this browser.</p>
      </section>

      <section aria-labelledby="export-h" class="flex flex-col gap-3">
        <h2 id="export-h" class="text-lg font-semibold">Export</h2>
        <p class="text-sm text-muted">
          Download every page (including the trash) with hierarchy, metadata, tags and the full editor
          JSON. This is the lossless backup format and can be imported again below.
        </p>
        <div>
          <a class="btn" href="/api/export" download data-testid="export-link">Download workspace JSON</a>
        </div>
      </section>

      <section aria-labelledby="import-h" class="flex flex-col gap-3">
        <h2 id="import-h" class="text-lg font-semibold">Import</h2>
        <p class="text-sm text-muted">
          <strong>Merge</strong> adds the imported pages as new copies (fresh IDs, nothing is
          overwritten). <strong>Replace</strong> deletes all current pages first; the server writes a
          safety backup of the database before replacing.
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-sm">
            Mode
            <select #mode class="input w-auto" data-testid="import-mode">
              <option value="merge">Merge (keep existing pages)</option>
              <option value="replace">Replace everything</option>
            </select>
          </label>
          <label class="btn cursor-pointer" [class.opacity-50]="busy()">
            Choose file…
            <input
              #file
              type="file"
              accept="application/json,.json"
              class="sr-only"
              [disabled]="busy()"
              (change)="importFile(file, mode.value === 'replace' ? 'replace' : 'merge')"
              data-testid="import-file"
            />
          </label>
        </div>
      </section>

      <section aria-labelledby="backup-h" class="flex flex-col gap-3">
        <h2 id="backup-h" class="text-lg font-semibold">Database backup</h2>
        <p class="text-sm text-muted">
          Creates a consistent SQLite snapshot (<code>VACUUM INTO</code>) in the server's backup
          directory. See docs/backup-restore.md for restoring.
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="btn" [disabled]="busy()" (click)="backup()" data-testid="backup-button">Create backup now</button>
          @if (lastBackup(); as b) {
            <span class="text-sm text-muted break-all">Saved to {{ b }}</span>
          }
        </div>
      </section>

      <section aria-labelledby="account-h" class="flex flex-col gap-3">
        <h2 id="account-h" class="text-lg font-semibold">Account</h2>
        <p class="text-sm text-muted">Signed in as {{ auth.username() }}.</p>
        <div>
          <button type="button" class="btn" (click)="logout()" data-testid="logout">Sign out</button>
        </div>
      </section>
    </div>
  `,
})
export class SettingsComponent {
  readonly theme = inject(ThemeService);
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly saves = inject(SaveCoordinator);
  private readonly store = inject(PagesStore);
  private readonly router = inject(Router);

  readonly busy = signal(false);
  readonly lastBackup = signal<string | null>(null);
  readonly themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  async importFile(input: HTMLInputElement, mode: 'merge' | 'replace'): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      this.toasts.error('The file is larger than the 64 MiB import limit.');
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      this.toasts.error('This file is not valid JSON.');
      return;
    }
    const ok = await this.confirm.ask(
      mode === 'replace'
        ? {
            title: 'Replace all pages?',
            message: `All current pages will be deleted and replaced with the contents of “${file.name}”. A safety backup of the database is written first.`,
            confirmLabel: 'Replace everything',
            danger: true,
            requireText: 'replace',
          }
        : {
            title: 'Import pages?',
            message: `Pages from “${file.name}” will be added next to your existing pages.`,
            confirmLabel: 'Import',
          },
    );
    if (!ok) {
      return;
    }
    this.busy.set(true);
    try {
      if (mode === 'replace' && !(await this.saves.flushAll())) {
        this.toasts.error('Some pages have unsaved changes. Resolve them before replacing everything.');
        return;
      }
      const res = await this.api.importWorkspace(data, mode);
      await this.store.refresh();
      this.toasts.success(
        `Imported ${res.importedPages} page${res.importedPages === 1 ? '' : 's'}` +
          (res.safetyBackup ? `. Safety backup: ${res.safetyBackup}` : ''),
      );
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Import failed'));
    } finally {
      this.busy.set(false);
    }
  }

  async backup(): Promise<void> {
    this.busy.set(true);
    try {
      const res = await this.api.createBackup();
      this.lastBackup.set(res.file);
      this.toasts.success('Backup created');
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Backup failed'));
    } finally {
      this.busy.set(false);
    }
  }

  async logout(): Promise<void> {
    const allSaved = await this.saves.flushAll();
    if (!allSaved) {
      const ok = await this.confirm.ask({
        title: 'Sign out with unsaved changes?',
        message:
          'Some changes could not be saved. They stay as recovery drafts in this browser and will be offered when you open the page again.',
        confirmLabel: 'Sign out anyway',
        danger: true,
      });
      if (!ok) {
        return;
      }
      this.saves.persistAllDrafts();
    }
    try {
      await this.auth.logout();
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Sign-out failed'));
      return;
    }
    await this.router.navigate(['/login']);
  }
}
