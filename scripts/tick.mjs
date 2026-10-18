#!/usr/bin/env node
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log('Usage: node scripts/tick.mjs [--url ORIGIN]\nReads INTERNAL_TICK_TOKEN and MEDIAPACK_URL (default http://localhost:3000). Performs one bounded recovery tick. Schedule once per minute.');
} else {
  try {
    const url = new URL(values.url ?? process.env.MEDIAPACK_URL ?? 'http://localhost:3000');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('--url must be an HTTP(S) origin without credentials or path.');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote tick requires HTTPS.');
    const token = process.env.INTERNAL_TICK_TOKEN;
    if (!token) throw new Error('Set INTERNAL_TICK_TOKEN in the calling environment; do not pass it as a command argument.');
    const response = await fetch(new URL('/internal/tick', url), { method: 'POST', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(55_000) });
    if (!response.ok) throw new Error(`Recovery tick failed (HTTP ${response.status}); check the server token and logs.`);
    console.log(JSON.stringify(await response.json(), null, 2));
  } catch (error) { console.error(`mediapack tick: ${error.message}`); process.exitCode = 1; }
}
