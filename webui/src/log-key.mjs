// Backend log IDs are unique within one profile, not across every QQ account.
export function logRecordKey(record) {
  return String(record.profileId ?? record.accountId ?? '') + '/' + String(record.id ?? JSON.stringify(record));
}

export function mergeLogRecords(current, incoming, limit = 1000) {
  const records = new Map();
  for (const record of [...current, ...incoming]) {
    if (record && typeof record === 'object' && !Array.isArray(record)) records.set(logRecordKey(record), record);
  }
  const time = record => {
    const value = record.time ?? record.at;
    const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...records.values()].sort((a, b) => time(a) - time(b) || logRecordKey(a).localeCompare(logRecordKey(b))).slice(-limit);
}
