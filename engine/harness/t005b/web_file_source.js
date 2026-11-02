// platform/file for wasm32 - the imported JS side of PlatformFileWeb.h.
//
// This file is a *provider registry*, not a file system: it knows sources, never
// engine paths. C_WebFileSystem owns the path -> source table.
//
// A source is registered by the host under an opaque id and must look like:
//
//   {
//     size:     <safe integer>,
//     identity: <string>,                          // content identity (risk R6)
//     readSync: function (offset, length) -> bytes // exact length or throw
//     readAsync: function (offset, length) -> Promise<bytes>   // optional
//   }
//
// readSync is only required for sources that genuinely have a synchronous
// store: FileSystemSyncAccessHandle in a dedicated worker, or an already
// resident block. A Blob/File or an HTTP range source has no synchronous read
// (t005-streaming-design.md 3.1), so it registers readAsync only and every
// I_File::Read that lands on it fails explicitly. There is no fallback: JS is
// never allowed to pump the event loop inside a read (risk R3).
//
// Dual-side range validation (design 3.2). Every request is checked here before
// it reaches the source, and a source that returns the wrong length is rejected
// too. A rejected request writes one stderr line with the offending offset,
// length and source size, and returns 0. The engine then sees a failed
// Underflow, not a short read and never a zero fill.
//
// This module does not own the buffer: bytes are copied into the wasm linear
// address C++ passes, and HEAPU8 is dereferenced on every call because memory
// growth detaches cached views (risk R2).

mergeInto(LibraryManager.library, {

  $WEB_FILE__deps: [],
  $WEB_FILE: {
    abi: 1,
    handles: [],
    stats: {
      open: 0,
      close: 0,
      read: 0,
      readBytes: 0,
      largestRequest: 0,
      write: 0,
      enqueue: 0,
      exists: 0,
      failures: 0
    },
    failure: function (op, detail) {
      WEB_FILE.stats.failures++;
      err('[platform/file] ' + op + ' REJECTED ' + detail + '\n');
    },
    source: function (id) {
      var table = Module['webFileSources'];
      if (!table || typeof table !== 'object') {
        return null;
      }
      var source = table[id];
      return (source && typeof source === 'object') ? source : null;
    },
    handle: function (value) {
      if (!value || value < 1 || value > WEB_FILE.handles.length) {
        return null;
      }
      return WEB_FILE.handles[value - 1];
    },
    validate: function (op, handle, source, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        WEB_FILE.failure(op, 'handle=' + handle + ' offset=' + String(offset) +
          ' reason=offset is not a non-negative safe integer');
        return false;
      }
      if (!Number.isSafeInteger(length) || length < 1) {
        WEB_FILE.failure(op, 'handle=' + handle + ' offset=' + String(offset) +
          ' length=' + String(length) + ' reason=length is not a positive safe integer');
        return false;
      }
      if (offset > source.size) {
        WEB_FILE.failure(op, 'handle=' + handle + ' offset=' + String(offset) +
          ' length=' + String(length) + ' size=' + String(source.size) +
          ' reason=offset is past the end of the source');
        return false;
      }
      if (length > source.size - offset) {
        WEB_FILE.failure(op, 'handle=' + handle + ' offset=' + String(offset) +
          ' length=' + String(length) + ' size=' + String(source.size) +
          ' reason=range crosses the end of the source (' + (source.size - offset) +
          ' bytes available)');
        return false;
      }
      return true;
    }
  },

  $WEB_FILE__postset: 'Module["webFileStats"] = WEB_FILE.stats;' +
    'Module["webFileSummary"] = function () {' +
    '  var live = 0;' +
    '  for (var i = 0; i < WEB_FILE.handles.length; i++) { if (WEB_FILE.handles[i]) live++; }' +
    '  err("[platform/file] summary abi=" + WEB_FILE.abi +' +
    '      " open=" + WEB_FILE.stats.open +' +
    '      " close=" + WEB_FILE.stats.close +' +
    '      " read=" + WEB_FILE.stats.read +' +
    '      " readBytes=" + WEB_FILE.stats.readBytes +' +
    '      " largestRequest=" + WEB_FILE.stats.largestRequest +' +
    '      " writeRefused=" + WEB_FILE.stats.write +' +
    '      " enqueueRefused=" + WEB_FILE.stats.enqueue +' +
    '      " exists=" + WEB_FILE.stats.exists +' +
    '      " failures=" + WEB_FILE.stats.failures +' +
    '      " liveHandles=" + live + "\\n");' +
    '};',

  pf_abi_version__deps: ['$WEB_FILE'],
  pf_abi_version: function () {
    return WEB_FILE.abi;
  },

  pf_open__deps: ['$WEB_FILE'],
  pf_open: function (sourceIdPtr, access) {
    var id = UTF8ToString(sourceIdPtr);
    var source = WEB_FILE.source(id);
    if (!source) {
      WEB_FILE.failure('pf_open', 'source="' + id + '" reason=no such source is installed');
      return 0;
    }
    if (access !== 1) {
      WEB_FILE.failure('pf_open', 'source="' + id + '" access=' + access +
        ' reason=only PF_ACCESS_READ is implemented (the save path is a separate slice)');
      return 0;
    }
    if (!Number.isSafeInteger(source.size) || source.size < 0) {
      WEB_FILE.failure('pf_open', 'source="' + id + '" reason=source size is not a non-negative safe integer');
      return 0;
    }
    if (typeof source.readSync !== 'function' && typeof source.readAsync !== 'function') {
      WEB_FILE.failure('pf_open', 'source="' + id + '" reason=source provides neither readSync nor readAsync');
      return 0;
    }
    var handle = WEB_FILE.handles.length + 1;
    WEB_FILE.handles.push({ id: id, source: source, access: access });
    WEB_FILE.stats.open++;
    return handle;
  },

  pf_size__deps: ['$WEB_FILE'],
  pf_size: function (handle) {
    var entry = WEB_FILE.handle(handle);
    if (!entry) {
      WEB_FILE.failure('pf_size', 'handle=' + handle + ' reason=invalid handle');
      return BigInt(0);
    }
    return BigInt(entry.source.size);
  },

  pf_read_at__deps: ['$WEB_FILE'],
  pf_read_at: function (handle, offset, dst, bytes) {
    var entry = WEB_FILE.handle(handle);
    if (!entry) {
      WEB_FILE.failure('pf_read_at', 'handle=' + handle + ' reason=invalid handle');
      return 0;
    }
    var at = Number(offset);
    if (!WEB_FILE.validate('pf_read_at', handle, entry.source, at, bytes)) {
      return 0;
    }
    if (typeof entry.source.readSync !== 'function') {
      WEB_FILE.failure('pf_read_at', 'handle=' + handle + ' source="' + entry.id + '" offset=' + at +
        ' length=' + bytes + ' size=' + entry.source.size +
        ' reason=source has no synchronous store; stage it into OPFS first');
      return 0;
    }
    var chunk;
    try {
      chunk = entry.source.readSync(at, bytes);
    } catch (error) {
      WEB_FILE.failure('pf_read_at', 'handle=' + handle + ' source="' + entry.id + '" offset=' + at +
        ' length=' + bytes + ' reason=readSync threw: ' + String(error && error.message ? error.message : error));
      return 0;
    }
    if (!chunk || chunk.length !== bytes) {
      WEB_FILE.failure('pf_read_at', 'handle=' + handle + ' source="' + entry.id + '" offset=' + at +
        ' length=' + bytes + ' reason=readSync returned ' +
        (chunk ? chunk.length : 'nothing') + ' bytes');
      return 0;
    }
    HEAPU8.set(chunk, dst);
    WEB_FILE.stats.read++;
    WEB_FILE.stats.readBytes += bytes;
    if (bytes > WEB_FILE.stats.largestRequest) {
      WEB_FILE.stats.largestRequest = bytes;
    }
    return bytes;
  },

  pf_write_at__deps: ['$WEB_FILE'],
  pf_write_at: function (handle, offset, src, bytes) {
    WEB_FILE.stats.write++;
    WEB_FILE.failure('pf_write_at', 'handle=' + handle + ' offset=' + String(offset) +
      ' length=' + bytes + ' reason=the write path is not implemented in this slice');
    return 0;
  },

  pf_close__deps: ['$WEB_FILE'],
  pf_close: function (handle) {
    var entry = WEB_FILE.handle(handle);
    if (!entry) {
      WEB_FILE.failure('pf_close', 'handle=' + handle + ' reason=invalid handle');
      return;
    }
    WEB_FILE.handles[handle - 1] = null;
    WEB_FILE.stats.close++;
  },

  pf_exists__deps: ['$WEB_FILE'],
  pf_exists: function (sourceIdPtr) {
    var id = UTF8ToString(sourceIdPtr);
    var source = WEB_FILE.source(id);
    WEB_FILE.stats.exists++;
    return source ? 1 : 0;
  },

  pf_enqueue_read__deps: ['$WEB_FILE'],
  pf_enqueue_read: function (handle, offset, bytes, dstAddr) {
    WEB_FILE.stats.enqueue++;
    WEB_FILE.failure('pf_enqueue_read', 'handle=' + handle + ' offset=' + String(offset) +
      ' length=' + bytes + ' dst=' + dstAddr +
      ' reason=no completion pump exists in this build; the streamer owns the queue (T-005c)');
    return -1;
  }
});
