// The exact Electron build the output window was developed against, plus the
// SHA-256 of every release zip (shipped by the `electron` package). The backend
// bundle inlines this, so a packaged vspark can download that one runtime on
// first use and refuse anything whose checksum doesn't match.
module.exports = {
  version: require('electron/package.json').version,
  checksums: require('electron/checksums.json'),
};
