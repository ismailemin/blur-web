// Blur Web pack runtime server (generated bundle; Node only).
//
// Boot order:
//   1. read manifest.json and manifest.sha256;
//   2. verify the manifest hash;
//   3. verify every listed file's size and SHA-256;
//   4. only then listen and start the optional room service.
//
// A missing/edited file is a typed boot failure (exit 3) and no HTTP port is
// opened. Requests for files that are not in the manifest return 404 with
// PACK_NOT_IN_MANIFEST; the server never falls back to another file.
//
// Usage:
//   node server.mjs [--port 8830] [--host 127.0.0.1] [--room-port 8811]
//                   [--no-room] [--quiet]
//
// `--host 0.0.0.0` enables LAN play. The page's default room URL is
// ws://<page-host>:8811/ws; pass `?mpServer=ws://host:port/ws` when the room
// port differs.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = 'blur-web.pack';
const HEALTH_SCHEMA = 'blur-web.pack.health/1';
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.fields': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.levelphysics': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function parseArgs(argv) {
  const options = {
    port: 8830,
    host: '127.0.0.1',
    roomPort: 8811,
    room: true,
    quiet: false
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    const value = () => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= argv.length) fail('PACK_USAGE', name + ' needs a value');
      return argv[index];
    };
    if (name === '--port') options.port = Number(value());
    else if (name === '--room-port') options.roomPort = Number(value());
    else if (name === '--host') options.host = value();
    else if (name === '--no-room') options.room = false;
    else if (name === '--with-room') options.room = true;
    else if (name === '--quiet') options.quiet = true;
    else if (name === '--help' || name === '-h') {
      console.log('node server.mjs [--port 8830] [--host 127.0.0.1] [--room-port 8811] [--no-room] [--quiet]');
      process.exit(0);
    } else fail('PACK_USAGE', 'unknown argument ' + name);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    fail('PACK_USAGE', '--port must be 1..65535');
  }
  if (!Number.isInteger(options.roomPort) || options.roomPort < 1 || options.roomPort > 65535) {
    fail('PACK_USAGE', '--room-port must be 1..65535');
  }
  return options;
}

function fail(code, message, detail = null) {
  console.error('PACK BOOT FAILED');
  console.error('code: ' + code);
  console.error('message: ' + message);
  if (detail) console.error(detail);
  process.exit(code === 'PACK_USAGE' ? 2 : 3);
}

function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256FileSync(file, chunk = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file, { highWaterMark: chunk });
    stream.on('data', (block) => digest.update(block));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

function safeResolve(base, relative) {
  const normalized = String(relative).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const resolved = path.resolve(base, ...normalized.split('/'));
  const root = path.resolve(base);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

function readManifest() {
  const manifestFile = path.join(ROOT, 'manifest.json');
  const digestFile = path.join(ROOT, 'manifest.sha256');
  if (!existsSync(manifestFile)) fail('PACK_MANIFEST_MISSING', 'manifest.json is missing');
  if (!existsSync(digestFile)) fail('PACK_MANIFEST_HASH', 'manifest.sha256 is missing');
  const bytes = readFileSync(manifestFile);
  const expectedLine = readFileSync(digestFile, 'utf8').trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expectedLine)) {
    fail('PACK_MANIFEST_HASH', 'manifest.sha256 does not contain a SHA-256 hex digest');
  }
  const actual = sha256Bytes(bytes);
  if (actual !== expectedLine) {
    fail('PACK_MANIFEST_HASH', 'manifest.json does not match manifest.sha256',
      '  expected ' + expectedLine + '\n  actual   ' + actual);
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('PACK_MANIFEST_SCHEMA', 'manifest.json is not JSON: ' + error.message);
  }
  if (manifest?.schema !== SCHEMA || manifest?.schemaVersion !== 1 ||
      !Array.isArray(manifest?.files) || typeof manifest?.contentRoot !== 'string' ||
      !manifest?.counts || !manifest?.totals) {
    fail('PACK_MANIFEST_SCHEMA', 'manifest.json is not a ' + SCHEMA + '/1 document');
  }
  return { manifest, manifestSha: actual, manifestBytes: bytes.length };
}

async function verifyEntries(manifest, manifestSha) {
  const contentRoot = manifest.target === 'dev'
    ? path.resolve(ROOT, manifest.contentRoot)
    : safeResolve(ROOT, manifest.contentRoot);
  if (!contentRoot) {
    fail('PACK_INTEGRITY_PATH', 'manifest.contentRoot escapes the bundle: ' + manifest.contentRoot);
  }
  const missing = [];
  const corrupt = [];
  let verifiedBytes = 0;
  const urls = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.bytes !== 'number' ||
        typeof entry.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.sha256)) {
      corrupt.push({ path: String(entry?.path), code: 'PACK_INTEGRITY_SCHEMA', expected: null, actual: null });
      continue;
    }
    const base = entry.kind === 'control' ? ROOT : contentRoot;
    const file = safeResolve(base, entry.path);
    if (!file) {
      corrupt.push({ path: entry.path, code: 'PACK_INTEGRITY_PATH', expected: null, actual: null });
      continue;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      missing.push({ path: entry.path, expectedBytes: entry.bytes, expected: entry.sha256 });
      continue;
    }
    const actualBytes = statSync(file).size;
    if (actualBytes !== entry.bytes) {
      corrupt.push({ path: entry.path, code: 'PACK_INTEGRITY_SIZE',
        expected: 'size ' + entry.bytes, actual: 'size ' + actualBytes });
      continue;
    }
    const actual = 'sha256:' + await sha256FileSync(file);
    if (actual !== entry.sha256) {
      corrupt.push({ path: entry.path, code: 'PACK_INTEGRITY_SHA256',
        expected: entry.sha256, actual });
      continue;
    }
    verifiedBytes += actualBytes;
    if (typeof entry.url === 'string') {
      if (urls.has(entry.url)) {
        corrupt.push({ path: entry.path, code: 'PACK_INTEGRITY_DUPLICATE_URL',
          expected: entry.url, actual: urls.get(entry.url).path });
        continue;
      }
      urls.set(entry.url, { ...entry, file });
    }
  }
  if (missing.length || corrupt.length) {
    const lines = [];
    lines.push('manifest: sha256:' + manifestSha);
    lines.push('missing: ' + missing.length);
    lines.push('corrupt: ' + corrupt.length);
    for (const row of missing.slice(0, 50)) {
      lines.push('  missing ' + row.path + ' expected ' + row.expectedBytes + ' B ' + row.expected);
    }
    for (const row of corrupt.slice(0, 50)) {
      lines.push('  corrupt ' + row.path + ' ' + row.code + ' expected=' + row.expected + ' actual=' + row.actual);
    }
    if (missing.length + corrupt.length > 100) lines.push('  ... output truncated at 100 entries');
    const code = missing.length ? 'PACK_INTEGRITY_MISSING' : corrupt[0].code;
    fail(code, 'the bundle does not match its manifest', lines.join('\n'));
  }
  if (verifiedBytes !== manifest.totals.bytes) {
    fail('PACK_INTEGRITY_SIZE',
      'verified bytes do not match manifest.totals.bytes',
      '  expected ' + manifest.totals.bytes + '\n  actual   ' + verifiedBytes);
  }
  if (manifest.files.length !== manifest.counts.files) {
    fail('PACK_INTEGRITY_COUNT',
      'manifest.files length does not match manifest.counts.files',
      '  expected ' + manifest.counts.files + '\n  actual   ' + manifest.files.length);
  }
  if (urls.size + manifest.files.filter((entry) => entry.kind === 'control').length !== manifest.files.length) {
    fail('PACK_INTEGRITY_COUNT', 'not every non-control manifest entry has a unique URL');
  }
  return { urls, verifiedBytes };
}

function sendText(response, status, text, extra = {}) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra
  });
  response.end(text);
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { manifest, manifestSha, manifestBytes } = readManifest();
  const { urls, verifiedBytes } = await verifyEntries(manifest, manifestSha);

  let room = null;
  let closing = false;

  const server = createServer((request, response) => {
    const started = Date.now();
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/_pack/health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          sendJson(response, 405, { ok: false, code: 'PACK_METHOD' });
          return;
        }
        sendJson(response, 200, {
          schema: HEALTH_SCHEMA,
          status: 'ok',
          target: manifest.target,
          packVersion: manifest.packVersion,
          buildStamp: manifest.buildStamp,
          manifestSha256: 'sha256:' + manifestSha,
          manifestBytes,
          files: manifest.counts.files,
          bytes: manifest.counts.bytes,
          verifiedBytes,
          verifiedAt: new Date().toISOString(),
          uptimeMs: Date.now() - STARTED_AT,
          room: room ? { enabled: true, wsUrl: room.wsUrl, port: room.port } : { enabled: false }
        });
        return;
      }
      const key = pathname === '/index.html' ? '/' : pathname;
      const entry = urls.get(key);
      if (!entry) {
        sendText(response, 404,
          'PACK_NOT_IN_MANIFEST: ' + pathname + '\n' +
          'This pack serves only files listed in manifest.json; there is no fallback.\n');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(response, 405, 'PACK_METHOD: GET/HEAD only\n', { allow: 'GET, HEAD' });
        return;
      }
      if (!existsSync(entry.file) || !statSync(entry.file).isFile()) {
        sendText(response, 500, 'PACK_FILE_VANISHED: ' + pathname + '\n');
        return;
      }
      const size = statSync(entry.file).size;
      const type = MIME[path.extname(entry.file).toLowerCase()] ?? 'application/octet-stream';
      response.writeHead(200, {
        'content-type': type,
        'content-length': size,
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'x-content-type-options': 'nosniff',
        'x-pack-build-stamp': manifest.buildStamp
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(entry.file).pipe(response);
      if (!options.quiet) {
        console.log('[pack] ' + request.method + ' ' + pathname + ' ' + size + ' B ' +
          (Date.now() - started) + ' ms');
      }
    } catch (error) {
      sendText(response, 500, 'PACK_SERVER_ERROR: ' + String(error?.message || error) + '\n');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(error));
    server.listen(options.port, options.host, resolve);
  });
  const actualPort = server.address().port;

  if (options.room) {
    const entry = urls.get('/net-mvp/server.mjs');
    if (!entry) {
      fail('PACK_ROOM_MISSING', '/net-mvp/server.mjs is not in the manifest');
    }
    let module;
    try {
      module = await import(pathToFileURL(entry.file).href);
    } catch (error) {
      fail('PACK_ROOM_IMPORT', 'cannot import the bundled room service: ' + error.message);
    }
    try {
      room = await module.startRoomServer({
        port: options.roomPort,
        host: options.host,
        log: options.quiet ? () => {} : (event) => console.log('[room] ' + JSON.stringify(event))
      });
    } catch (error) {
      fail('PACK_ROOM_START', 'cannot start the bundled room service: ' + error.message);
    }
  }

  const origin = 'http://' + (options.host === '0.0.0.0' ? '127.0.0.1' : options.host) + ':' + actualPort;
  console.log('PACK BOOT OK');
  console.log('  target         ' + manifest.target);
  console.log('  packVersion    ' + manifest.packVersion);
  console.log('  buildStamp     ' + manifest.buildStamp);
  console.log('  manifest       sha256:' + manifestSha);
  console.log('  verified       ' + manifest.counts.files + ' files / ' + verifiedBytes + ' B');
  console.log('  game           ' + origin + '/');
  if (room) {
    console.log('  room           ' + room.wsUrl);
    console.log('  mp host        ' + origin + '/?mp=1&host=1');
    console.log('  mp guest       ' + origin + '/?mp=1&room=<CODE>');
    if (options.roomPort !== 8811) {
      console.log('  note           page default room port is 8811; append &mpServer=ws://<host>:' +
        options.roomPort + '/ws');
    }
  } else {
    console.log('  room           disabled (--no-room)');
  }
  console.log('  stop           Ctrl+C');

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await room?.close(); } catch { /* best effort */ }
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  fail('PACK_NODE_VERSION', 'Node.js 18 or newer is required (found ' + process.versions.node + ')');
}

main().catch((error) => {
  fail('PACK_BOOT_ERROR', String(error?.stack || error));
});
