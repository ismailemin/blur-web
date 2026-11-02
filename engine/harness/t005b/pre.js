// Node harness driver for the T-005b file-layer spike.
//
// Installs exactly one range source over the real installed PAK and hands its
// size to the module, mirroring what a browser host does with a user-selected
// File or an OPFS handle:
//
//   node out/webfile_harness.js <path-to-pak>
//
// The source never loads the file. fs.readSync(fd, ..., position) is the node
// equivalent of FileSystemSyncAccessHandle.read(buffer, {at}); that is the only
// browser API with the same shape (t005-streaming-design.md 3.3), which is why
// it is the one used here. A Blob/File or an HTTP range source has no
// synchronous read, so it would register readAsync only - the engine would then
// refuse every I_File::Read instead of guessing (see web_file_source.js).
(function () {
  if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
    throw new Error('this harness is node-only');
  }

  var fs = require('fs');
  var pakPath = process.argv[2];
  if (!pakPath) {
    console.error('[harness] usage: node webfile_harness.js <path-to-pak>');
    process.exit(2);
  }

  var fd;
  var size;
  try {
    fd = fs.openSync(pakPath, 'r');
    size = fs.fstatSync(fd).size;
  } catch (error) {
    console.error('[harness] cannot open the range source ' + pakPath + ': ' + error.message);
    process.exit(2);
  }

  Module['webFileSources'] = {};

  // blob: - a File/Blob the user selected. Here: the installed PAK, read
  // through the fd, never copied into memory as a whole.
  Module['webFileSources']['blob:root.pak'] = {
    size: size,
    identity: 'node-fd:' + pakPath,
    readSync: function (offset, length) {
      var buffer = Buffer.allocUnsafe(length);
      var got = fs.readSync(fd, buffer, 0, length, offset);
      if (got !== length) {
        // The engine treats a short read as a hard failure; say why here.
        throw new Error('short read at offset ' + offset + ': ' + got + '/' + length);
      }
      return buffer;
    },
    readAsync: function (offset, length) {
      var buffer = Buffer.allocUnsafe(length);
      return new Promise(function (resolve, reject) {
        fs.read(fd, buffer, 0, length, offset, function (error, got) {
          if (error) { reject(error); return; }
          if (got !== length) { reject(new Error('short read')); return; }
          resolve(buffer);
        });
      });
    }
  };

  // http: - a network range source: asynchronous only, no synchronous store.
  // This is the contract probe for "a source without readSync can never answer
  // I_File::Read". Its 1 KiB size is a fixture, not data.
  Module['webFileSources']['http:async-only'] = {
    size: 1024,
    identity: 'async-only-fixture',
    readAsync: function (offset, length) {
      return Promise.resolve(new Uint8Array(length));
    }
  };

  process.on('exit', function (code) {
    if (typeof Module['webFileSummary'] === 'function') {
      Module['webFileSummary']();
    }
    try {
      fs.closeSync(fd);
    } catch (error) {
      // nothing to do at exit
    }
    if (code !== 0) {
      console.error('[harness] exit code ' + code);
    }
  });
})();
