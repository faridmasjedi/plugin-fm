'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:net');
const helpers = require('../src/app');

test('finds a free port after a busy one', async () => {
  const busy = createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const taken = busy.address().port;
  const port = await helpers.freePort(taken, 5);
  assert.notStrictEqual(port, taken);
  busy.close();
});

test('keeps only the local app inside the window', () => {
  assert.ok(helpers.isAppUrl('http://127.0.0.1:7007/studio/', 7007));
  assert.ok(!helpers.isAppUrl('http://127.0.0.1:7008/', 7007));
  assert.ok(!helpers.isAppUrl('https://openrouter.ai/auth', 7007));
  assert.ok(!helpers.isAppUrl('javascript:alert(1)', 7007));
});

test('reads the login shell PATH', () => {
  if (process.platform !== 'win32') assert.match(helpers.shellPath(), /\/usr\/bin/);
});
