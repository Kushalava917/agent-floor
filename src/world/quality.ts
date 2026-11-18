/**
 * ?rec turns on recording quality: denser geometry, bigger shadow maps, more
 * anti-aliasing and sharper canvas textures. Used by scripts/record.cjs, where
 * frames are rendered offline and frame time does not matter.
 */
export const REC = typeof location !== 'undefined' && new URLSearchParams(location.search).has('rec');

/** Geometry tessellation multiplier. */
export const DETAIL = REC ? 2 : 1;

/** ?quality=low|high overrides the detected tier (handy for bug reports). */
const requested = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('quality') : null;

/**
 * Render tier, filled in from the live WebGL context once the renderer exists.
 * Integrated graphics get cheaper shadows, no bloom pass and a smaller pixel
 * budget; discrete GPUs keep the full treatment. Nothing here changes the scene
 * contents, only how it is drawn.
 */
export const gfx = {
  lite: REC ? false : requested === 'low',
  name: '',
  detected: REC || requested === 'low',
};

/** Read the GPU name and pick a tier. Runs once, right after the renderer is created. */
export function detectGpuTier(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  if (gfx.detected) return gfx;
  gfx.detected = true;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gfx.name = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || '');
  } catch {
    /* browsers may hide it; keep the default tier */
  }
  if (requested === 'high') return gfx;
  // Integrated and software renderers: UHD/HD/Iris, Apple/Mali/Adreno mobile
  // chips, and SwiftShader (headless). They all choke on bloom + 4K shadow maps.
  gfx.lite = /swiftshader|software|llvmpipe|basic render|uhd graphics|hd graphics|iris|mali-|adreno|powervr|apple gpu/i.test(gfx.name);
  return gfx;
}
