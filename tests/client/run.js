'use strict';
// Runs every *.test.js file in this folder with Node's built-in test runner.
// (Listing the files ourselves works the same on every Node version and on Windows.)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join(__dirname, name));

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);