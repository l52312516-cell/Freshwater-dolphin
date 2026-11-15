'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { capabilities } = require('../src/onebot/capabilities.cjs');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs');
fs.mkdirSync(output, { recursive: true });
// Export a static inventory, never a fabricated logged-in account state.
const inventory = { version, context: 'offline-source-inventory', generated_at: new Date().toISOString(),
    ...capabilities({ qqVersion: '3.2.35-54395', ready: false, capabilities: {} }) };
fs.writeFileSync(path.join(output, 'capability-matrix.json'), JSON.stringify(inventory, null, 2) + '\n');
const lines = ['# Freshwater-dolphin 能力矩阵', '', `版本：${version}`, '',
    '此文件由源码清单生成，不含账号信息，不代表 QQ 已登录或已通过新增能力真机测试。实际 available 状态请调用当前账户 get_capabilities。', '',
    '## 标准动作', '', '| 动作 | 已实现 | 证据等级 |', '| --- | --- | --- |'];
for (const entry of inventory.actions) lines.push(`| ${entry.name} | ${entry.implemented ? '是' : '否'} | ${entry.verification} |`);
lines.push('', '## 扩展动作', '', '| 动作 | 已实现 | 证据等级 |', '| --- | --- | --- |');
for (const entry of inventory.extensions) lines.push(`| ${entry.name} | ${entry.implemented ? '是' : '否'} | ${entry.verification} |`);
lines.push('', '## 标准消息段', '', '| 消息段 | 已实现 | 证据等级 |', '| --- | --- | --- |');
for (const entry of inventory.segments) lines.push(`| ${entry.name} | ${entry.implemented ? '是' : '否'} | ${entry.verification} |`);
lines.push('', '## 扩展消息段', '', '| 消息段 | 已实现 | 收发边界 |', '| --- | --- | --- |');
for (const entry of inventory.segment_extensions || []) lines.push(`| ${entry.name} | ${entry.implemented ? '是' : '否'} | 本地文件独占发送；已确认消息可查询元数据，自动接收和下载尚未实现 |`);
lines.push('', '## 事件类别', '', '| 类别 | 已实现 | 子类 |', '| --- | --- | --- |');
for (const entry of inventory.events) lines.push(`| ${entry.name} | ${entry.implemented ? '是' : '否'} | ${entry.subtypes.join(', ')} |`);
lines.push('', '未实现能力及阻断原因见 docs/capability-limits.md。', '');
fs.writeFileSync(path.join(output, 'capability-matrix.md'), lines.join('\n'));
process.stdout.write(JSON.stringify({ version, standard_actions: inventory.actions.length,
    implemented_standard_actions: inventory.actions.filter(item => item.implemented).length,
    extensions: inventory.extensions.length, segments: inventory.segments.length, event_categories: inventory.events.length }) + '\n');
