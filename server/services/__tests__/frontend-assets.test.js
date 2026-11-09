import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { frontendAssetVersion, versionAssetReferences, publicAssetPath } = require('../frontend-assets');
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('frontend asset versioning', () => {
  it('changes the complete module graph URL when a script or stylesheet changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-frontend-'));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, 'js', 'modules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'js', 'app.js'), "import './modules/page.js';");
    fs.writeFileSync(path.join(root, 'js', 'modules', 'page.js'), 'first');
    fs.writeFileSync(path.join(root, 'css', 'style.css'), 'body{}');

    const before = frontendAssetVersion(root);
    expect(frontendAssetVersion(root)).toBe(before);
    fs.writeFileSync(path.join(root, 'js', 'modules', 'page.js'), 'other'); // same length
    const after = frontendAssetVersion(root);
    expect(after).not.toBe(before);
    fs.writeFileSync(path.join(root, 'css', 'style.css'), 'body{color:red}');
    expect(frontendAssetVersion(root)).not.toBe(after);

    const html = versionAssetReferences('<link href="/css/style.css"><script type="module" src="/js/app.js"></script>', after);
    expect(html).toContain(`/assets/${after}/css/style.css`);
    expect(html).toContain(`/assets/${after}/js/app.js`);
    const imported = new URL('./modules/page.js', `https://example.com/assets/${after}/js/app.js`);
    expect(imported.pathname).toBe(`/assets/${after}/js/modules/page.js`);
    expect(publicAssetPath(imported.pathname)).toBe('/js/modules/page.js');
    expect(publicAssetPath(`/assets/${after}/server.js`)).toBe(`/assets/${after}/server.js`);
  });
});
