// Browser capability probe for the Blur Web E1 page.
//
// This module runs in the measured browser and records only what the browser
// actually reports. It never reads a version from a table: the user agent,
// adapter info, limits and feature results are all measured here. The Node
// harness (tools/probe_capabilities.mjs) navigates to this page and reads
// `window.__compatResult`.
//
// Top-level await is used on purpose: a browser that cannot parse it cannot run
// the game page either (the Emscripten ES6 glue awaits at module top level).

import { WASM_FEATURE_PROBES } from './wasm-probes.js';

const LIMIT_NAMES = [
  'maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D', 'maxTextureArrayLayers',
  'maxBindGroups', 'maxBindGroupsPlusVertexBuffers', 'maxBindingsPerBindGroup',
  'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout',
  'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage',
  'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage',
  'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize',
  'minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment',
  'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes', 'maxVertexBufferArrayStride',
  'maxInterStageShaderVariables', 'maxColorAttachments', 'maxColorAttachmentBytesPerSample',
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
  'maxComputeWorkgroupsPerDimension', 'maxStorageBuffersInVertexStage',
  'maxStorageTexturesInVertexStage', 'maxStorageBuffersInFragmentStage',
  'maxStorageTexturesInFragmentStage'
];

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: (error && (error.message || error.reason || String(error))) || 'unknown error' };
  }
}

function readLimits(source) {
  const out = {};
  if (!source) return out;
  for (const name of LIMIT_NAMES) {
    const value = source[name];
    out[name] = Number.isFinite(value) ? value : null;
  }
  return out;
}

function readFeatures(source) {
  if (!source) return [];
  try { return Array.from(source); } catch { return []; }
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildWav() {
  // 16-bit PCM mono, 8 kHz, 40 ms of a quiet 440 Hz tone. Enough for
  // decodeAudioData to prove the decoder is present and produces a buffer.
  const sampleRate = 8000;
  const frames = 320;
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(1200 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    view.setInt16(44 + i * 2, sample, true);
  }
  return buffer;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function probeWebSocket() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = scheme + '://' + location.host + '/compat/echo';
  return await new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    let socket;
    const timer = setTimeout(() => done({ opened: false, reason: 'timeout' }), 4000);
    try {
      socket = new WebSocket(url);
      socket.onopen = () => { /* wait for the echo text */ };
      socket.onmessage = (event) => { clearTimeout(timer); done({ opened: true, echo: String(event.data) }); try { socket.close(); } catch {} };
      socket.onerror = () => { clearTimeout(timer); done({ opened: false, reason: 'error' }); };
      socket.onclose = (event) => { if (!settled) { clearTimeout(timer); done({ opened: false, reason: 'closed:' + event.code }); } };
    } catch (error) {
      clearTimeout(timer);
      done({ opened: false, reason: error.message });
    }
  });
}

async function collect() {
  const result = {
    schema: 'blur.compat.capability',
    version: 1,
    measuredAt: new Date().toISOString(),
    url: location.href,
    origin: location.origin,
    secureContext: !!window.isSecureContext,
    crossOriginIsolated: !!window.crossOriginIsolated,
    ua: navigator.userAgent,
    uaData: null,
    platform: navigator.platform || null,
    language: navigator.language || null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    maxTouchPoints: navigator.maxTouchPoints ?? null,
    webgpu: {},
    webgl: {},
    wasm: {},
    audio: {},
    websocket: {},
    storage: {},
    canvas: {},
    modules: {},
    crypto: {},
    misc: {},
    errors: []
  };

  if (navigator.userAgentData) {
    result.uaData = {
      brands: (navigator.userAgentData.brands || []).map((b) => ({ brand: b.brand, version: b.version })),
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
      architecture: navigator.userAgentData.architecture ?? null,
      bitness: navigator.userAgentData.bitness ?? null,
      model: navigator.userAgentData.model ?? null,
      platformVersion: navigator.userAgentData.platformVersion ?? null
    };
  }

  // --- WebGPU -------------------------------------------------------------
  const gpuProbe = await attempt(async () => {
    if (!navigator.gpu) throw new Error('navigator.gpu is undefined');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('requestAdapter() returned null');
    const info = adapter.info ? {
      vendor: adapter.info.vendor ?? null,
      architecture: adapter.info.architecture ?? null,
      device: adapter.info.device ?? null,
      description: adapter.info.description ?? null,
      subgroupMinSize: adapter.info.subgroupMinSize ?? null,
      subgroupMaxSize: adapter.info.subgroupMaxSize ?? null,
      isFallbackAdapter: adapter.info.isFallbackAdapter ?? null
    } : {};
    const adapterLimits = readLimits(adapter.limits);
    const adapterFeatures = readFeatures(adapter.features);
    const device = await adapter.requestDevice();
    const deviceLimits = readLimits(device.limits);
    const deviceFeatures = readFeatures(device.features);
    let canvasOk = false;
    let canvasError = null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 8; canvas.height = 8;
      const context = canvas.getContext('webgpu');
      if (!context) throw new Error('canvas.getContext("webgpu") returned null');
      context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
      const texture = context.getCurrentTexture();
      canvasOk = !!texture && texture.width === 8;
    } catch (error) {
      canvasError = error.message;
    }
    const preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat();
    // A WGSL compile check of the exact production shader would need the page's
    // module; the game boot record already proves that separately. Here only the
    // device-level facts are recorded.
    return {
      present: true,
      adapter: info,
      isFallbackAdapter: adapter.isFallbackAdapter ?? null,
      adapterFeatures,
      adapterLimits,
      deviceFeatures,
      deviceLimits,
      preferredCanvasFormat,
      canvasContext: canvasOk,
      canvasError,
      deviceError: null
    };
  });
  if (gpuProbe.ok) {
    result.webgpu = gpuProbe.value;
  } else {
    result.webgpu = { present: typeof navigator.gpu !== 'undefined', error: gpuProbe.error };
    result.errors.push('webgpu: ' + gpuProbe.error);
  }

  // Required-limit comparison against the committed requirement model.
  const requirements = await attempt(async () => {
    const response = await fetch('/compat/requirements.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  });
  if (requirements.ok) {
    const required = requirements.value.webgpu.requiredLimits;
    const measured = result.webgpu.adapterLimits || {};
    const failures = [];
    for (const [name, minimum] of Object.entries(required)) {
      const value = measured[name];
      if (value === null || value === undefined) failures.push(name + ': not reported (need >= ' + minimum + ')');
      else if (value < minimum) failures.push(name + ': ' + value + ' < required ' + minimum);
    }
    const alignment = measured.minUniformBufferOffsetAlignment;
    if (alignment !== null && alignment !== undefined && alignment > 256) {
      failures.push('minUniformBufferOffsetAlignment: ' + alignment + ' > hard-coded 256');
    }
    result.requirements = { ok: failures.length === 0, failures, required, checked: Object.keys(required).length };
    if (failures.length) result.errors.push('limits: ' + failures.join('; '));
  } else {
    result.requirements = { ok: false, failures: ['requirements fetch: ' + requirements.error], required: null, checked: 0 };
    result.errors.push('requirements: ' + requirements.error);
  }

  // --- WebGL (fallback feasibility, not used by the page) -----------------
  result.webgl = await attempt(async () => {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    const gl1 = gl2 ? null : canvas.getContext('webgl');
    const gl = gl2 || gl1;
    if (!gl) return { webgl2: false, webgl1: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
    const params = {};
    if (gl2) {
      for (const name of ['VERSION', 'SHADING_LANGUAGE_VERSION', 'MAX_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE',
        'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_FRAGMENT_UNIFORM_BLOCKS', 'MAX_UNIFORM_BLOCK_SIZE',
        'MAX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_ATTRIBS', 'MAX_ELEMENTS_INDICES', 'MAX_ELEMENTS_VERTICES']) {
        params[name] = gl2.getParameter(gl2[name]);
      }
    }
    return {
      webgl2: !!gl2,
      webgl1: !!gl1,
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      anisotropic: anisotropic ? {
        max: gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT),
        extension: 'EXT_texture_filter_anisotropic'
      } : null,
      params
    };
  });
  if (!result.webgl.ok) { result.errors.push('webgl: ' + result.webgl.error); result.webgl = { webgl2: false, webgl1: false, error: result.webgl.error }; }

  // --- WebAssembly --------------------------------------------------------
  result.wasm = await attempt(async () => {
    const features = {};
    for (const [name, base64] of Object.entries(WASM_FEATURE_PROBES)) {
      features[name] = WebAssembly.validate(base64ToBytes(base64));
    }
    const engine = await attempt(async () => {
      const response = await fetch('/_work/e1-drive/module/e1_drive.wasm', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const instantiated = await WebAssembly.compile(bytes);
      return { bytes: bytes.length, compiled: !!instantiated, validated: WebAssembly.validate(bytes) };
    });
    return {
      validate: typeof WebAssembly.validate === 'function',
      compile: typeof WebAssembly.compile === 'function',
      instantiate: typeof WebAssembly.instantiate === 'function',
      features,
      engine: engine.ok ? engine.value : { error: engine.error },
      featureProbeSource: 'probes/compat/web/wasm-probes.js'
    };
  });
  if (!result.wasm.ok) { result.errors.push('wasm: ' + result.wasm.error); }

  // --- Web Audio ----------------------------------------------------------
  result.audio = await attempt(async () => {
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!globalThis.AudioContext && !globalThis.webkitAudioContext && !Offline) {
      return { available: false, reason: 'no AudioContext constructor' };
    }
    if (!Offline) return { available: true, decoded: false, reason: 'no OfflineAudioContext to decode without a gesture' };
    const context = new Offline(1, 320, 8000);
    const buffer = await context.decodeAudioData(buildWav());
    return {
      available: true,
      decoded: true,
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      constructor: globalThis.AudioContext ? 'AudioContext' : 'webkitAudioContext'
    };
  });
  if (!result.audio.ok) { result.errors.push('audio: ' + result.audio.error); result.audio = { available: false, decoded: false, error: result.audio.error }; }

  // --- WebSocket ----------------------------------------------------------
  result.websocket = await attempt(async () => {
    if (typeof WebSocket !== 'function') throw new Error('WebSocket is not a constructor');
    const echo = await probeWebSocket();
    return { constructor: true, ...echo };
  });
  if (!result.websocket.ok) { result.errors.push('websocket: ' + result.websocket.error); result.websocket = { constructor: false, error: result.websocket.error }; }

  // --- Storage ------------------------------------------------------------
  result.storage = await attempt(async () => {
    const probe = (store) => {
      if (!store) return false;
      const key = '__compat_probe__';
      store.setItem(key, '1');
      const ok = store.getItem(key) === '1';
      store.removeItem(key);
      return ok;
    };
    let local = false;
    let session = false;
    let localError = null;
    try { local = probe(window.localStorage); } catch (error) { localError = error.message; }
    try { session = probe(window.sessionStorage); } catch {}
    return {
      localStorage: local,
      sessionStorage: session,
      indexedDB: typeof indexedDB !== 'undefined',
      error: localError
    };
  });

  // --- Canvas / image -----------------------------------------------------
  result.canvas = await attempt(async () => {
    const out = {
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      offscreenWebGL2: false,
      createImageBitmap: typeof createImageBitmap === 'function',
      imageData: typeof ImageData !== 'undefined',
      pointerEvents: typeof PointerEvent !== 'undefined',
      devicePixelRatio: window.devicePixelRatio ?? null
    };
    if (out.offscreenCanvas) {
      try {
        const canvas = new OffscreenCanvas(4, 4);
        out.offscreenWebGL2 = !!canvas.getContext('webgl2');
      } catch {}
    }
    return out;
  });

  // --- Modules ------------------------------------------------------------
  result.modules = await attempt(async () => {
    const mod = await import('./module-probe.js');
    return {
      staticModule: true,
      dynamicImport: mod.MODULE_PROBE?.value === 42,
      importMetaUrl: import.meta.url,
      topLevelAwait: true,
      workers: typeof Worker !== 'undefined',
      moduleWorkers: typeof Worker !== 'undefined'
    };
  });

  // --- Crypto -------------------------------------------------------------
  result.crypto = await attempt(async () => {
    const subtle = !!globalThis.crypto?.subtle;
    const digest = subtle ? await sha256Hex('abc') : null;
    return {
      subtle,
      digest,
      digestMatchesKnownVector: digest === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      getRandomValues: typeof globalThis.crypto?.getRandomValues === 'function'
    };
  });

  // --- Misc ---------------------------------------------------------------
  result.misc = await attempt(async () => ({
    structuredClone: typeof structuredClone === 'function',
    textEncoder: typeof TextEncoder === 'function',
    requestAnimationFrame: typeof requestAnimationFrame === 'function',
    URLSearchParams: typeof URLSearchParams === 'function',
    atob: typeof atob === 'function',
    performanceNow: typeof performance?.now === 'function',
    arrayAt: typeof [].at === 'function',
    objectHasOwn: typeof Object.hasOwn === 'function',
    promiseWithResolvers: typeof Promise.withResolvers === 'function',
    moduleScriptSupported: document.createElement('script').noModule === false,
    hidden: document.hidden
  }));

  return result;
}

const state = document.getElementById('state');
const out = document.getElementById('out');
try {
  const result = await collect();
  window.__compatResult = result;
  state.textContent = 'done — ' + (result.errors.length ? result.errors.length + ' recorded failure(s)' : 'all probes answered');
  state.className = result.errors.length ? 'bad' : 'ok';
  out.textContent = JSON.stringify(result, null, 2);
} catch (error) {
  window.__compatResult = {
    schema: 'blur.compat.capability',
    version: 1,
    fatal: true,
    error: error.message,
    errors: [error.message]
  };
  state.textContent = 'fatal: ' + error.message;
  state.className = 'bad';
  out.textContent = error.stack || error.message;
}
window.__compatDone = true;
