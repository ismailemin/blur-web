# Browser compatibility — Blur Web E1 slice

**Date:** 8 November 2026
**Scope:** what the committed E1 page (`probes/e1-drive/web`) needs from a browser,
what the browsers on this machine actually do, and what "multiplayer testable by
friends" therefore requires.
**Not a claim:** this is one machine (Windows 11 25H2, RTX 5080), two installed
browsers, and vendor documentation for the others. It is not a device lab.

**Evidence (not committed):**

| path | contents |
| --- | --- |
| `_work/compat/browsers.json` | installed executables and `--version` output |
| `_work/compat/capabilities/<run>.json` | full capability probe per browser/run |
| `_work/compat/boot/<run>.json` | real page boot: tick, draws, console, screenshot |
| `_work/compat/screens/*.png` | 1280×720 screenshots of the running page |
| `_work/compat/compat-matrix.json` | derived matrix (stable hash) |
| `_work/compat/render-requirements.json` | measured draw/texture/buffer budget |
| `_work/logs/compat/probe.log` | run log |
| `_work/logs/compat/network.txt` | bind/connection test of the game server |

Reproduce:

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/compat/tools/build_wasm_probes.mjs
& $node probes/compat/tools/measure_requirements.mjs
& $node probes/compat/tools/probe_capabilities.mjs     # starts its own servers on 8810/8812
& $node probes/compat/tools/build_matrix.mjs
& $node probes/compat/tools/verify_compat.mjs           # 637 checks
```

Ports: the probe server binds `0.0.0.0:8812`, proxies to the unmodified E1 server
on `127.0.0.1:8810`, and never uses 8801/8802-8809/8811. Browser profiles are
under `_work/compat/profiles/`.

---

## 1. Hard requirements read from the code

### 1.1 WebGPU — what is actually requested

`packet-consumer.js:566-568` calls `requestAdapter()` and `adapter.requestDevice()`
with **no descriptor at all**:

- **Required features: none.** No timestamp query, no `shader-f16`, no storage
  buffers, no compatibility mode. `forward` shading only.
- **Required limits: none declared.** The page runs on the *default* device, so
  the WebGPU default limits are the ceiling, not the adapter's higher numbers.
  This matters: the adapter reports `maxBufferSize` 2 GiB and
  `maxTextureDimension2D` 16384, but the default device caps them at 256 MiB and
  8192. The page still fits.

| requirement | value | why (source) | measured default device |
| --- | ---: | --- | ---: |
| `maxBufferSize` (bytes) | 8,866,860 | Gracia positions buffer: 738,905 × 12 B (`packet-consumer.js:768-772`; `measure_requirements.mjs`) | 268,435,456 |
| `maxTextureDimension2D` (texels) | 512 | largest uploaded albedo (level, track, car, Amboy/Gracia) is 512×512 (`packet-consumer.js:855-859`) | 8,192 |
| `maxTextureArrayLayers` | 1 | `size: [w, h, 1]` | 256 |
| `maxBindGroups` | 3 | draw + scene + texture layouts (`:607-609`) | 4 |
| `maxBindingsPerBindGroup` | 3 | one binding per group | 1,000 |
| `maxUniformBuffersPerShaderStage` | 2 | draw + scene uniforms | 12 |
| `maxUniformBufferBindingSize` | 160 | `DRAW_UNIFORM_BYTES` (`:138`) | 65,536 |
| `maxSampledTexturesPerShaderStage` | 1 | one `texture_2d<f32>` | 16 |
| `maxSamplersPerShaderStage` | 1 | one filtering sampler | 16 |
| `maxVertexBuffers` | 2 | position + UV | 8 |
| `maxVertexAttributes` | 2 | `float32x3`, `float32x2` | 16 |
| `maxVertexBufferArrayStride` | 12 | stride 12/8 | 2,048 |
| `maxColorAttachments` | 1 | one colour target | 8 |
| `maxColorAttachmentBytesPerSample` | 8 | RGBA8 (4 B) plus no extra target | 32 |
| `maxBindGroupsPlusVertexBuffers` | 5 | 3 groups + 2 vertex buffers | 24 |
| `minUniformBufferOffsetAlignment` | **must be ≤ 256** | `DRAW_UNIFORM_STRIDE = 256` is hard-coded (`:137`); measured 256 | 256 |

Formats and pipeline state: `navigator.gpu.getPreferredCanvasFormat()` (measured
`bgra8unorm`), `depth24plus` depth attachment (`:622,654,1478`),
`rgba8unorm-srgb` textures with a derived mip chain (`:245,855-869`),
triangle-list with `cullMode:'none'`, and one alpha-blended ghost pipeline
(`:647-651`). No compute, no storage textures, no MSAA, no multiview.

**Sampler anisotropy is a dead branch on current WebGPU.** The code reads
`adapter.limits.maxSamplerAnisotropy` (`:571-574`), but modern implementations no
longer expose that limit (measured `undefined` → applied value 1). Textures are
therefore sampled without anisotropic filtering. That is a quality loss, not a
boot blocker.

### 1.2 WebAssembly

`e1_drive.wasm` (1,012,634 B, SHA-256 `bcdc2d99…`) was validated with binaryen
`wasm-opt` and inspected with `wasm-dis`:

| feature | needed | evidence |
| --- | --- | --- |
| WASM MVP | yes | validates with `--mvp-features` |
| `mutable-globals` | yes | required by the Emscripten output |
| `sign-ext` | yes | required by the Emscripten output |
| `bulk-memory` (`memory.copy`/`memory.fill`) | yes | `wasm-opt` rejects it without `--enable-bulk-memory` |
| `nontrapping-fptoint` (`i32.trunc_sat_f32_s`) | yes | `wasm-opt` rejects it without the flag |
| SIMD | **no** | validates with SIMD disabled |
| threads / atomics / shared memory | **no** | `wasm-dis`: `(memory $0 4096 8192)` — not shared |
| tail-call, exceptions, reference types, multi-value, memory64 | **no** | validates with all of them disabled |

Memory: 4096 pages initial = **256 MiB**, 8192 pages max = **512 MiB**
(`build_module.mjs:89-90`). `ALLOW_MEMORY_GROWTH=1`; no `SharedArrayBuffer`.

### 1.3 JavaScript and web platform

| requirement | used by | note |
| --- | --- | --- |
| ES modules + **top-level await** | `index.html:107`, Emscripten ES6 glue | the glue awaits at module top level |
| dynamic `import()` | `app.js:2254` (`import(ENGINE_MODULE)`) | |
| `import.meta.url` | Emscripten glue | |
| **secure context** for `navigator.gpu` | `packet-consumer.js:565` | WebGPU is a secure-context feature (MDN) |
| **secure context** for `crypto.subtle` | `map-package.js:196-200` | every load hashes the chunk index, level chunk, car chunk and physics file (`app.js:2196-2308`), so this is on the *default* River path, not only map mode |
| `HTMLCanvasElement.getContext('webgpu')` | `packet-consumer.js:581` | |
| `fetch` + `arrayBuffer` + `atob` | asset loads, base64 textures/UV | |
| `localStorage` | best times, ghost | optional |
| `AudioContext` + `decodeAudioData` | engine audio, after a gesture | six RIFF/WAVE PCM 16-bit mono 48 kHz loops (measured headers); optional — failure is a typed HUD row and `?audio=0` disables it |
| `WebSocket` | `?mp=1` room client | multiplayer only |
| `requestAnimationFrame`, `URLSearchParams`, pointer events | page loop/input | |

Not used anywhere in `probes/e1-drive/web`: **OffscreenCanvas, Web Workers,
SharedArrayBuffer, IndexedDB, Service Worker, WebGL/WebGL2, import maps, JSON
import assertions.** The page is a single main-thread module.

### 1.4 Render packet budget (measured from the committed artifacts)

`probes/compat/tools/measure_requirements.mjs` writes
`_work/compat/render-requirements.json`:

| map | draws (max car) | uniform buffer | largest buffer | uploaded textures | max texture |
| --- | ---: | ---: | ---: | ---: | ---: |
| River | 539 | 269,056 B | 1,157,928 B | 136 + 9 car | 512² |
| Amboy | 1,324 | 470,016 B | 6,355,488 B | 179 + 9 car | 512² |
| Gracia | 2,750 | 835,072 B | 8,866,860 B | 734 + 9 car | 512² |

The uniform figure includes 4 remote bands (1 human + 3 AI) × 123 draws plus 16
power-up markers and 4 Barge rings, at the hard-coded 256-byte stride.

---

## 2. What is installed on this machine

Enumerated from `Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%` and the
executables' own `--version` output (`_work/compat/browsers.json`):

| browser | installed | version |
| --- | --- | --- |
| Microsoft Edge | yes | `Microsoft Edge 157.0.4341.42` |
| Brave | yes | `Brave Browser 157.1.99.55` |
| Google Chrome | no | — |
| Mozilla Firefox | no | — |
| Opera / Vivaldi | no | — |
| Safari | not distributed on Windows | — |

Hardware/OS recorded by the probe: Windows release `10.0.26200` (Windows 11
25H2), NVIDIA RTX 5080, adapter `nvidia / blackwell`, driver 32.0.16.1692,
16 logical CPUs, `deviceMemory` 32.

---

## 3. Measured results

Four runs per browser: headless with the project capture flags, headless with no
flags, headed with no flags (the friend-facing path), and the same page opened
from the machine's LAN address (`http://192.168.1.78:8812`).

### 3.1 Loopback (secure context) — both browsers support the page

| fact | Edge 157 | Brave 157 |
| --- | --- | --- |
| `isSecureContext` | true | true |
| `navigator.gpu` | present | present |
| adapter | `nvidia / blackwell` | `nvidia / blackwell` |
| fallback adapter | false | false |
| preferred canvas format | `bgra8unorm` | `bgra8unorm` |
| WebGPU canvas configured | yes | yes |
| core features | `core-features-and-limits` + 25 more | same list |
| every required limit met (adapter **and** default device) | yes | yes |
| `minUniformBufferOffsetAlignment` | 256 | 256 |
| real page boot (`?script=drive&hold=120`) | **running, 516 draws, tick 120** | **running, 516 draws, tick 120** |
| console | **0 errors / 0 warnings** | **0 errors / 0 warnings** |
| screenshot | `_work/compat/screens/edge-headed-default-boot.png` | `_work/compat/screens/brave-headed-default-boot.png` |
| headless without `--enable-unsafe-webgpu` | boots | boots |
| WebGL2 present (fallback probe) | yes | yes |

WebGPU is available in headless Edge/Brave on this build **without** the capture
flags; `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=d3d11` is not
required here (it is still what the existing captures use).

WASM/JS/audio/storage checks passed identically in both browsers: the real
`e1_drive.wasm` compiles and validates; `mvp`, `mutable-globals`, `sign-ext`,
`bulk-memory`, `nontrapping-fptoint` are supported (the browser also supports
SIMD, threads and the other probes, but the module does not need them);
`decodeAudioData` decodes a generated WAV; a real WebSocket echo completes;
`localStorage`, `crypto.subtle` (known SHA-256 vector), dynamic import and
top-level await all work.

### 3.2 LAN address (plain HTTP) — both browsers **unsupported**

Opened at `http://192.168.1.78:8812` on the same machine:

| fact | Edge 157 | Brave 157 |
| --- | --- | --- |
| `isSecureContext` | **false** | **false** |
| `navigator.gpu` | **undefined** | **undefined** |
| `crypto.subtle` | **undefined** | **undefined** |
| page error | `crypto.subtle is unavailable: the map physics pin cannot be verified` | same |
| reaches a frame | no | no |

This is not a GPU or a codec problem: a plain-HTTP LAN origin is not a
potentially trustworthy origin, so the browser removes both secure-context APIs
before any game code runs. The page fails at its first hash check, not at
WebGPU init, because chunk verification happens earlier in `loadEngine()`.

Two separate blockers for "friends on another machine":

1. **The launcher never listens on the LAN.** `probes/e1-drive/tools/serve.mjs:352`
   binds `127.0.0.1`, so `http://192.168.1.78:8810` is `ECONNREFUSED` (measured
   in `_work/logs/compat/network.txt`). The E1 handoff's LAN instructions in
   `docs/handoff/E1_POC.md` assume a reachable port; with the current launcher
   they cannot work.
2. **Even if it did listen, plain HTTP is not a secure context.** WebGPU and
   `crypto.subtle` disappear. Serving over HTTP would need the unsupported path
   of asking every friend to restart their browser with
   `--unsafely-treat-insecure-origin-as-secure=http://192.168.1.78:8801`.

The only practical combinations:

- **HTTPS on the LAN** with a certificate the friend's browser trusts
  (`mkcert` local CA installed once per friend machine, or a real certificate),
  and **`wss://`** for the room service (`ws://` from an `https://` page is mixed
  content and is blocked). Then the room must also bind `0.0.0.0` and the port
  allowed through the firewall.
- **Play on the host machine** at `http://127.0.0.1:8801` — supported today, but
  that is not two machines.
- A hosted HTTPS deployment (reverse proxy / tunnel) with `wss://` and a `wss://`
  room endpoint via `?mpServer=`.

Recommended next steps (outside this task's file ownership): add a `--host`
option (or a documented reverse-proxy setup) to `tools/serve.mjs` and the
launcher, terminate TLS in front of both the page and the room service, and
change the documented guest URL to the HTTPS one.

---

## 4. Support matrix

### 4.1 Measured rows (this machine)

| browser | OS | version | origin | status | failing API | user-facing message |
| --- | --- | --- | --- | --- | --- | --- |
| Microsoft Edge | Windows (10.0.26200) | 157.0.4341.42 | `http://127.0.0.1` | **supported** | — | — |
| Brave | Windows (10.0.26200) | 157.1.99.55 | `http://127.0.0.1` | **supported** | — | — |
| Microsoft Edge | Windows (10.0.26200) | 157.0.4341.42 | `http://192.168.1.78` (LAN) | **unsupported** | `isSecureContext` → `navigator.gpu`, `crypto.subtle` | see §6 "insecure origin" |
| Brave | Windows (10.0.26200) | 157.1.99.55 | `http://192.168.1.78` (LAN) | **unsupported** | same | same |

### 4.2 Vendor-documented rows (not machine-tested here)

Source: caniuse WebGPU data (retrieved 2026-11-08), MDN WebGPU API page, MDN
Firefox 141 release notes; full text and note numbers in
`probes/compat/reference/vendor-support.json`. "Partial" is caniuse's own label
or a driver/flag qualification, quoted in the note.

| browser | OS | minimum | status | basis / caveat |
| --- | --- | --- | --- | --- |
| Chrome | Windows | 113 | supported | Chromium 113 shipped WebGPU on Windows |
| Chrome | macOS | 113 | supported | |
| Chrome | Linux | 144 | **partial** | before 144 needs `enable-unsafe-webgpu`; from 144 depends on hardware/drivers (notes 5/9) |
| Edge | Windows | 113 | supported | |
| Edge | macOS | 113 | supported | |
| Edge | Linux | 144 | **partial** | same Linux rule |
| Brave | Windows/macOS | Chromium 113 engine | supported | measured here at 157; caniuse has no Brave row so no Brave minimum is asserted |
| Firefox | Windows | **141** | supported | MDN Firefox 141: "WebGPU API is now fully supported on Windows" |
| Firefox | Windows ≤140 | — | unsupported | `dom.webgpu.enabled` only |
| Firefox | macOS 26 Tahoe, Apple Silicon | 145 | supported | caniuse note 8 |
| Firefox | macOS before 26 / Intel | — | unsupported | flag only |
| Firefox | Linux | — | unsupported | flag only (note 1/8) |
| Safari | macOS 26 Tahoe+ | **26.0** | supported | caniuse note 7 |
| Safari | macOS before 26 Tahoe | — | unsupported | WebGPU feature flag only (note 2) |
| Safari | iOS/iPadOS 26+ | 26.0 | supported | |
| Safari | iOS/iPadOS 17.4-18.7 | — | unsupported | flag only |
| Safari | Windows | — | unsupported | not distributed |
| Opera | Windows | 99 | supported | Chromium |
| Samsung Internet | Android | 24 | supported | |
| Chrome for Android | Android | current (157) | supported | caniuse gives no minimum Android OS, so none is claimed |
| Firefox for Android | Android | — | unsupported | disabled by default |

Summary from the matrix: **12 vendor rows supported, 2 partial (Linux Chromium),
8 unsupported**. caniuse's data file reports `usage_perc_y` 86.83 % and
`usage_perc_a` 3.32 % for WebGPU (October 2026 StatCounter), i.e. roughly one in
eight users is still outside full support.

Stated plainly, because the two are often confused:

- **Firefox can run WebGPU today** — on Windows since 141, and on macOS 26 Tahoe
  (Apple Silicon) since 145. It **cannot** on Linux, or on macOS before Tahoe,
  or on Firefox for Android: there WebGPU is behind `dom.webgpu.enabled`.
- **Safari can run WebGPU today only on macOS 26 Tahoe and iOS 26 or later.**
  On earlier macOS versions and on iOS 17/18 it is a disabled feature flag, so "Safari" as a
  support answer is wrong unless the OS version is included.

---

## 5. Minimum versions (short form)

- **Windows:** Edge/Chrome/Brave **113+**, Firefox **141+**.
- **macOS:** Chrome/Edge **113+**, Safari **26.0+ on macOS 26 Tahoe**.
- **iPhone/iPad:** Safari **26.0+**.
- **Linux:** Chrome/Edge **144+** and only with a working driver path; WebGPU is
  not a safe default before that.
- **Android:** current Chrome or Samsung Internet **24+**; Firefox Android is not
  supported.

---

## 6. Recommended capability check and unsupported screen

### 6.1 Check order (cheapest and most likely failure first)

1. `window.isSecureContext` — a LAN HTTP friend fails here, and this is the only
   failure with a fix the user can act on immediately.
2. `navigator.gpu` — the browser has no WebGPU.
3. `await navigator.gpu.requestAdapter()` — no adapter (driver/blocklist).
4. `await adapter.requestDevice()` — device creation failed.
5. compare `device.limits` with the table in §1.1 (the default device, not the
   adapter — the page requests no limits).
6. `!!crypto?.subtle` — hash pins.
7. compile the real WGSL shader and run `?script=drive&hold=0` once; only then
   show the menu. The page already does 5-7 implicitly, so an explicit preflight
   can reuse the same code path.

Sketch (project style, dependency-free):

```js
export async function preflight() {
  if (!window.isSecureContext) return { ok: false, code: 'INSECURE_ORIGIN' };
  if (!navigator.gpu) return { ok: false, code: 'NO_WEBGPU' };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ok: false, code: 'NO_ADAPTER' };
  const device = await adapter.requestDevice();
  const required = { maxBufferSize: 8866860, maxTextureDimension2D: 512, maxBindGroups: 3,
    maxVertexBuffers: 2, maxUniformBufferBindingSize: 160, minUniformBufferOffsetAlignment: 256 };
  for (const [name, min] of Object.entries(required)) {
    const value = device.limits[name];
    if (name === 'minUniformBufferOffsetAlignment' ? value > min : value < min) {
      return { ok: false, code: 'LIMIT', name, value, min };
    }
  }
  if (!globalThis.crypto?.subtle) return { ok: false, code: 'NO_SUBTLE' };
  return { ok: true, adapter, device, adapterInfo: adapter.info };
}
```

Notes: `minUniformBufferOffsetAlignment` is an upper bound (the page assumes 256);
everything else is a lower bound. Do not test `maxSamplerAnisotropy` — it no
longer exists.

### 6.2 Unsupported screen — exact copy

Title:

> **This browser cannot run Blur Web (E1 slice).**

Insecure origin (the LAN case, most likely for a friend):

> **This page is open over a plain-HTTP address that browsers do not trust.**
> WebGPU and `crypto.subtle` are only available on `https://`, or on
> `http://127.0.0.1` / `http://localhost`.
>
> Open the game on the host machine at `http://127.0.0.1:8801`, or ask the host
> for an **https://** link. On a LAN, plain `http://192.168.x.x` will not work in
> any current browser.

No WebGPU:

> **WebGPU is not available in this browser.**
>
> Use Microsoft Edge, Google Chrome or Brave **113 or newer** on Windows or
> macOS. On Windows, Firefox **141 or newer** also works. On macOS, Safari **26
> or newer on macOS 26 Tahoe** works. On Linux, use Chrome/Edge **144+** with a
> working GPU driver.
>
> If you are already on one of those browsers: update it, and make sure hardware
> acceleration is enabled (`chrome://gpu` / `edge://gpu` / `about:support` in
> Firefox).

No adapter / device:

> **This browser has WebGPU, but no usable GPU was found.**
> Hardware acceleration may be disabled, the GPU driver may be blocklisted, or
> this may be a remote/headless session without a GPU. Update the graphics
> driver and retry.

Limits:

> **This GPU does not meet the minimum WebGPU limits for this slice.**
> Required: `maxBufferSize` ≥ 8,866,860 B, `maxTextureDimension2D` ≥ 512,
> `maxBindGroups` ≥ 3, `maxVertexBuffers` ≥ 2, `maxUniformBufferBindingSize` ≥ 160,
> `minUniformBufferOffsetAlignment` ≤ 256.
> Detected: `<name> = <value>`.

The screen should always print the detected facts it used (`secure context`,
user agent, adapter vendor/architecture, failing API) so a friend can send one
screenshot instead of a debugging session.

---

## 7. WebGL2 fallback — verdict and cost

**Verdict: technically feasible on the measured hardware, but not implemented,
and it would not remove the secure-context requirement.** WebGL2 is not a
secure-context-gated API, but `crypto.subtle` is, and the page hashes its own
assets on every load. A WebGL2 path therefore fixes *old browsers on the same
loopback origin*, not *friends over plain HTTP*.

Measured WebGL2 capability (same machine, both browsers):

| fact | value |
| --- | --- |
| WebGL2 context | yes (`WebGL 2.0 (OpenGL ES 3.0 Chromium)`) |
| renderer | `ANGLE (NVIDIA, NVIDIA GeForce RTX 5080, D3D11)` |
| `MAX_TEXTURE_SIZE` | 16,384 (needs 512) |
| `MAX_UNIFORM_BLOCK_SIZE` | 65,536 (needs 160) |
| vertex / fragment uniform blocks | 12 / 11-12 (needs 1 / 2) |
| `MAX_TEXTURE_IMAGE_UNITS` | 16 (needs 1) |
| `EXT_texture_filter_anisotropic` | max 16 |

Mapping the packet to WebGL2 is mechanical:

| WebGPU use | WebGL2 equivalent | risk |
| --- | --- | --- |
| `rgba8unorm-srgb` texture + writeTexture | `SRGB8_ALPHA8`, `texSubImage2D` | low |
| derived mip chain (already computed in JS) | same byte upload, `TEXTURE_MAX_LEVEL` | low |
| `depth24plus` | `DEPTH_COMPONENT24` renderbuffer | low |
| dynamic uniform offsets, 256-byte stride | `bindBufferRange(UNIFORM_BUFFER, 0, ubo, offset, 160)` per draw; std140 layout matches 2×mat4 + 2×vec4 = 160 B | medium: 1 extra call per draw |
| two vertex buffers `float32x3`/`float32x2` | `vertexAttribPointer` | low |
| WGSL `dpdx`/`dpdy` derivative normals | GLSL ES 3.00 `dFdx`/`dFdy` | low |
| `textureSample` + `select`/`mix` | `texture()` + `mix` | low |
| alpha-blended ghost pipeline | blend state + `depthMask(false)` | low |
| `getPreferredCanvasFormat()` | `drawingBufferColorSpace`/default RGBA8 | low |
| canvas `configure`/`getCurrentTexture` | default framebuffer, no configure | low |

Cost (estimate, not a measurement — no fallback code was written):

| work item | estimate |
| --- | --- |
| GLSL ES 3.00 main + ghost shaders, parity with the WGSL paths | 1.0 day |
| `GlConsumer` backend: buffers/textures/mips/depth/canvas resize, same `load`/`renderFrame` interface | 1.5 days |
| per-draw UBO binding (2,750 draws), bind-group emulation, ghost/remote/power-up passes | 1.0 day |
| selection, capability check and explicit "WebGL2 fallback" labelling in HUD/evidence | 0.5 day |
| verifier + screenshot parity tolerance (sRGB/derivative differences mean pixel-exact equality is not achievable) | 1.5 days |
| regression run of the existing capture suite on the fallback | 1.0 day |
| **total** | **≈ 6.5 engineer-days**, one developer who knows this renderer |

Runtime arithmetic for the fallback: 2,750 draws × (bindBufferRange + draw) plus
per-draw uniform writes ≈ 5,500+ GL calls/frame, ≈ 330 k calls/s at 60 Hz. On
this machine that is likely fine (WebGL2 drivers handle a few thousand draws),
but it is **not measured** — the estimate assumes a desktop GPU and would need a
real capture before any claim.

Recommendation: **require WebGPU for friends now**; keep the WebGL2 path as a
later, separately costed task if the support numbers (≈ 88 % full+partial) are
not good enough. The cheaper immediate win is fixing the origin problem (§3.2),
which blocks 100 % of LAN friends regardless of renderer.

---

## 8. Two cheapest paths to "friends can play"

1. **Require a WebGPU browser and serve over HTTPS** (recommended).
   Edge/Chrome/Brave 113+ on Windows/macOS, Firefox 141+ on Windows, Safari 26+
   on macOS 26 / iOS 26. Add `--host`/reverse-proxy support, `wss://` for the
   room, and a trusted certificate (mkcert CA installed on the friend's machine,
   or a real cert). Estimated work: half a day for the host/TLS setup plus the
   existing launcher, no renderer change.
2. **WebGL2 fallback** (~6.5 engineer-days) if the aim is old browsers on the
   same localhost/LAN-with-TLS origin. It does **not** replace path 1's HTTPS
   requirement, because `crypto.subtle` is still secure-context-only.

---

## 9. Verification and determinism

`probes/compat/tools/verify_compat.mjs` runs **637 checks** over the recorded
capability data, boot records, the requirement model, the vendor model and the
matrix. It covers, per measured browser: secure context, adapter presence and
identity, every required limit against both adapter and default-device values,
the hard-coded alignment, the real wasm compile/validate plus each required
feature, audio decode, WebSocket echo, storage, `crypto.subtle` known vector,
modules, WebGL2 fallback capability, boot tick/draws/console, screenshots, the
headed path, headless-without-flags, the LAN failure text, and the matrix rows.

Determinism: `build_matrix.mjs` builds the matrix twice and compares
`stableStringify` hashes; the verifier rebuilds it and compares the **bytes** of
`_work/compat/compat-matrix.json` and its hash file against the fresh
derivation. The matrix contains no timestamps and no unordered iteration.
Current hash:

```
sha256:d335086ba27b8e6f2a18212182dd2a2385fcb075ad2359150091d62da7b535f4
```

The matrix changes only when a recorded capability or a cited vendor fact
changes; re-running the probe rewrites the evidence and therefore the hash.

Limits of this record:

- One machine, one GPU (RTX 5080), one Windows build. No AMD/Intel GPU, no
  macOS, no iOS, no Android, no Linux was measured.
- Firefox and Safari are vendor-documented only; they are not installed here.
- Headless results are not a display-quality claim; the headed runs close that
  gap for Edge and Brave only.
- The WebGL2 cost is an estimate. No fallback is implemented and no fallback
  frame exists.
- The LAN result is measured on the same machine through its own LAN address;
  a second physical machine is not required for the secure-context rule (it is
  origin-based), but it is required to prove the firewall/`wss://` path.
