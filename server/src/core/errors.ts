export type ErrorCode =
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSY'
  | 'UNAUTHORIZED'
  | 'DISABLED'
  | 'NOT_READY'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_INPUT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSY: 423,
  DISABLED: 501,
  NOT_READY: 425,
  INTERNAL: 500,
};

export class AppError extends Error {
  code: ErrorCode;
  detail?: unknown;
  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
  get status(): number {
    return STATUS[this.code] ?? 500;
  }
}

export const bad = (m: string, d?: unknown) => new AppError('BAD_INPUT', m, d);
export const notFound = (m: string) => new AppError('NOT_FOUND', m);
export const conflict = (m: string, d?: unknown) => new AppError('CONFLICT', m, d);
export const busy = (m: string) => new AppError('BUSY', m);
export const notReady = (m: string) => new AppError('NOT_READY', m);

export function toHttpBody(err: unknown): { status: number; body: unknown } {
  if (err instanceof AppError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, detail: err.detail } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL' as ErrorCode, message } } };
}
