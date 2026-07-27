/**
 * Eagleye — On-demand loader for the vendored global libraries
 *
 * three, 3d-force-graph, katex and pdf-lib are classic scripts that assign a
 * global rather than ES modules, so they cannot simply be imported. Loading
 * them from <head> meant every route paid for them: 2.72MB uncompressed that
 * only /kg3d and two tool pages ever use.
 *
 * loadLib() injects the script the first time something asks for it and
 * memoises the promise, so concurrent callers share one network request and a
 * second visit to the page resolves immediately.
 *
 * Consumers already guard for a missing global (kg3d.js, tools/text.js,
 * tools/files.js), so a failed load degrades to their existing error message
 * rather than throwing.
 */

const _pending = new Map();

/**
 * @param {string} src         URL of the script to inject
 * @param {string} globalName  the global it is expected to define
 * @returns {Promise<any>} resolves with the global once available
 */
export function loadLib(src, globalName) {
  const existing = /** @type {any} */ (window)[globalName];
  if (existing) return Promise.resolve(existing);

  const cached = _pending.get(src);
  if (cached) return cached;

  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false; // preserve execution order for callers loading a chain
    el.onload = () => {
      const g = /** @type {any} */ (window)[globalName];
      if (g) resolve(g);
      else reject(new Error(`${src} loaded but did not define ${globalName}`));
    };
    el.onerror = () => {
      // Drop the rejected promise so a later attempt can retry rather than
      // replaying the failure forever.
      _pending.delete(src);
      reject(new Error(`failed to load ${src}`));
    };
    document.head.appendChild(el);
  });

  _pending.set(src, p);
  return p;
}

export const LIBS = {
  three: () => loadLib('/js/lib/three.min.js', 'THREE'),
  // 3d-force-graph reads window.THREE at evaluation time, so three must land first.
  forceGraph3D: async () => {
    await LIBS.three();
    return loadLib('/js/lib/3d-force-graph.min.js', 'ForceGraph3D');
  },
  katex: () => loadLib('/js/lib/katex.min.js', 'katex'),
  pdfLib: () => loadLib('/js/lib/pdf-lib.min.js', 'PDFLib'),
};

// The tool pages run their behaviour from inline <script> strings, which have
// no module scope to import into. They call this instead.
/** @type {any} */ (window).__loadLib = loadLib;
/** @type {any} */ (window).__LIBS = LIBS;
