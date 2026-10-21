const path = require('node:path');

// The Electron main process points these at the user's application data
// folder. Plain `node server.js` keeps using the project folders.
const PROJECT_DIR = path.join(__dirname, '..');

function directoryFromEnv(name, fallback) {
  const value = process.env[name];

  return value && value.trim() ? path.resolve(value) : fallback;
}

const DATA_DIR = directoryFromEnv(
  'MY_ALBUM_DATA_DIR',
  path.join(PROJECT_DIR, 'data')
);
const CACHE_DIR = directoryFromEnv(
  'MY_ALBUM_CACHE_DIR',
  path.join(PROJECT_DIR, 'cache')
);
const DEFAULT_PHOTOS_DIR = directoryFromEnv(
  'MY_ALBUM_DEFAULT_PHOTOS',
  path.join(PROJECT_DIR, 'photos')
);

module.exports = {
  PROJECT_DIR,
  DATA_DIR,
  CACHE_DIR,
  DEFAULT_PHOTOS_DIR,
};
