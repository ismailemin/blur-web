// Node driver for the T-005e level-streaming harness.
//
//   node stream_harness.js <levelrender> <levelstream> <levelphysics> <chunks.tsv>
//
// Registers one synchronous range source per installed level file, the same
// shape as a browser FileSystemSyncAccessHandle: fs.readSync(fd, ..., position).
// The engine never sees these paths; C_WebFileSystem::Mount maps its virtual
// paths to the opaque source ids below (see engine/harness/t005b/
// web_file_source.js for the platform/file provider and its range validation).
(function () {
  if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
    throw new Error('this harness is node-only');
  }

  var fs = require('fs');
  var names = ['levelrender', 'levelstream', 'levelphysics'];
  var fds = {};

  if (process.argv.length < 5) {
    console.error('[harness] usage: node stream_harness.js <levelrender> <levelstream> <levelphysics> <chunks.tsv>');
    process.exit(2);
  }

  Module['webFileSources'] = {};

  for (var i = 0; i < names.length; ++i) {
    var path = process.argv[2 + i];
    var fd;
    var size;
    try {
      fd = fs.openSync(path, 'r');
      size = fs.fstatSync(fd).size;
    } catch (error) {
      console.error('[harness] cannot open the range source ' + path + ': ' + error.message);
      process.exit(2);
    }
    fds[names[i]] = fd;
    Module['webFileSources']['blob:' + names[i]] = (function (fd, size, path) {
      return {
        size: size,
        identity: 'node-fd:' + path,
        readSync: function (offset, length) {
          var buffer = Buffer.allocUnsafe(length);
          var got = fs.readSync(fd, buffer, 0, length, offset);
          if (got !== length) {
            throw new Error('short read at offset ' + offset + ': ' + got + '/' + length);
          }
          return buffer;
        }
      };
    })(fd, size, path);
  }

  process.on('exit', function (code) {
    if (typeof Module['webFileSummary'] === 'function') {
      Module['webFileSummary']();
    }
    for (var key in fds) {
      try { fs.closeSync(fds[key]); } catch (error) { /* nothing */ }
    }
    if (code !== 0) {
      console.error('[harness] exit code ' + code);
    }
  });
})();
