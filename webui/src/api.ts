import { createRequestScope } from './request-scope.mjs';

let csrf = '';
const sessionRequests = createRequestScope();
export function setCsrf(value: string | undefined) {
  const next = value || '';
  if (csrf !== next) { sessionRequests.invalidate(); csrf = next; }
}
export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const ticket = sessionRequests.capture();
  const binary = body instanceof File || body instanceof Blob;
  const response = await fetch('/api' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    signal: signal ? AbortSignal.any([ticket.signal, signal]) : ticket.signal,
    headers: { ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }),
      ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }), ...extraHeaders },
    body: body === undefined ? undefined : binary ? body as Blob : JSON.stringify(body),
  });
  ticket.assertCurrent();
  let value: { data?: T; error?: { code?: string; message?: string } };
  try { value = await response.json(); }
  catch {
    ticket.assertCurrent();
    if (response.status === 401) window.dispatchEvent(new Event('freshwater:unauthorized'));
    throw new ApiError('INVALID_RESPONSE', '服务未返回有效 JSON，请检查管理服务与代理配置', response.status);
  }
  ticket.assertCurrent();
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (response.status === 401) window.dispatchEvent(new Event('freshwater:unauthorized'));
    throw new ApiError('INVALID_RESPONSE', '管理服务响应格式无效', response.status);
  }
  if (!response.ok || value.error) {
    if (response.status === 401) window.dispatchEvent(new Event('freshwater:unauthorized'));
    throw new ApiError(value.error?.code || 'REQUEST_FAILED', value.error?.message || '请求失败', response.status);
  }
  if (!value || !Object.hasOwn(value, 'data')) throw new ApiError('INVALID_RESPONSE', '响应缺少 data 字段', response.status);
  return value.data as T;
}
export async function download(path: string, filename: string) {
  const ticket = sessionRequests.capture();
  const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', signal: ticket.signal });
  ticket.assertCurrent();
  if (response.status === 401) window.dispatchEvent(new Event('freshwater:unauthorized'));
  if (!response.ok) throw new Error('下载失败，请检查权限和备份状态');
  const blob = await response.blob(); ticket.assertCurrent();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
