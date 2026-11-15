/** A response belongs to the account/session generation that requested it. */
export class StaleRequestError extends Error {
  constructor() { super('请求所属的账号或登录会话已切换'); this.name = 'StaleRequestError'; }
}

export function isStaleRequest(value) {
  return value?.name === 'StaleRequestError' || value?.name === 'AbortError';
}

export function createRequestScope() {
  let generation = 0;
  let controller = new AbortController();
  return {
    capture() {
      const revision = generation;
      const signal = controller.signal;
      const isCurrent = () => generation === revision && !signal.aborted;
      return { signal, isCurrent, assertCurrent() { if (!isCurrent()) throw new StaleRequestError(); } };
    },
    invalidate() {
      generation++;
      controller.abort();
      controller = new AbortController();
    },
  };
}
