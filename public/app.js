'use strict';

// Babadag flight-stats SPA. Loads the locally-relayed JSON once, then does all
// aggregation client-side. No build step, no dependencies.

const $ = (sel) => document.querySelector(sel);

const state = {
  flights: [], // normalized + sorted ascending by iso date
  // Drill-down zoom for the histogram. 'years' shows every year; clicking a
  // year zooms to its 12 months; clicking a month zooms to that month's days.
  zoom: { level: 'years', year: null, month: null },
  // Optional landing-outcome filter applied to the flights table.
  landingFilter: null, // null | 'reliable' | 'reserve' | 'unknown' | 'other'
};

/* ----------------------------- data loading ----------------------------- */

async function loadData() {
  const [flightsRes, metaRes] = await Promise.all([
    fetch('/api/flights'),
    fetch('/api/meta').catch(() => null),
  ]);

  if (!flightsRes.ok) {
    throw new Error('Could not load flight data from the local server.');
  }
  const raw = await flightsRes.json();
  const meta = metaRes && metaRes.ok ? await metaRes.json().catch(() => null) : null;

  state.flights = normalize(raw);
  return meta;
}

// API `date` is "dd-MM-yyyy"; turn it into a sortable ISO string + parts.
function parseDMY(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split('-');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return { iso: `${y}-${mm}-${dd}`, year: y, month: mm };
}

// The API mixes Turkish and English launch-area names and "mt"/"m" units for
// the *same* physical area (e.g. "1700mt Pist", "1700mt Track" and "1700m
// Track" are all the 1700 m track). Fold them onto a single English label.
function normalizeArea(raw) {
  let s = (raw || '').trim();
  if (!s) return '(unspecified)';
  s = s.replace(/(\d)\s*mt\b/gi, '$1m'); // unit: "1700mt" -> "1700m"
  s = s.replace(/\bkuzey\b/gi, 'North'); // Turkish -> English
  s = s.replace(/\bpisti?\b/gi, 'Track'); // "Pist"/"Pisti" -> "Track"
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// `parachuteReliableLanding` is really a landing *type*. Besides the normal
// "reliable landing" (Turkish "Emniyetli iniş" / code "reliable_landing") it
// can record an emergency reserve-parachute throw ("Yedek Paraşüt Açılması" /
// "Reserve Chute Opening"). Classify it into an English category + label.
function classifyLanding(raw) {
  const s = (raw || '').trim();
  if (!s) return { type: 'unknown', label: '(unspecified)' };
  if (/(yedek|reserve|rezerv|backup|chute\s*open)/i.test(s)) {
    return { type: 'reserve', label: 'Reserve parachute deployment' };
  }
  if (/(emniyet|reliable|safe)/i.test(s)) {
    return { type: 'reliable', label: 'Reliable landing' };
  }
  return { type: 'other', label: s };
}

function normalize(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    const parsed = parseDMY(r.date);
    if (!parsed) continue;
    // A booked flight that never launched is stored with an empty
    // `actualStartArea` (and null time/landing). Treat it as "cancelled" so it
    // stays out of every takeoff figure while still being listed.
    const cancelled = !(r.actualStartArea || '').trim();
    const landing = cancelled
      ? { type: 'cancelled', label: 'Cancelled' }
      : classifyLanding(r.parachuteReliableLanding);
    out.push({
      iso: parsed.iso,
      year: parsed.year,
      month: parsed.month,
      cancelled,
      area: normalizeArea(r.actualStartArea),
      serial: (r.parachuteSerialNumber || '').trim(),
      pilot: r.pilotName || '',
      startTime: r.actualStartTime || '',
      landingType: landing.type,
      landingLabel: landing.label,
      passenger: (r.parachutePassengerName || '').trim(),
      country: (r.countryName || '').trim(),
    });
  }
  out.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  return out;
}

/* ------------------------------ filtering -------------------------------- */

function getRange() {
  const start = $('#start').value; // YYYY-MM-DD or ''
  const end = $('#end').value;
  return { start, end };
}

// Rows inside the master From/To range (the chart's "All years" overview).
function baseRows() {
  const { start, end } = getRange();
  return state.flights.filter((f) => (!start || f.iso >= start) && (!end || f.iso <= end));
}

// Rows after the current drill-down zoom is applied. The whole dashboard (KPIs,
// areas, landing outcomes, table) reflects this scope so zooming into a year or
// month focuses every panel, not just the chart.
function zoomedRows(rows) {
  const z = state.zoom;
  if (z.level === 'months') return rows.filter((f) => f.year === z.year);
  if (z.level === 'days') return rows.filter((f) => f.year === z.year && f.month === z.month);
  return rows;
}

/* ---------------------------- aggregation -------------------------------- */

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Build the ordered list of histogram bars for the current zoom level.
// Each bar carries the info needed to zoom one level deeper when clicked.
function histogram(baseScopedRows, zoomedScopedRows) {
  const z = state.zoom;

  if (z.level === 'years') {
    const counts = new Map();
    for (const f of zoomedScopedRows) counts.set(f.year, (counts.get(f.year) || 0) + 1);
    const years = [...new Set(baseScopedRows.map((f) => f.year))];
    if (!years.length) return [];
    const first = Math.min(...years);
    const last = Math.max(...years);
    const bars = [];
    for (let y = first; y <= last; y++) {
      bars.push({ count: counts.get(y) || 0, label: String(y), zoom: { level: 'months', year: y } });
    }
    return bars;
  }

  if (z.level === 'months') {
    const counts = new Map();
    for (const f of zoomedScopedRows) counts.set(f.month, (counts.get(f.month) || 0) + 1);
    const bars = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      bars.push({
        count: counts.get(mm) || 0,
        label: MONTH_ABBR[m - 1],
        zoom: { level: 'days', year: z.year, month: mm },
      });
    }
    return bars;
  }

  // days: every calendar day of the focused month (gives a calendar-like read).
  const counts = new Map();
  for (const f of zoomedScopedRows) counts.set(f.iso, (counts.get(f.iso) || 0) + 1);
  const daysInMonth = new Date(z.year, Number(z.month), 0).getDate();
  const bars = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dd = String(d).padStart(2, '0');
    const iso = `${z.year}-${z.month}-${dd}`;
    bars.push({ count: counts.get(iso) || 0, label: String(d), zoom: null });
  }
  return bars;
}

/* ------------------------------ rendering -------------------------------- */

function renderMeta(meta) {
  const flights = state.flights;
  const pilot = (meta && meta.pilot) || (flights[0] && flights[0].pilot) || '';
  if (pilot) $('#subtitle').textContent = `${pilot} — Fethiye / Ölüdeniz`;

  const lines = [];
  if (flights.length) {
    lines.push(`Range <strong>${flights[0].iso}</strong> → <strong>${flights[flights.length - 1].iso}</strong>`);
  }
  if (meta && meta.fetchedAt) {
    lines.push(`Fetched ${new Date(meta.fetchedAt).toLocaleString()}`);
  }
  $('#meta').innerHTML = lines.join('<br>');
}

function kpi(value, label, sub, mod) {
  return `<div class="kpi${mod ? ' ' + mod : ''}"><div class="value">${value}</div><div class="label">${label}</div>${
    sub ? `<div class="sub">${sub}</div>` : ''
  }</div>`;
}

function renderKPIs(takeoffRows, cancelledCount) {
  const takeoffs = takeoffRows.length;
  const reserve = takeoffRows.filter((r) => r.landingType === 'reserve').length;
  const reliable = takeoffRows.filter((r) => r.landingType === 'reliable').length;
  const years = new Set(takeoffRows.map((r) => r.year)).size;

  $('#kpis').innerHTML = [
    kpi(takeoffs, 'Takeoffs total'),
    kpi(cancelledCount, 'Cancelled', 'never launched', cancelledCount > 0 ? 'muted' : ''),
    kpi(reliable, 'Reliable landings'),
    kpi(reserve, 'Reserve deployments', 'backup parachute openings', reserve > 0 ? 'danger' : ''),
    kpi(years, 'Years active'),
  ].join('');
}

function renderBreadcrumb() {
  const z = state.zoom;
  const crumbs = [{ label: 'All years', target: { level: 'years', year: null, month: null }, active: z.level === 'years' }];
  if (z.year != null) {
    crumbs.push({ label: String(z.year), target: { level: 'months', year: z.year, month: null }, active: z.level === 'months' });
  }
  if (z.month != null) {
    crumbs.push({
      label: `${MONTH_ABBR[Number(z.month) - 1]} ${z.year}`,
      target: { level: 'days', year: z.year, month: z.month },
      active: z.level === 'days',
    });
  }

  $('#crumbs').innerHTML = crumbs
    .map((c, i) => {
      const sep = i > 0 ? '<span class="sep">›</span>' : '';
      if (c.active) return `${sep}<span class="crumb active">${c.label}</span>`;
      return `${sep}<button class="crumb" data-level="${c.target.level}" data-year="${c.target.year ?? ''}" data-month="${c.target.month ?? ''}">${c.label}</button>`;
    })
    .join('');
}

function renderChart(baseScopedRows, zoomedScopedRows) {
  const bars = histogram(baseScopedRows, zoomedScopedRows);
  const chart = $('#chart');
  const z = state.zoom;
  const canZoom = z.level !== 'days';

  if (!bars.length) {
    chart.innerHTML = '';
  } else {
    const max = Math.max(...bars.map((b) => b.count), 1);
    const usableHeight = 230; // px, leaves room for count + label
    chart.classList.toggle('dense', bars.length > 18);
    chart.classList.toggle('zoomable', canZoom);

    chart.innerHTML = bars
      .map((b) => {
        const h = b.count > 0 ? Math.max(3, Math.round((b.count / max) * usableHeight)) : 0;
        const zoomable = canZoom && b.zoom;
        const attrs = zoomable
          ? ` data-zlevel="${b.zoom.level}" data-zyear="${b.zoom.year}" data-zmonth="${b.zoom.month ?? ''}"`
          : '';
        const tip = zoomable ? `${b.label}: ${b.count} — click to zoom in` : `${b.label}: ${b.count}`;
        return (
          `<div class="bar-wrap${zoomable ? ' zoomable' : ''}"${attrs} title="${tip}">` +
          `<div class="bar-count ${b.count === 0 ? 'zero' : ''}">${b.count}</div>` +
          `<div class="bar" style="height:${h}px"></div>` +
          `<div class="bar-label">${b.label}</div>` +
          `</div>`
        );
      })
      .join('');
  }

  const total = zoomedScopedRows.length;
  const grp = z.level === 'years' ? 'year' : z.level === 'months' ? 'month' : 'day';
  $('#chartHint').textContent =
    `${total} takeoff${total === 1 ? '' : 's'} · by ${grp}` + (canZoom ? ' · click a bar to zoom in' : '');
}

const LANDING_ORDER = [
  { type: 'reliable', label: 'Reliable landing' },
  { type: 'reserve', label: 'Reserve parachute deployment' },
  { type: 'other', label: 'Other' },
  { type: 'unknown', label: '(unspecified)' },
];

function renderLanding(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.landingType, (counts.get(r.landingType) || 0) + 1);
  const list = LANDING_ORDER.filter((o) => counts.get(o.type));
  const max = list.reduce((mx, o) => Math.max(mx, counts.get(o.type)), 1);

  $('#landing').innerHTML = list.length
    ? list
        .map((o) => {
          const n = counts.get(o.type);
          const active = state.landingFilter === o.type ? ' active' : '';
          return (
            `<button class="row-h clickable landing-${o.type}${active}" data-ltype="${o.type}" title="Click to filter flights">` +
            `<span class="name">${o.label}</span>` +
            `<span class="track"><span class="fill" style="width:${Math.round((n / max) * 100)}%"></span></span>` +
            `<span class="n">${n}</span></button>`
          );
        })
        .join('')
    : '<p class="hint">No data in range.</p>';
}

function renderAreas(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.area, (counts.get(r.area) || 0) + 1);
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = list.length ? list[0][1] : 1;

  $('#areas').innerHTML = list.length
    ? list
        .map(
          ([name, n]) =>
            `<div class="row-h"><span class="name" title="${name}">${name}</span>` +
            `<span class="track"><span class="fill" style="width:${Math.round((n / max) * 100)}%"></span></span>` +
            `<span class="n">${n}</span></div>`
        )
        .join('')
    : '<p class="hint">No data in range.</p>';
}

function renderTable(rows) {
  const body = $('#flightsTable').querySelector('tbody');
  let shown = rows;
  if (state.landingFilter) shown = rows.filter((r) => r.landingType === state.landingFilter);
  const recent = [...shown].reverse(); // newest first

  body.innerHTML = recent
    .map((r) => {
      let landing;
      if (r.cancelled) landing = `<span class="badge muted">Cancelled</span>`;
      else if (r.landingType === 'reserve') landing = `<span class="badge danger">${r.landingLabel}</span>`;
      else landing = r.landingLabel === '(unspecified)' ? '—' : r.landingLabel;
      const area = r.cancelled ? '—' : r.area;
      const cls = r.cancelled ? 'cancelled' : r.landingType === 'reserve' ? 'reserve' : '';
      return `<tr class="${cls}"><td>${r.iso}</td><td>${area}</td><td>${landing}</td></tr>`;
    })
    .join('');

  let note;
  if (state.landingFilter) {
    const label =
      LANDING_ORDER.find((o) => o.type === state.landingFilter)?.label || state.landingFilter;
    note = `${recent.length} shown · filtered: ${label} (click again to clear)`;
  } else {
    const takeoffN = rows.filter((r) => !r.cancelled).length;
    const cancelledN = rows.length - takeoffN;
    note =
      `${takeoffN} takeoff${takeoffN === 1 ? '' : 's'}` +
      (cancelledN ? ` · ${cancelledN} cancelled` : '');
  }
  $('#tableHint').textContent = note;
}

function renderAll() {
  const base = baseRows();
  const scoped = zoomedRows(base);

  // Cancelled flights (empty actualStartArea) are not takeoffs: keep them out of
  // every takeoff figure, but still surface their count and list them (marked).
  const takeoffBase = base.filter((r) => !r.cancelled);
  const takeoffs = scoped.filter((r) => !r.cancelled);
  const cancelled = scoped.filter((r) => r.cancelled);

  const empty = $('#empty');
  empty.hidden = scoped.length > 0;
  if (scoped.length === 0) {
    empty.textContent = 'No flights match the selected date range.';
  }

  renderBreadcrumb();
  renderKPIs(takeoffs, cancelled.length);
  renderChart(takeoffBase, takeoffs);
  renderLanding(takeoffs);
  renderAreas(takeoffs);
  renderTable(scoped);
}

/* ------------------------------ controls --------------------------------- */

function setDefaultRange() {
  if (!state.flights.length) return;
  $('#start').value = state.flights[0].iso;
  $('#end').value = state.flights[state.flights.length - 1].iso;
}

function resetZoom() {
  state.zoom = { level: 'years', year: null, month: null };
}

function wireControls() {
  $('#start').addEventListener('change', () => {
    resetZoom();
    renderAll();
  });
  $('#end').addEventListener('change', () => {
    resetZoom();
    renderAll();
  });

  // Zoom IN by clicking a bar (year -> months -> days).
  $('#chart').addEventListener('click', (e) => {
    const wrap = e.target.closest('.bar-wrap.zoomable');
    if (!wrap || !wrap.dataset.zlevel) return;
    state.zoom = {
      level: wrap.dataset.zlevel,
      year: Number(wrap.dataset.zyear),
      month: wrap.dataset.zmonth || null,
    };
    renderAll();
  });

  // Zoom OUT (or sideways) via the breadcrumb.
  $('#crumbs').addEventListener('click', (e) => {
    const btn = e.target.closest('button.crumb');
    if (!btn) return;
    state.zoom = {
      level: btn.dataset.level,
      year: btn.dataset.year ? Number(btn.dataset.year) : null,
      month: btn.dataset.month || null,
    };
    renderAll();
  });

  // Click a landing outcome to filter the flights table (toggle).
  $('#landing').addEventListener('click', (e) => {
    const row = e.target.closest('.row-h.clickable');
    if (!row) return;
    const t = row.dataset.ltype;
    state.landingFilter = state.landingFilter === t ? null : t;
    renderAll();
  });

  $('#reset').addEventListener('click', () => {
    setDefaultRange();
    resetZoom();
    state.landingFilter = null;
    renderAll();
  });
}

/* ----------------------- share / screenshot cards ------------------------ */

// Compact, screenshot-ready stat cards for social media. Each variant focuses
// on a different angle of the data; user picks the one to share/screenshot.
// All cards have the same fixed size so they screenshot cleanly.

const SHARE_VARIANTS = [
  { id: 'overview', title: 'Overview' },
  { id: 'areas', title: 'Top launches' },
  { id: 'years', title: 'By year' },
  { id: 'safety', title: 'Safety' },
];

const shareState = { variant: 'overview', pilot: '' };

function shareDateRange(rows) {
  if (!rows.length) return '—';
  const a = rows[0].iso;
  const b = rows[rows.length - 1].iso;
  return a === b ? a : `${a} → ${b}`;
}

// Shared "chrome" around every share card: brand badge, pilot, date range.
function shareFrame(bodyHtml, opts) {
  const pilot = (opts && opts.pilot) || shareState.pilot || '';
  const rangeText = (opts && opts.range) || '';
  return (
    `<div class="sc-bg">` +
    `  <div class="sc-top">` +
    `    <div class="sc-brand">` +
    `      <span class="sc-brand-icon" aria-hidden="true">🪂</span>` +
    `      <div class="sc-brand-text">` +
    `        <div class="sc-brand-title">Takeoffs from Babadağ</div>` +
    `        <div class="sc-brand-sub">Fethiye · Ölüdeniz · Türkiye</div>` +
    `      </div>` +
    `    </div>` +
    (pilot ? `<div class="sc-pilot" title="${pilot}">${pilot}</div>` : '') +
    `  </div>` +
    `  <div class="sc-body">${bodyHtml}</div>` +
    `  <div class="sc-foot">` +
    `    <span class="sc-foot-range">${rangeText}</span>` +
    `    <span class="sc-foot-tag">#babadag #paragliding</span>` +
    `  </div>` +
    `</div>`
  );
}

function shareBigStat(value, label, sub) {
  return (
    `<div class="sc-big">` +
    `  <div class="sc-big-value">${value}</div>` +
    `  <div class="sc-big-label">${label}</div>` +
    (sub ? `<div class="sc-big-sub">${sub}</div>` : '') +
    `</div>`
  );
}

function shareMini(value, label) {
  return (
    `<div class="sc-mini">` +
    `  <div class="sc-mini-value">${value}</div>` +
    `  <div class="sc-mini-label">${label}</div>` +
    `</div>`
  );
}

// Variant 1 — Overview: lifetime totals, big takeoff number front and centre.
function renderShareOverview(rows) {
  const takeoffs = rows.length;
  const years = new Set(rows.map((r) => r.year)).size;
  const areas = new Set(rows.map((r) => r.area)).size;
  const reliable = rows.filter((r) => r.landingType === 'reliable').length;
  const firstYear = rows.length ? rows[0].year : '—';
  const lastYear = rows.length ? rows[rows.length - 1].year : '—';

  const body =
    shareBigStat(takeoffs, 'Takeoffs', `from ${firstYear} to ${lastYear}`) +
    `<div class="sc-mini-row">` +
    shareMini(years, `Year${years === 1 ? '' : 's'} flying`) +
    shareMini(areas, `Launch area${areas === 1 ? '' : 's'}`) +
    shareMini(reliable, 'Reliable landings') +
    `</div>`;

  return shareFrame(body, { range: shareDateRange(rows) });
}

// Variant 2 — Top launch areas: bar list of where takeoffs happened.
function renderShareAreas(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.area, (counts.get(r.area) || 0) + 1);
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = list.length ? list[0][1] : 1;
  const totalTop = list.reduce((s, [, n]) => s + n, 0);

  const bars = list.length
    ? list
        .map(([name, n]) => {
          const pct = Math.round((n / max) * 100);
          const safe = name.replace(/</g, '&lt;');
          return (
            `<div class="sc-row">` +
            `  <div class="sc-row-name">${safe}</div>` +
            `  <div class="sc-row-track"><div class="sc-row-fill" style="width:${pct}%"></div></div>` +
            `  <div class="sc-row-n">${n}</div>` +
            `</div>`
          );
        })
        .join('')
    : `<div class="sc-empty">No takeoffs in this range.</div>`;

  const body =
    `<div class="sc-h">Top launch areas</div>` +
    `<div class="sc-sub">${rows.length} takeoff${rows.length === 1 ? '' : 's'} · ${counts.size} distinct area${counts.size === 1 ? '' : 's'}</div>` +
    `<div class="sc-rows">${bars}</div>` +
    `<div class="sc-foot-note">Top ${list.length} cover ${totalTop} of ${rows.length} flights</div>`;

  return shareFrame(body, { range: shareDateRange(rows) });
}

// Variant 3 — By year: bar chart of takeoffs per calendar year.
function renderShareYears(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.year, (counts.get(r.year) || 0) + 1);
  const years = [...counts.keys()].sort((a, b) => a - b);
  const max = years.reduce((m, y) => Math.max(m, counts.get(y)), 1);

  let bestYear = years[0];
  for (const y of years) if (counts.get(y) > counts.get(bestYear)) bestYear = y;
  const bestN = bestYear != null ? counts.get(bestYear) : 0;

  const bars = years.length
    ? years
        .map((y) => {
          const n = counts.get(y);
          const h = Math.max(6, Math.round((n / max) * 220));
          return (
            `<div class="sc-yc">` +
            `  <div class="sc-yc-n">${n}</div>` +
            `  <div class="sc-yc-bar" style="height:${h}px"></div>` +
            `  <div class="sc-yc-y">${y}</div>` +
            `</div>`
          );
        })
        .join('')
    : `<div class="sc-empty">No takeoffs in this range.</div>`;

  const body =
    `<div class="sc-h">Takeoffs by year</div>` +
    `<div class="sc-sub">${rows.length} takeoff${rows.length === 1 ? '' : 's'} across ${years.length} year${years.length === 1 ? '' : 's'}</div>` +
    `<div class="sc-years">${bars}</div>` +
    (bestYear != null
      ? `<div class="sc-foot-note">Best year: <strong>${bestYear}</strong> with <strong>${bestN}</strong> takeoff${bestN === 1 ? '' : 's'}</div>`
      : '');

  return shareFrame(body, { range: shareDateRange(rows) });
}

// Variant 4 — Safety: reliable vs reserve deployments.
function renderShareSafety(rows) {
  const total = rows.length;
  const reliable = rows.filter((r) => r.landingType === 'reliable').length;
  const reserve = rows.filter((r) => r.landingType === 'reserve').length;
  const other = total - reliable - reserve;
  const reliablePct = total ? Math.round((reliable / total) * 100) : 0;

  const body =
    `<div class="sc-h">Safety record</div>` +
    `<div class="sc-sub">Across ${total} takeoff${total === 1 ? '' : 's'} from Babadağ</div>` +
    `<div class="sc-safety">` +
    `  <div class="sc-ring" style="--p:${reliablePct}">` +
    `    <div class="sc-ring-inner">` +
    `      <div class="sc-ring-pct">${reliablePct}%</div>` +
    `      <div class="sc-ring-lbl">reliable landings</div>` +
    `    </div>` +
    `  </div>` +
    `  <div class="sc-safety-stats">` +
    `    <div class="sc-mini sc-safe-ok"><div class="sc-mini-value">${reliable}</div><div class="sc-mini-label">Reliable</div></div>` +
    `    <div class="sc-mini ${reserve > 0 ? 'sc-safe-bad' : ''}"><div class="sc-mini-value">${reserve}</div><div class="sc-mini-label">Reserve thrown</div></div>` +
    `    <div class="sc-mini"><div class="sc-mini-value">${other}</div><div class="sc-mini-label">Other / unspecified</div></div>` +
    `  </div>` +
    `</div>`;

  return shareFrame(body, { range: shareDateRange(rows) });
}

const SHARE_RENDERERS = {
  overview: renderShareOverview,
  areas: renderShareAreas,
  years: renderShareYears,
  safety: renderShareSafety,
};

function renderShareCard() {
  const card = $('#shareCard');
  if (!card) return;
  const rows = state.flights.filter((r) => !r.cancelled);
  card.dataset.variant = shareState.variant;
  const fn = SHARE_RENDERERS[shareState.variant] || renderShareOverview;
  card.innerHTML = fn(rows);
}

function openShareModal() {
  renderShareCard();
  const modal = $('#shareModal');
  if (!modal) return;
  modal.hidden = false;
  modal.dataset.open = 'true';
  document.body.style.overflow = 'hidden';
}

function closeShareModal() {
  const modal = $('#shareModal');
  if (!modal) return;
  modal.hidden = true;
  modal.dataset.open = 'false';
  document.body.style.overflow = '';
}

// Build an SVG that wraps the share card via <foreignObject>, then rasterise
// it onto a canvas to get a PNG blob without any external dependencies.
async function shareCardToBlob() {
  const card = $('#shareCard');
  if (!card) return null;
  const w = 1080;
  const h = 1080;

  const inlineStyles = [...document.styleSheets]
    .map((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText).join('\n');
      } catch (e) {
        return '';
      }
    })
    .join('\n');

  // Inline the card's HTML inside an SVG foreignObject so we can rasterise it.
  // The wrapper enforces the export size regardless of how the on-screen
  // card was scaled to fit the preview area.
  const html =
    `<div xmlns="http://www.w3.org/1999/xhtml" class="sc-export" data-variant="${shareState.variant}">` +
    `<style>${inlineStyles}</style>` +
    card.outerHTML +
    `</div>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">${html}</foreignObject>` +
    `</svg>`;

  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Could not rasterise the share card.'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downloadShareCard() {
  try {
    const blob = await shareCardToBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `babadag-takeoffs-${shareState.variant}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    // Fallback: user can still screenshot the preview.
    console.warn('Share download failed:', err);
    alert('Could not generate PNG. You can still screenshot the card.');
  }
}

async function copyShareCard() {
  try {
    const blob = await shareCardToBlob();
    if (!blob || !navigator.clipboard || !window.ClipboardItem) {
      throw new Error('Clipboard image copy is not available in this browser.');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    const btn = $('#shareCopy');
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => (btn.textContent = prev), 1500);
    }
  } catch (err) {
    console.warn('Share copy failed:', err);
    alert('Could not copy the image. Try Download PNG or take a screenshot.');
  }
}

function wireShare(meta) {
  shareState.pilot = (meta && meta.pilot) || (state.flights[0] && state.flights[0].pilot) || '';

  const openBtn = $('#shareBtn');
  if (openBtn) openBtn.addEventListener('click', openShareModal);

  const modal = $('#shareModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.close) closeShareModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.dataset.open === 'true') closeShareModal();
  });

  const tabs = $('#shareTabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button.share-tab');
      if (!btn) return;
      shareState.variant = btn.dataset.variant;
      for (const t of tabs.querySelectorAll('.share-tab')) {
        t.classList.toggle('active', t === btn);
      }
      renderShareCard();
    });
  }

  const dl = $('#shareDownload');
  if (dl) dl.addEventListener('click', downloadShareCard);
  const cp = $('#shareCopy');
  if (cp) cp.addEventListener('click', copyShareCard);
}

/* -------------------------------- boot ----------------------------------- */

(async function init() {
  try {
    const meta = await loadData();
    renderMeta(meta);
    setDefaultRange();
    wireControls();
    wireShare(meta);
    renderAll();
    document.body.dataset.ready = 'true';
  } catch (err) {
    const empty = $('#empty');
    empty.hidden = false;
    empty.textContent = err.message || String(err);
    document.body.dataset.ready = 'error';
  }
})();
