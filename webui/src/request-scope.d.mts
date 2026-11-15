export interface RequestTicket {
  signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
}
export class StaleRequestError extends Error {}
export function isStaleRequest(value: unknown): boolean;
export function createRequestScope(): { capture(): RequestTicket; invalidate(): void };
