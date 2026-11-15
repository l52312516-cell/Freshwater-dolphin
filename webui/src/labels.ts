import type { Account } from './types';

/** 账号/会话状态的中文文案。与后端 state 字段一一对应，未知值原样透出。 */
const STATE_LABELS: Record<string, string> = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  stopping: '停止中',
  error: '运行错误',
  blocked: '受阻',
  backoff: '等待重试',
  maintenance: '维护中',
  online: '在线',
  offline: '离线',
  online_unknown: '在线状态未知',
  bridge_unavailable: '接入桥状态未知',
  account_mismatch: '账号身份不符',
  duplicate_account: '账号重复登录',
  retry_exhausted: '重试次数已耗尽',
  qq_only: '仅运行 QQ',
  bridge_apply_failed: '注入桥应用失败',
  delete_failed: '删除未完成',
  start_failed: '启动失败',
  apply_failed: '配置应用失败',
  maintenance_failed: '维护失败',
  maintenance_interrupted: '维护中断',
  stop_unconfirmed: '停止结果未确认',
};

export function stateLabel(value?: string): string {
  if (!value) return '未知';
  return STATE_LABELS[value] || value;
}

/** 三种健康值：已确认 / 未连接 / 未知——未知绝不冒充成功。 */
export function healthValue(item: Account, name: string): string {
  const value = item.health?.[name];
  return value === true ? '已确认' : value === false ? '未连接' : '未知';
}

export function canRecoverMaintenance(item: Account): boolean {
  return (
    item.maintenance?.operation === 'delete' ||
    item.maintenance?.phase === 'failed' ||
    ['maintenance_failed', 'maintenance_interrupted', 'stop_unconfirmed', 'start_failed'].includes(item.state)
  );
}
