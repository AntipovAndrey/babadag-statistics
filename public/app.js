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

/* -------------------------------- boot ----------------------------------- */

(async function init() {
  try {
    const meta = await loadData();
    renderMeta(meta);
    setDefaultRange();
    wireControls();
    renderAll();
    document.body.dataset.ready = 'true';
  } catch (err) {
    const empty = $('#empty');
    empty.hidden = false;
    empty.textContent = err.message || String(err);
    document.body.dataset.ready = 'error';
  }
})();
