import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Adds the custom header required by the server's CSRF guard to every same-origin API call.
 * Browsers cannot attach custom headers to cross-site requests without a CORS preflight.
 */
export const csrfInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith('/api/')) {
    return next(req.clone({ setHeaders: { 'X-Requested-With': 'notatnik' } }));
  }
  return next(req);
};
