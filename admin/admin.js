/*
 * ASTS FCCS private admin dashboard.
 *
 * Every lead comes from the Google Apps Script Web App set in config.js (the
 * same /exec URL as the landing page), which reads the Google Sheet. There is
 * no sample data. Data from the Sheet is only ever inserted with textContent,
 * never parsed as HTML.
 */
(function () {
  'use strict';

  const APPS_SCRIPT_URL = String((window.ADMIN_CONFIG || {}).APPS_SCRIPT_URL || '').trim();
  const POLL_MS = 60 * 1000;
  const TIMEOUT_MS = 45 * 1000;
  const PAGE_SIZE = 25;

  // The admin key lives ONLY in this variable: never in localStorage,
  // sessionStorage, cookies, the URL or the page source.
  let adminKey = '';

  const state = {
    leads: [],          // every lead the Apps Script sent, newest first
    total: 0,           // rows in the Sheet (can be more than were sent)
    loaded: false,
    period: 'all',
    custom: { from: '', to: '' },
    search: '',
    role: '',
    availability: '',
    sort: { key: 't', dir: -1 },
    page: 0,
    lastUpdated: 0,
    error: '',
    seq: 0,
    timer: 0
  };

  // ---------------------------------------------------------------------------
  // DOM helpers and formatting
  // ---------------------------------------------------------------------------

  const $ = id => document.getElementById(id);

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach(key => {
      const value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    children.flat().forEach(child => {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  const numberFormat = new Intl.NumberFormat();
  const num = n => numberFormat.format(n);
  const notSet = value => value || '(not set)';
  const pad = n => String(n).padStart(2, '0');
  const plural = (n, word) => num(n) + ' ' + word + (n === 1 ? '' : 's');

  function dateTime(ms) {
    if (ms === null) return '(no date)';
    return new Date(ms).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }
  function shortDate(date) {
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // "Yes, I will attend on 10 October" -> yes; "No, please share..." -> no; anything else -> other
  function answerKind(availability) {
    if (/^yes\b/i.test(availability)) return 'yes';
    if (/^no\b/i.test(availability)) return 'no';
    return 'other';
  }

  // ---------------------------------------------------------------------------
  // Periods (this browser's time zone)
  // ---------------------------------------------------------------------------

  const PERIOD_NAMES = {
    today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '30d': 'Last 30 days',
    all: 'All time', custom: 'Custom range'
  };
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  function inputDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // [from, to) as local Dates (null = no limit)
  function currentRange() {
    const today = startOfDay(new Date());
    switch (state.period) {
      case 'today': return { from: today, to: addDays(today, 1) };
      case 'yesterday': return { from: addDays(today, -1), to: today };
      case '7d': return { from: addDays(today, -6), to: addDays(today, 1) };
      case '30d': return { from: addDays(today, -29), to: addDays(today, 1) };
      case 'custom': {
        const from = inputDate(state.custom.from);
        const end = inputDate(state.custom.to);
        return { from: from, to: end ? addDays(end, 1) : null };
      }
      default: return { from: null, to: null };
    }
  }

  function describeRange(range) {
    const name = PERIOD_NAMES[state.period];
    if (!range.from || !range.to) return name;
    const last = addDays(range.to, -1);
    if (range.from.getTime() === last.getTime()) return name + ' · ' + shortDate(range.from);
    return name + ' · ' + shortDate(range.from) + ' – ' + shortDate(last);
  }

  // Leads in the selected period (a lead whose date cell was damaged only shows under All Time)
  function leadsInPeriod() {
    const range = currentRange();
    if (!range.from && !range.to) return state.leads;
    return state.leads.filter(lead => lead.t !== null &&
      (!range.from || lead.t >= range.from.getTime()) && (!range.to || lead.t < range.to.getTime()));
  }

  // ...narrowed by the search box and the two filters
  function leadsShown() {
    const words = state.search.toLowerCase().split(/\s+/).filter(Boolean);
    return leadsInPeriod().filter(lead => {
      if (state.role && lead.role !== state.role) return false;
      if (state.availability && lead.availability !== state.availability) return false;
      if (!words.length) return true;
      const text = [lead.name, lead.phone, lead.email, lead.leadId, lead.country, lead.utmSource, lead.utmCampaign]
        .join(' ').toLowerCase();
      return words.every(word => text.indexOf(word) !== -1);
    });
  }

  // ---------------------------------------------------------------------------
  // Talking to the Apps Script
  // ---------------------------------------------------------------------------

  async function fetchLeads(key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        // Plain-text JSON and no custom headers, so the browser sends it without
        // a CORS pre-check. The key travels in this HTTPS body, never in the URL.
        body: JSON.stringify({ action: 'dashboard', adminKey: key }),
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      });
      let body = null;
      try { body = await response.json(); } catch (e) { /* not JSON */ }
      if (!body) {
        return {
          ok: false, code: 'BAD_RESPONSE',
          message: 'The Apps Script did not send back data (HTTP ' + response.status + '). Check the /exec URL in config.js and that the deployment\'s access is "Anyone".'
        };
      }
      if (body.ok === true && body.data && Array.isArray(body.data.leads)) return { ok: true, data: body.data };
      if (!body.code) {
        // An older version of the script treats this request as a registration and rejects it
        return {
          ok: false, code: 'OLD_SCRIPT',
          message: 'The deployed Apps Script does not have the dashboard yet. Paste the latest apps-script/Code.gs, run setup, then Deploy > Manage deployments > Edit > New version.'
        };
      }
      return { ok: false, code: body.code, message: body.error || 'The Apps Script returned an error.' };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, code: 'TIMEOUT', message: 'The Apps Script took too long to answer.' };
      }
      return {
        ok: false, code: 'NETWORK',
        message: 'Could not reach the Apps Script. Check your internet connection, the /exec URL in config.js, and that the deployment\'s access is "Anyone".'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function storeLeads(data) {
    state.leads = data.leads.map(lead => {
      const clean = {};
      ['leadId', 'name', 'phone', 'email', 'country', 'countryCode', 'role', 'availability', 'course',
        'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'gclid', 'pageUrl'].forEach(key => {
        clean[key] = typeof lead[key] === 'string' ? lead[key] : '';
      });
      clean.t = typeof lead.t === 'number' && isFinite(lead.t) ? lead.t : null;
      return clean;
    });
    state.total = typeof data.total === 'number' ? data.total : state.leads.length;
    state.loaded = true;
    state.lastUpdated = Date.now();
    state.error = '';
  }

  // Loads fresh data. reason: 'poll' (every minute), 'visible' or 'manual'
  async function load(reason) {
    if (!adminKey) return;
    clearTimeout(state.timer);
    if (reason === 'poll' && document.hidden) return; // resumes when the tab is shown again

    const seq = ++state.seq;
    $('refreshBtn').classList.add('is-busy');
    const result = await fetchLeads(adminKey);
    if (seq !== state.seq) return; // a newer request replaced this one
    $('refreshBtn').classList.remove('is-busy');

    if (result.ok) {
      storeLeads(result.data);
      render();
    } else if (result.code === 'UNAUTHORIZED' || result.code === 'NOT_CONFIGURED') {
      signOut(result.code === 'UNAUTHORIZED'
        ? 'The admin key is no longer accepted. It may have been changed in Script properties.'
        : result.message);
      return;
    } else {
      state.error = result.message;
      renderStatus();
    }
    state.timer = setTimeout(() => load('poll'), POLL_MS);
  }

  // ---------------------------------------------------------------------------
  // Views, sign in and sign out
  // ---------------------------------------------------------------------------

  function showView(name) {
    $('setupView').hidden = name !== 'setup';
    $('loginView').hidden = name !== 'login';
    $('appView').hidden = name !== 'app';
  }

  function showLoginError(message) {
    const box = $('loginError');
    box.textContent = message;
    box.hidden = !message;
  }

  async function signIn(event) {
    event.preventDefault();
    const input = $('adminKey');
    const key = input.value.trim();
    if (!key) { showLoginError('Enter your admin key.'); input.focus(); return; }

    const button = $('loginBtn');
    button.disabled = true;
    button.textContent = 'Signing in…';
    showLoginError('');
    const result = await fetchLeads(key);
    button.disabled = false;
    button.textContent = 'Sign in';

    if (!result.ok) {
      showLoginError(result.message);
      if (result.code === 'UNAUTHORIZED') { input.select(); input.focus(); }
      return;
    }
    adminKey = key;
    input.value = '';
    storeLeads(result.data);
    showView('app');
    render();
    state.timer = setTimeout(() => load('poll'), POLL_MS);
  }

  function signOut(message) {
    adminKey = '';
    clearTimeout(state.timer);
    state.seq++;
    state.leads = [];
    state.total = 0;
    state.loaded = false;
    ['kpis', 'leadsTable', 'breakdowns'].forEach(id => $(id).replaceChildren());
    showView('login');
    showLoginError(message || '');
    $('adminKey').focus();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    renderStatus();
    renderPeriod();
    renderKpis();
    renderFilters();
    renderTable();
    renderBreakdowns();
  }

  function renderStatus() {
    $('lastUpdated').textContent = 'Last Updated: ' + (state.lastUpdated
      ? new Date(state.lastUpdated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      : '—');
    const banner = $('statusBanner');
    banner.textContent = state.error ? 'Could not refresh: ' + state.error + ' Showing the last data that loaded.' : '';
    banner.hidden = !state.error;
  }

  function renderPeriod() {
    document.querySelectorAll('#periods button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.period === state.period));
    });
    $('customRange').hidden = state.period !== 'custom';
    $('periodLabel').textContent = describeRange(currentRange());
  }

  function kpi(label, value, caption) {
    return h('section', { class: 'card kpi' },
      h('p', { class: 'kpi-label', text: label }),
      h('p', { class: 'kpi-value', text: num(value) }),
      h('p', { class: 'kpi-caption', text: caption }));
  }

  function renderKpis() {
    const leads = leadsInPeriod();
    const count = kind => leads.filter(lead => answerKind(lead.availability) === kind).length;
    const todayStart = startOfDay(new Date()).getTime();
    const today = state.leads.filter(lead => lead.t !== null && lead.t >= todayStart).length;
    $('kpis').replaceChildren(
      kpi('Registrations', leads.length, plural(today, 'registration') + ' today'),
      kpi('Will attend', count('yes'), 'Answered "Yes" to the demo'),
      kpi('Want the next date', count('no'), 'Answered "No, share the next demo date"'),
      kpi('Not sure yet', count('other'), 'Any other answer')
    );
  }

  // The two dropdowns list the answers that exist in the data
  function fillSelect(select, allLabel, values, current) {
    const options = [h('option', { value: '', text: allLabel })]
      .concat(values.map(value => h('option', { value: value, text: value })));
    select.replaceChildren(...options);
    select.value = values.indexOf(current) === -1 ? '' : current;
    return select.value;
  }

  function renderFilters() {
    const distinct = key => Array.from(new Set(state.leads.map(lead => lead[key]).filter(Boolean))).sort();
    state.role = fillSelect($('roleFilter'), 'All roles', distinct('role'), state.role);
    state.availability = fillSelect($('availabilityFilter'), 'All availability answers', distinct('availability'), state.availability);
  }

  const COLUMNS = [
    { key: 't', label: 'Registered', cell: lead => dateTime(lead.t) },
    { key: 'name', label: 'Name', cell: lead => lead.name },
    { key: 'phone', label: 'Phone', cell: lead => lead.phone ? h('a', { href: 'tel:+' + lead.phone, text: '+' + lead.phone }) : '' },
    { key: 'email', label: 'Email', cell: lead => lead.email ? h('a', { href: 'mailto:' + lead.email, text: lead.email }) : '' },
    { key: 'country', label: 'Country', cell: lead => lead.country },
    { key: 'role', label: 'Role', cell: lead => lead.role },
    {
      key: 'availability', label: 'Available for demo?',
      cell: lead => lead.availability
        ? h('span', { class: 'pill pill-' + answerKind(lead.availability), text: lead.availability })
        : ''
    },
    { key: 'utmSource', label: 'Source', cell: lead => notSet(lead.utmSource), muted: lead => !lead.utmSource },
    { key: 'utmCampaign', label: 'Campaign', cell: lead => notSet(lead.utmCampaign), muted: lead => !lead.utmCampaign },
    { key: 'leadId', label: 'Lead ID', cell: lead => lead.leadId, mono: true }
  ];

  function sortLeads(leads) {
    const key = state.sort.key;
    const dir = state.sort.dir;
    return leads.slice().sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (key === 't') return ((x === null ? -Infinity : x) - (y === null ? -Infinity : y)) * dir;
      return String(x).localeCompare(String(y), undefined, { sensitivity: 'base' }) * dir || (b.t || 0) - (a.t || 0);
    });
  }

  function renderTable() {
    const inPeriod = leadsInPeriod();
    const shown = sortLeads(leadsShown());
    const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const start = state.page * PAGE_SIZE;
    const pageRows = shown.slice(start, start + PAGE_SIZE);

    $('leadsSub').textContent = state.total > state.leads.length
      ? 'Showing the newest ' + num(state.leads.length) + ' of ' + num(state.total) + ' rows in the Leads tab of the Google Sheet.'
      : 'From the Leads tab of the Google Sheet.';
    $('tableCount').textContent = shown.length === inPeriod.length
      ? plural(shown.length, 'lead')
      : num(shown.length) + ' of ' + plural(inPeriod.length, 'lead');
    $('exportBtn').disabled = !shown.length;

    const head = h('tr', null, COLUMNS.map(column => {
      const active = state.sort.key === column.key;
      return h('th', { scope: 'col', 'aria-sort': active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : null },
        h('button', {
          type: 'button', class: 'sort' + (active ? ' active' : ''),
          onclick: () => {
            state.sort = { key: column.key, dir: active ? -state.sort.dir : (column.key === 't' ? -1 : 1) };
            state.page = 0;
            renderTable();
          }
        }, column.label, h('span', { class: 'sort-mark', 'aria-hidden': 'true', text: active ? (state.sort.dir === 1 ? '▲' : '▼') : '↕' })));
    }));

    const emptyText = !state.leads.length ? 'No one has registered yet.'
      : !inPeriod.length ? 'No registrations in this period.'
        : 'No leads match the search and filters.';
    const body = pageRows.length
      ? pageRows.map(lead => h('tr', null, COLUMNS.map(column => h('td', {
        class: [column.mono ? 'mono' : '', column.muted && column.muted(lead) ? 'muted' : ''].join(' ').trim() || null
      }, column.cell(lead)))))
      : [h('tr', null, h('td', { class: 'empty-cell', colspan: COLUMNS.length, text: emptyText }))];

    const table = h('div', { class: 'table-scroll' },
      h('table', { class: 'data-table' }, h('thead', null, head), h('tbody', null, body)));

    const pager = shown.length > PAGE_SIZE && h('div', { class: 'pager' },
      h('span', { class: 'pager-info', text: num(start + 1) + '–' + num(start + pageRows.length) + ' of ' + num(shown.length) }),
      h('div', { class: 'pager-buttons' },
        h('button', { type: 'button', class: 'btn btn-light btn-sm', disabled: state.page === 0, onclick: () => { state.page--; renderTable(); } }, 'Previous'),
        h('button', { type: 'button', class: 'btn btn-light btn-sm', disabled: state.page >= pages - 1, onclick: () => { state.page++; renderTable(); } }, 'Next')));

    $('leadsTable').replaceChildren(table, pager || '');
  }

  // Leads counted per value, biggest first; the long tail is folded into "Other"
  function breakdown(title, leads, valueOf) {
    const groups = new Map();
    leads.forEach(lead => {
      const label = notSet(valueOf(lead));
      groups.set(label, (groups.get(label) || 0) + 1);
    });
    let rows = Array.from(groups, ([label, count]) => ({ label: label, count: count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (rows.length > 7) {
      const rest = rows.slice(6);
      rows = rows.slice(0, 6).concat({ label: 'Other (' + rest.length + ')', count: rest.reduce((sum, row) => sum + row.count, 0), other: true });
    }
    const max = rows.reduce((m, row) => Math.max(m, row.count), 0);
    const bar = row => {
      const fill = h('span', { class: 'bar-fill' });
      fill.style.width = (row.count / max * 100).toFixed(1) + '%'; // set as a property: the page's CSP blocks style attributes
      return h('span', { class: 'bar-track' }, fill);
    };
    return h('section', { class: 'breakdown' },
      h('h3', { text: title }),
      rows.length
        ? h('ul', { class: 'bars' }, rows.map(row => h('li', { class: 'bar-row' + (row.other ? ' is-other' : '') },
          h('span', { class: 'bar-label', text: row.label }),
          bar(row),
          h('span', { class: 'bar-value' }, num(row.count), h('small', { text: Math.round(row.count / leads.length * 100) + '%' })))))
        : h('p', { class: 'empty', text: 'No registrations in this period.' }));
  }

  function renderBreakdowns() {
    const leads = leadsInPeriod();
    $('breakdowns').replaceChildren(
      breakdown('By role', leads, lead => lead.role),
      breakdown('By country', leads, lead => lead.country),
      breakdown('By source (utm_source)', leads, lead => lead.utmSource));
  }

  // ---------------------------------------------------------------------------
  // CSV download of the leads currently shown
  // ---------------------------------------------------------------------------

  function csvCell(value) {
    let text = String(value === null || value === undefined ? '' : value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // never let a spreadsheet run it as a formula
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function downloadCsv() {
    const leads = sortLeads(leadsShown());
    if (!leads.length) return;
    const columns = [
      ['Lead ID', l => l.leadId], ['Registered', l => (l.t === null ? '' : new Date(l.t).toLocaleString())],
      ['Name', l => l.name], ['Phone', l => l.phone], ['Email', l => l.email],
      ['Country', l => l.country], ['Country Code', l => l.countryCode], ['Role', l => l.role],
      ['Availability', l => l.availability], ['Course', l => l.course],
      ['UTM Source', l => l.utmSource], ['UTM Medium', l => l.utmMedium], ['UTM Campaign', l => l.utmCampaign],
      ['UTM Term', l => l.utmTerm], ['GCLID', l => l.gclid], ['Page URL', l => l.pageUrl]
    ];
    const lines = [columns.map(c => csvCell(c[0])).join(',')]
      .concat(leads.map(lead => columns.map(c => csvCell(c[1](lead))).join(',')));
    const now = new Date();
    const link = h('a', {
      href: URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })),
      download: 'fccs-leads-' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '.csv'
    });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  function start() {
    $('boot').hidden = true;

    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(APPS_SCRIPT_URL)) {
      if (/\/dev$/.test(APPS_SCRIPT_URL)) {
        $('setupMessage').textContent = 'admin/config.js has the /dev test URL. Use the Web app URL that ends in /exec.';
      } else if (APPS_SCRIPT_URL && APPS_SCRIPT_URL.indexOf('PASTE_') === -1) {
        $('setupMessage').textContent = 'The URL in admin/config.js is not an Apps Script /exec URL. It should look like https://script.google.com/macros/s/…/exec.';
      }
      showView('setup');
      return;
    }

    $('loginForm').addEventListener('submit', signIn);
    $('signOutBtn').addEventListener('click', () => signOut(''));
    $('refreshBtn').addEventListener('click', () => load('manual'));
    $('exportBtn').addEventListener('click', downloadCsv);

    $('periods').addEventListener('click', event => {
      const button = event.target.closest('button[data-period]');
      if (!button) return;
      state.period = button.dataset.period;
      state.page = 0;
      render();
      if (state.period === 'custom') $('customFrom').focus();
    });
    $('customRange').addEventListener('submit', event => {
      event.preventDefault();
      state.custom = { from: $('customFrom').value, to: $('customTo').value };
      state.page = 0;
      render();
    });

    $('search').addEventListener('input', event => { state.search = event.target.value; state.page = 0; renderTable(); });
    $('roleFilter').addEventListener('change', event => { state.role = event.target.value; state.page = 0; renderTable(); });
    $('availabilityFilter').addEventListener('change', event => { state.availability = event.target.value; state.page = 0; renderTable(); });

    document.addEventListener('visibilitychange', () => { if (!document.hidden && adminKey) load('visible'); });

    showView('login');
    $('adminKey').focus();
  }

  start();
})();
