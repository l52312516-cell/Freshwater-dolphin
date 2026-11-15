'use strict';

// Include license texts for installed JavaScript production and WebUI build dependencies.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function collect(base) {
    const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
    const result = [];
    for (const [relative, metadata] of Object.entries(lock.packages || {})) {
        if (!relative || !relative.startsWith('node_modules/') || metadata.optional && !fs.existsSync(path.join(base, relative))) continue;
        const directory = path.join(base, relative);
        if (!fs.existsSync(directory)) continue;
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        const names = fs.readdirSync(directory).filter(name => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.[A-Za-z]+)?$/i.test(name));
        let text = manifest.name + '@' + manifest.version + '\nLicense: ' + (manifest.license || metadata.license || 'See package') + '\n';
        for (const name of names) if (fs.statSync(path.join(directory, name)).isFile()) text += '\n' + name + '\n' + fs.readFileSync(path.join(directory, name), 'utf8').replace(/\r\n?/g, '\n') + '\n';
        if (manifest.name === '@novnc/novnc') {
            const vendorLicense = path.join(directory, 'vendor/pako/LICENSE');
            text += '\nvendor/pako/LICENSE\n' + fs.readFileSync(vendorLicense, 'utf8').replace(/\r\n?/g, '\n') + '\n';
        }
        result.push(text);
    }
    return result;
}
const texts = [...collect(root), ...collect(path.join(root, 'webui'))];
const unique = [...new Set(texts)].sort();
fs.writeFileSync(path.join(root, 'docs/third-party-licenses.txt'), unique.join('\n' + '='.repeat(72) + '\n\n') + '\n', 'utf8');
console.log(JSON.stringify({ packages: unique.length }));
