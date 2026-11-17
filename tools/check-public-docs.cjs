'use strict';

const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
function markdownFiles(directory) {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(item => {
        const relative = path.posix.join(directory, item.name);
        return item.isDirectory() ? markdownFiles(relative) : item.isFile() && item.name.endsWith('.md') ? [relative] : [];
    });
}
const documents = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'THIRD_PARTY_NOTICES.md',
    'webui/README.md', ...markdownFiles('docs')];
const broken = [];
for (const relative of documents) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) { broken.push(relative + ': missing document'); continue; }
    const markdown = fs.readFileSync(file, 'utf8');
    for (const match of markdown.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1].replace(/^<|>$/g, '');
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
        const local = decodeURIComponent(target.split('#')[0].split('?')[0]);
        if (!local) continue;
        const full = path.resolve(path.dirname(file), local), fromRoot = path.relative(root, full);
        if (/^(?:work|outputs)[/\\]/.test(fromRoot)) { broken.push(relative + ': private artifact link ' + target); continue; }
        if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot) || !fs.existsSync(full)) broken.push(relative + ': ' + target);
    }
}
if (broken.length) { console.error(broken.join('\n')); process.exitCode = 1; }
else console.log('Public documentation links checked (' + documents.length + ' files).');
