export class InputError extends Error {
  override name = 'InputError';
}

export class DegradedError extends Error {
  override name = 'DegradedError';
}

// The request is understood and would cost something the caller has not agreed to yet.
// `detail` says what, for the caller to show before asking again with its consent.
export class ConfirmationRequired extends Error {
  override name = 'ConfirmationRequired';
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.detail = detail;
  }
}
