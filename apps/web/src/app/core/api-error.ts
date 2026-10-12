import { HttpErrorResponse } from '@angular/common/http';
import { ApiErrorBody } from './api.types';

/** Returns a user-facing message for any error thrown by an API call. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return 'Cannot reach the server. Check your connection.';
    }
    const body = err.error as Partial<ApiErrorBody> | null;
    if (body && typeof body === 'object' && body.error?.message) {
      return body.error.message;
    }
    return `${fallback} (HTTP ${err.status})`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return fallback;
}

export function errorCode(err: unknown): string | null {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as Partial<ApiErrorBody> | null;
    return body?.error?.code ?? null;
  }
  return null;
}
