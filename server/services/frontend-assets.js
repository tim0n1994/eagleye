const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// A single version covers the whole module graph. Relative ES module imports
// keep the version in their URL, so a CDN cannot mix modules from two releases.
function frontendAssetVersion(root) {
  const hash = crypto.createHash('sha256');
  function visit(relativeDir) {
    const entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === '__tests__') continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile()) {
        hash.update(relativePath).update('\0');
        hash.update(fs.readFileSync(path.join(root, relativePath))).update('\0');
      }
    }
  }
  visit('css');
  visit('js');
  return hash.digest('hex').slice(0, 16);
}

function versionAssetReferences(html, version) {
  return html.replace(/(\b(?:src|href)=["'])\/(js|css)\//g,
    (_match, attribute, directory) => `${attribute}/assets/${version}/${directory}/`);
}

function publicAssetPath(requestPath) {
  // Only aliases for already-public assets are accepted. Keep older version
  // URLs working for tabs that were open during a deployment.
  return requestPath.replace(/^\/assets\/[a-f0-9]{16}\/(?=(?:js|css)\/)/, '/');
}

module.exports = { frontendAssetVersion, versionAssetReferences, publicAssetPath };
