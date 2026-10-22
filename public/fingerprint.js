// Lightweight browser/device fingerprint. Produces a stable Device ID derived from hardware/
// browser characteristics (canvas rendering, GPU renderer string, screen/CPU info, timezone) that
// survives cookie/localStorage clearing IF the same physical machine+browser+GPU combo is used, and
// is cached in localStorage so it's computed once and reused instantly afterwards. This is a
// heuristic signal for the server's multi-account detection (src/server.js game:join handler) — it
// is NOT cryptographically unique and is only ever used server-side as corroborating evidence
// alongside IP/login-history, never as the sole basis for a ban.
(function (global) {
  const STORAGE_KEY = 'wlb_device_id';

  function hashString(str) {
    // FNV-1a 32-bit, doubled up for a longer hex string — no external crypto libs needed for a
    // best-effort fingerprint hash.
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193);
      h2 ^= c + i; h2 = Math.imul(h2, 0x85ebca6b);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function getCanvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return 'no-canvas';
      canvas.width = 220; canvas.height = 30;
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 100, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('WarLordBlitz-fp', 2, 2);
      ctx.fillStyle = 'rgba(102, 200, 0, 0.7)';
      ctx.fillText('WarLordBlitz-fp', 4, 4);
      return canvas.toDataURL();
    } catch (e) {
      return 'canvas-error';
    }
  }

  function getWebglRenderer() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 'no-webgl';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (!info) return 'no-debug-info';
      return `${gl.getParameter(info.UNMASKED_VENDOR_WEBGL)}~${gl.getParameter(info.UNMASKED_RENDERER_WEBGL)}`;
    } catch (e) {
      return 'webgl-error';
    }
  }

  function collectComponents() {
    const nav = global.navigator || {};
    const scr = global.screen || {};
    let tz = 'unknown-tz';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || String(new Date().getTimezoneOffset()); } catch (e) {}
    return [
      getCanvasFingerprint(),
      getWebglRenderer(),
      nav.userAgent || '',
      nav.language || '',
      (nav.languages || []).join(','),
      nav.platform || '',
      String(nav.hardwareConcurrency || ''),
      String(nav.deviceMemory || ''),
      String(scr.width || ''), String(scr.height || ''), String(scr.colorDepth || ''),
      tz
    ].join('||');
  }

  function generateDeviceId() {
    return hashString(collectComponents());
  }

  function getDeviceId() {
    try {
      let id = localStorage.getItem(STORAGE_KEY);
      if (!id) {
        id = generateDeviceId();
        localStorage.setItem(STORAGE_KEY, id);
      }
      return id;
    } catch (e) {
      // localStorage unavailable (private mode edge cases) — fall back to a fresh, non-persisted id.
      return generateDeviceId();
    }
  }

  global.WLBFingerprint = { getDeviceId };
})(window);
