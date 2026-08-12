const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'app/src/main/assets/index.html');
const jsPath = path.join(root, 'app/src/main/assets/scanner.js');
const manifestPath = path.join(root, 'app/src/main/AndroidManifest.xml');
const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');
const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
const refs = new Set([...js.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
const missing = [...refs].filter(id => !ids.has(id)).sort();
if (missing.length) {
  console.error('JavaScript references missing HTML ids:', missing.join(', '));
  process.exit(1);
}

const requiredScreens = ['homeScreen','cameraScreen','editScreen','reviewScreen','exportScreen'];
for (const id of requiredScreens) {
  if (!ids.has(id)) throw new Error(`Required screen missing: ${id}`);
}

const buttonIds = [...html.matchAll(/<button\b[^>]*\bid=["']([^"']+)["'][^>]*>/g)].map(m => m[1]);
const unbound = buttonIds.filter(id => !new RegExp(`\\$\\(['"]${id}['"]\\)\\.addEventListener`).test(js));
if (unbound.length) throw new Error(`Visible buttons without a JavaScript handler: ${unbound.join(', ')}`);

const forbidden = ['will be added after', 'TODO:', 'FIXME:', 'placeholder behavior'];
for (const term of forbidden) {
  if (js.toLowerCase().includes(term.toLowerCase())) throw new Error(`Unfinished marker found in scanner.js: ${term}`);
}

if (/android\.permission\.INTERNET/.test(manifest)) throw new Error('Production scanner must not request INTERNET permission.');
if (/<script[^>]+src=["']https?:\/\//i.test(html)) throw new Error('Runtime scripts must be bundled locally for offline operation.');
if (!/<script async src=["']opencv\.js["']><\/script>/.test(html)) throw new Error('Bundled OpenCV.js script is missing from index.html.');

console.log(`UI audit passed: ${ids.size} HTML ids, ${refs.size} JavaScript element references, ${buttonIds.length} bound buttons, offline manifest verified.`);
