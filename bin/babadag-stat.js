#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main().catch((err) => {
  console.error('\n✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
