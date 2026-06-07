'use strict';

// Orchestrates the whole flow:
//   1. parse `key=value` CLI args (e.g. `babadag-stat username=.. password=..`)
//   2. on the first run (or with --refresh) log in + pull the flight history ONCE
//   3. cache the JSON into ./data (git-ignored — it's your personal data)
//   4. start the local backend that serves the SPA report + relays the JSON
//   5. open the report in the browser
// Once the JSON is cached, re-running with no credentials just re-opens the report.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { login, fetchFlightHistory } = require('./api');
const { startServer } = require('./server');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(DATA_DIR, 'flight-history.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const DEFAULT_PORT = 4317;
// Wide enough to cover all real history (the API caps nothing here).
const HISTORY_START = '2010-01-01';

/** Parse `key=value`, `--key=value` and bare `--flag` arguments. */
function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv) {
    const m = raw.match(/^(?:--)?([A-Za-z0-9_-]+)=(.*)$/);
    if (m) {
      args[m[1].toLowerCase()] = m[2];
    } else if (raw.startsWith('--')) {
      args[raw.slice(2).toLowerCase()] = true;
    } else {
      args._.push(raw);
    }
  }
  return args;
}

function pick(args, ...keys) {
  for (const k of keys) {
    if (args[k] !== undefined && args[k] !== '') return args[k];
  }
  return undefined;
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let cmdArgs;
  if (platform === 'darwin') {
    cmd = 'open';
    cmdArgs = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    cmdArgs = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    cmdArgs = [url];
  }
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
  } catch (_) {
    /* best effort only */
  }
}

function printUsage() {
  console.log(
    [
      '',
      'babadag-stat — your personal Babadag/Fethiye paragliding stats',
      '',
      'Usage:',
      '  babadag-stat username=<e-mail> password=<password> [options]   (first run)',
      '  babadag-stat                       (re-open from saved data — no login needed)',
      '',
      'Options:',
      '  start=<YYYY-MM-DD>   history start date  (default ' + HISTORY_START + ')',
      '  end=<YYYY-MM-DD>     history end date    (default end of next year)',
      '  port=<number>        local server port   (default ' + DEFAULT_PORT + ')',
      '  --refresh            re-download even though data is already saved',
      '  --no-open            do not open a browser automatically',
      '  --no-serve           only fetch + cache the JSON, then exit',
      '  --help               show this help',
      '',
    ].join('\n')
  );
}

function quickSummary(flights) {
  const years = {};
  for (const f of flights) {
    const y = String(f.date || '').split('-')[2];
    if (y) years[y] = (years[y] || 0) + 1;
  }
  const ordered = Object.keys(years)
    .sort()
    .map((y) => `${y}:${years[y]}`)
    .join('  ');
  return ordered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const username = pick(args, 'username', 'user', 'u', 'email') || process.env.SHM_USERNAME;
  const password = pick(args, 'password', 'pass', 'p') || process.env.SHM_PASSWORD;
  const port = Number(pick(args, 'port') || process.env.PORT || DEFAULT_PORT);

  const haveCreds = Boolean(username && password);
  const haveCache = fs.existsSync(DATA_FILE);

  // Cached JSON takes precedence: the network call (which needs your e-mail +
  // password) only runs on the very first run, or when you ask to --refresh.
  // So once the data is saved, you can re-open the report without credentials.
  const shouldFetch = Boolean(args.refresh) || !haveCache;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (shouldFetch) {
    if (!haveCreds) {
      console.error(
        haveCache
          ? '✗ --refresh needs username=<e-mail> and password=<password>.'
          : '✗ No saved data yet — run once with username=<e-mail> and password=<password>.'
      );
      printUsage();
      process.exit(1);
    }

    const startDate = pick(args, 'start') || HISTORY_START;
    const endDate = pick(args, 'end') || `${new Date().getFullYear() + 1}-12-31`;

    console.log(`→ Logging in as ${username} …`);
    const token = await login(username, password);

    console.log(`→ Fetching flight history (${startDate} … ${endDate}) …`);
    const flights = await fetchFlightHistory(token, startDate, endDate);

    fs.writeFileSync(DATA_FILE, JSON.stringify(flights, null, 2));
    const meta = {
      fetchedAt: new Date().toISOString(),
      source: 'GET /api/Single/GetFlightHistory',
      startDate,
      endDate,
      count: flights.length,
      pilot: flights.find((f) => f && f.pilotName)?.pilotName || null,
    };
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

    console.log(`✓ Saved ${flights.length} flights → ${path.relative(ROOT, DATA_FILE)}`);
    const summary = quickSummary(flights);
    if (summary) console.log(`  Flights per year:  ${summary}`);
  } else {
    console.log(`→ Using saved data (${path.relative(ROOT, DATA_FILE)}).`);
    if (haveCreds) {
      console.log('  (Pass --refresh to download the latest flights again.)');
    }
  }

  if (args['no-serve']) return;

  const { server, port: actualPort } = await startServer({
    port,
    publicDir: PUBLIC_DIR,
    dataFile: DATA_FILE,
    metaFile: META_FILE,
  });

  const url = `http://localhost:${actualPort}/`;
  console.log('');
  console.log(`✓ Stats report is live at  ${url}`);
  console.log('  Press Ctrl+C to stop the server.');

  if (!args['no-open']) openBrowser(url);

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { main, parseArgs };
