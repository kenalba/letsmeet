/**
 * An error whose message is written for the person who caused it and safe to show them:
 * "this poll is full", "invalid edit link", "too many intervals". Anything else that
 * escapes a handler — a PDS 503, a DNS failure, a bug — is logged server-side and
 * answered with a generic line, so internals (upstream URLs, stack-ish detail) never
 * reach a client. Routes decide by `instanceof`; keep this the only way to opt a message
 * in to being displayed.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** The one line a client sees for anything that is not a UserError. */
export const GENERIC_ERROR = 'something broke on our end, not yours. give it another go.';

export function userMessage(err: unknown): string {
  return err instanceof UserError ? err.message : GENERIC_ERROR;
}
