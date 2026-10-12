import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  try {
    if (await auth.ensureSession()) {
      return true;
    }
  } catch {
    // Server unreachable: fall through to the login page, which shows the error on submit.
  }
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
