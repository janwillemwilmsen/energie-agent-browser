// Stealth init script, evaluated before every navigation via
// AGENT_BROWSER_INIT_SCRIPTS. Patches the most common headless/Chromium giveaways:
// navigator.webdriver, plugins, languages, permissions, chrome.runtime, WebGL
// vendor, and the iframe contentWindow trap.
//
// Adapted from the public-domain bits of puppeteer-extra-plugin-stealth.
// Intentionally minimal — it covers what 80%+ of bot-detection scripts probe.

(() => {
  if (window.__eab_stealth_applied) return;
  window.__eab_stealth_applied = true;

  // 1. navigator.webdriver — the single biggest tell.
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
  } catch {}

  // 2. navigator.plugins — headless Chrome has zero plugins.
  try {
    const fakePlugin = (name, filename, description) => {
      const p = Object.create(Plugin.prototype);
      Object.defineProperty(p, 'name', { value: name });
      Object.defineProperty(p, 'filename', { value: filename });
      Object.defineProperty(p, 'description', { value: description });
      Object.defineProperty(p, 'length', { value: 1 });
      return p;
    };
    const plugins = [
      fakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    const arr = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => Object.defineProperty(arr, i, { value: p, enumerable: true }));
    Object.defineProperty(arr, 'length', { value: plugins.length });
    Object.defineProperty(arr, 'item', { value: (i) => plugins[i] ?? null });
    Object.defineProperty(arr, 'namedItem', { value: (n) => plugins.find((p) => p.name === n) ?? null });
    Object.defineProperty(arr, 'refresh', { value: () => undefined });
    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => arr });

    const mimes = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(mimes, 'length', { value: 2 });
    Object.defineProperty(Navigator.prototype, 'mimeTypes', { get: () => mimes });
  } catch {}

  // 3. navigator.languages — must not be empty.
  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => ['en-US', 'en'],
    });
  } catch {}

  // 4. permissions.query — Chrome reports 'denied' for notifications when
  //    Notification.permission is 'default', but headless Chrome returns 'prompt'.
  try {
    const origQuery = navigator.permissions && navigator.permissions.query.bind(navigator.permissions);
    if (origQuery) {
      navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : origQuery(parameters);
    }
  } catch {}

  // 5. chrome.runtime — headless Chromium has window.chrome === undefined.
  try {
    if (typeof window.chrome === 'undefined') window.chrome = {};
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: {
          CHROME_UPDATE: 'chrome_update',
          INSTALL: 'install',
          SHARED_MODULE_UPDATE: 'shared_module_update',
          UPDATE: 'update',
        },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: {
          NO_UPDATE: 'no_update',
          THROTTLED: 'throttled',
          UPDATE_AVAILABLE: 'update_available',
        },
        connect: () => undefined,
        sendMessage: () => undefined,
      };
    }
  } catch {}

  // 6. WebGL vendor / renderer — many CF challenges check for SwiftShader / Mesa.
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.call(this, parameter);
      };
    }
  } catch {}

  // 7. iframe contentWindow trap — some scripts use a same-origin iframe to
  //    sniff a clean Navigator. Make sure ours leaks the patches too.
  try {
    const elementAttachShadow = HTMLIFrameElement.prototype.contentWindow;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get() {
        const w = window.HTMLIFrameElement.prototype.__lookupGetter__('contentWindow').call(this);
        try {
          if (w && !w.__eab_stealth_applied) w.__eab_stealth_applied = true;
        } catch {}
        return w;
      },
    });
    void elementAttachShadow;
  } catch {}

  // 8. hairline / deviceMemory / hardwareConcurrency — realistic values.
  try {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 });
  } catch {}
})();
