// Resolved from Node (the backend), not from Electron: requiring the `electron`
// package outside Electron yields the path to its binary.
const path = require('node:path');

module.exports = {
  electronPath: require('electron'),
  mainScript: path.join(__dirname, 'main.cjs'),
};
