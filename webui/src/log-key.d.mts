export function logRecordKey(record: Record<string, unknown>): string;
export function mergeLogRecords<T extends Record<string, unknown>>(current: T[], incoming: T[], limit?: number): T[];
