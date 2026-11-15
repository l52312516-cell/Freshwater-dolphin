'use strict';

// 样式体检：死选择器、过小字号、硬编码色值、重复声明与产物体积。
// 用法：node scripts/style-audit.cjs [--json]
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const stylesDir = path.join(src, 'styles');
const TOKENS = 'tokens.css';
const MIN_FONT = 11;
// 运行时动态拼接的类名（状态值来自 labels.ts，日志级别来自 LogConsole 脚本）
const DYNAMIC_CLASSES = new Set(['trace', 'debug', 'info', 'success', 'warn', 'error']);
// 子组件根节点上的类名（Vue scoped 样式可以命中子组件根元素）
const CHILD_ROOT_CLASSES = new Set(['account-avatar', 'icon']);

function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function cssFiles() {
  return fs.readdirSync(stylesDir).filter(name => name.endsWith('.css')).map(name => path.join(stylesDir, name));
}
function filesWith(extension) {
  const list = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(extension)) list.push(full);
    }
  };
  visit(src);
  return list;
}
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}
function stripMedia(text) {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('@media', index);
    if (start === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, start);
    let depth = 0;
    let position = text.indexOf('{', start);
    while (position < text.length) {
      if (text[position] === '{') depth++;
      else if (text[position] === '}') {
        depth--;
        if (depth === 0) { position++; break; }
      }
      position++;
    }
    index = position;
  }
  return output;
}
function classTokens(text) {
  const found = new Set();
  for (const match of stripComments(text).matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) found.add(match[1]);
  return found;
}
function templateOf(file) {
  return read(file).replace(/<style[\s\S]*?<\/style>/g, '');
}
function styleBlockOf(file) {
  return [...read(file).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
}
function used(text, name) {
  return new RegExp('(?<![A-Za-z0-9_-])' + name.replace(/[-]/g, '\\-') + '(?![A-Za-z0-9_-])').test(text);
}

const report = { deadSelectors: [], smallFonts: [], hardcodedColors: [], duplicateSelectors: [], sizes: {} };
const vueFiles = filesWith('.vue');
const templates = new Map(vueFiles.map(file => [file, templateOf(file)]));
const tsSources = filesWith('.ts').map(read).join('\n');
const allMarkup = [...templates.values()].join('\n') + '\n' + tsSources;

// 1) 全局样式的死选择器
for (const file of cssFiles()) {
  if (path.basename(file) === TOKENS) continue;
  for (const name of classTokens(read(file))) {
    if (DYNAMIC_CLASSES.has(name) || CHILD_ROOT_CLASSES.has(name)) continue;
    if (!used(allMarkup, name)) report.deadSelectors.push({ file: path.relative(root, file), className: name });
  }
}

// 2) 组件 scoped 样式的死选择器（模板内查找，允许动态与子组件根类名）
for (const [file, markup] of templates) {
  for (const name of classTokens(styleBlockOf(file))) {
    if (DYNAMIC_CLASSES.has(name) || CHILD_ROOT_CLASSES.has(name)) continue;
    if (!used(markup + '\n' + tsSources, name)) report.deadSelectors.push({ file: path.relative(root, file), className: name });
  }
}

// 3) 过小字号 + 4) 硬编码色值
for (const file of [...cssFiles(), ...vueFiles]) {
  const text = file.endsWith('.vue') ? styleBlockOf(file) : read(file);
  const clean = stripComments(text);
  for (const match of clean.matchAll(/font-size:\s*([\d.]+)px/g)) {
    if (parseFloat(match[1]) < MIN_FONT) report.smallFonts.push({ file: path.relative(root, file), value: match[1] + 'px' });
  }
  if (path.basename(file) === TOKENS) continue;
  for (const match of clean.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    report.hardcodedColors.push({ file: path.relative(root, file), value: match[0] });
  }
}

// 5) 同一层级内重复声明（媒体查询内的响应式覆盖不算）
for (const file of cssFiles()) {
  const counts = new Map();
  const clean = stripMedia(stripComments(read(file)));
  for (const match of clean.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of match[1].split(',').map(value => value.trim())) {
      if (!/^[.#]/.test(selector)) continue;
      counts.set(selector, (counts.get(selector) || 0) + 1);
    }
  }
  for (const [selector, count] of counts) {
    if (count > 2) report.duplicateSelectors.push({ file: path.relative(root, file), selector, count });
  }
}

// 6) 产物体积
const dist = path.join(root, 'dist', 'assets');
if (fs.existsSync(dist)) {
  for (const name of fs.readdirSync(dist)) {
    if (!/\.(css|js)$/.test(name)) continue;
    const bytes = fs.statSync(path.join(dist, name)).size;
    const key = name.replace(/-[A-Za-z0-9_-]+\./, '.');
    report.sizes[key] = Math.round(bytes / 1024 * 10) / 10;
  }
}

const violations = report.deadSelectors.length + report.smallFonts.length + report.hardcodedColors.length;
const output = path.join(root, '..', 'outputs', 'webui-style-audit.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ ...report, violations }, null, 2) + '\n');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ violations, report }, null, 2));
} else {
  console.log('dead selectors: ' + report.deadSelectors.length + (report.deadSelectors.length ? ' -> ' + report.deadSelectors.map(item => item.file + ':' + item.className).join(', ') : ''));
  console.log('font-size < ' + MIN_FONT + 'px: ' + report.smallFonts.length + (report.smallFonts.length ? ' -> ' + report.smallFonts.map(item => item.file + ':' + item.value).join(', ') : ''));
  console.log('hardcoded colors outside tokens: ' + report.hardcodedColors.length + (report.hardcodedColors.length ? ' -> ' + [...new Set(report.hardcodedColors.map(item => item.file + ':' + item.value))].join(', ') : ''));
  console.log('duplicate selectors (>2, excluding media queries): ' + report.duplicateSelectors.length + (report.duplicateSelectors.length ? ' -> ' + report.duplicateSelectors.map(item => item.selector + ' x' + item.count).join(', ') : ''));
  console.log('bundle sizes (KB): ' + JSON.stringify(report.sizes));
}
if (violations > 0) process.exitCode = 1;
