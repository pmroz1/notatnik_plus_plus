import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/api-error';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <form
        class="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-line bg-panel p-6 shadow-sm"
        [formGroup]="form"
        (ngSubmit)="submit()"
        aria-labelledby="login-title"
      >
        <div>
          <h1 id="login-title" class="text-xl font-semibold">Notatnik++</h1>
          <p class="text-sm text-muted">Sign in to your private notes.</p>
        </div>
        <label class="flex flex-col gap-1 text-sm">
          Username
          <input
            #username
            class="input"
            formControlName="username"
            autocomplete="username"
            data-testid="login-username"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Password
          <input
            class="input"
            type="password"
            formControlName="password"
            autocomplete="current-password"
            data-testid="login-password"
          />
        </label>
        @if (error(); as e) {
          <p
            class="rounded-md bg-red-500/10 px-3 py-2 text-sm text-danger"
            role="alert"
            data-testid="login-error"
          >
            {{ e }}
          </p>
        }
        <button
          type="submit"
          class="btn btn-primary h-10"
          [disabled]="busy()"
          data-testid="login-submit"
        >
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
        <p class="text-xs text-muted">
          No account yet? Create one on the server with
          <code class="rounded bg-hover px-1">notes-api create-user</code>.
        </p>
      </form>
    </main>
  `,
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly form = new FormGroup({
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  private readonly usernameInput = viewChild.required<ElementRef<HTMLInputElement>>('username');

  constructor() {
    afterNextRender(() => this.usernameInput().nativeElement.focus());
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.busy()) {
      this.error.set('Enter your username and password.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const { username, password } = this.form.getRawValue();
    try {
      await this.auth.login(username, password);
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      // Only allow internal app paths as redirect targets.
      const target =
        returnUrl && /^\/(?!\/)/.test(returnUrl) && !returnUrl.startsWith('/login')
          ? returnUrl
          : '/';
      await this.router.navigateByUrl(target);
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        this.error.set('Invalid username or password.');
      } else {
        this.error.set(errorMessage(err, 'Sign-in failed'));
      }
      this.form.controls.password.reset();
    } finally {
      this.busy.set(false);
    }
  }
}
