const accountFields = ['label', 'expectedUin', 'actionTimeoutMs'];
const nodeFields = [
  'id', 'label', 'type', 'enabled', 'token', 'url', 'role', 'secret', 'quickOperations',
  'heartbeatMs', 'reconnectMinMs', 'reconnectMaxMs', 'timeoutMs', 'pingTimeoutMs',
  'maxPending', 'ratePerSecond', 'burst', 'eventBufferSize', 'eventMaxAgeMs'
];

function pick(source, fields) {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(source, field)).map(field => [field, source[field]]));
}

// GET responses include runtime state and redacted-secret markers, which are not editable.
export function writableAccountConfig(config) {
  return { ...pick(config, accountFields), nodes: config.nodes.map(node => pick(node, nodeFields)) };
}
