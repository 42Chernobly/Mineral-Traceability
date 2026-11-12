/* Role-based dashboard SPA (plain JavaScript, no build step). */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtDate = (d) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const fmtKg = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }) + ' kg');
  const short = (h) => (h ? h.slice(0, 10) + '…' + h.slice(-6) : '');
  const STATUS = { registered: 'Registered', processed: 'Processed', in_transit: 'In transit', inspected: 'Inspected', export_approved: 'Export approved', exported: 'Exported', shipped: 'Shipped', received: 'Received' };

  const store = {
    get token() { try { return sessionStorage.getItem('mt_token'); } catch (e) { return null; } },
    set token(v) { try { v ? sessionStorage.setItem('mt_token', v) : sessionStorage.removeItem('mt_token'); } catch (e) { /* ignore */ } },
  };
  let me = null; let meta = null; let scanner = null;

  // ---------- offline queue (localStorage; the page still works if storage is blocked) ----------
  const qKey = () => 'mt_queue_' + (me ? me.id : 'x');
  function getQueue() { try { return JSON.parse(localStorage.getItem(qKey()) || '[]'); } catch (e) { return memQueue; } }
  let memQueue = [];
  function setQueue(q) { memQueue = q; try { localStorage.setItem(qKey(), JSON.stringify(q)); } catch (e) { /* ignore */ } updatePill(); }
  function updatePill() {
    const n = getQueue().length; const p = $('#offline-pill');
    if (n || !navigator.onLine) { p.textContent = (navigator.onLine ? '' : 'Offline · ') + n + ' queued'; p.classList.remove('hidden'); } else p.classList.add('hidden');
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  async function syncQueue(silent) {
    const q = getQueue(); if (!q.length || !navigator.onLine) return;
    try {
      const r = await api('POST', '/api/events/sync', { events: q });
      const failed = [];
      r.results.forEach((res, i) => { if (!res.ok && res.status !== 404 && res.status !== 409 && res.status !== 400 && res.status !== 403) failed.push(q[i]); });
      const rejected = r.results.filter((x) => !x.ok).length;
      setQueue(failed);
      if (!silent || rejected) toast(`Synced ${r.results.length - rejected} event(s)` + (rejected ? `, ${rejected} rejected by the server` : ''));
      if (location.hash.startsWith('#/batch/') || location.hash === '' || location.hash === '#/') route();
    } catch (e) { /* stay queued */ }
  }
  window.addEventListener('online', () => { updatePill(); syncQueue(); });
  window.addEventListener('offline', updatePill);

  // ---------- API ----------
  async function api(method, url, body, raw) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}, store.token ? { Authorization: 'Bearer ' + store.token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) { if (!res.ok) throw new Error('Request failed'); return res; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && store.token) { logout(); throw new Error('Session expired, please sign in again'); }
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
    return data;
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  // ---------- auth ----------
  function showLogin() {
    stopScanner(); me = null; meta = null;
    $('#app-view').classList.add('hidden'); applyAuthRoute();
    const accounts = ['admin', 'mine_solwezi', 'wb_kitwe', 'insp_ndola', 'reg_zra', 'border_katima', 'wb_katima', 'port_walvis', 'buyer_alpine'];
    $('#demo-accounts').innerHTML = 'Demo accounts (simulated data, password <b>Demo@12345</b>): ' +
      accounts.map((a) => `<button type="button" data-u="${a}">${a}</button>`).join(' · ');
  }
  // Sign-in and sign-up share the signed-out screen; #/signup/<stopId> is the link for one stop.
  function applyAuthRoute() {
    const m = location.hash.match(/^#\/signup(?:\/(\d+))?/);
    $('#signup-view').classList.toggle('hidden', !m);
    $('#login-view').classList.toggle('hidden', !!m);
    if (m) loadSignup(m[1]);
  }

  let signupStops = [];
  async function loadSignup(preselect) {
    $('#su-error').textContent = ''; $('#su-done').classList.add('hidden'); $('#signup-form').classList.remove('hidden');
    try {
      const r = await fetch('/api/public/stops'); signupStops = (await r.json()).stops || [];
    } catch (e) { $('#su-error').textContent = 'Could not load the list of stops. Check your connection.'; return; }
    const byCountry = {};
    signupStops.forEach((st) => { (byCountry[st.country] = byCountry[st.country] || []).push(st); });
    $('#su-stop').innerHTML = '<option value="">Select your stop…</option>' + Object.keys(byCountry).sort().map((c) =>
      `<optgroup label="${esc(c)}">${byCountry[c].map((st) => `<option value="${st.id}">${esc(st.name)} — ${esc(st.type_label)}</option>`).join('')}</optgroup>`).join('');
    if (preselect) $('#su-stop').value = preselect;
    showSignupRole();
  }
  function showSignupRole() {
    const st = signupStops.find((x) => String(x.id) === $('#su-stop').value);
    $('#su-role').textContent = st ? `You will be registered as: ${st.role_label}. Everything you record will be stamped “${st.name}, ${st.country}”.` : '';
  }
  $('#su-stop').addEventListener('change', showSignupRole);
  $('#signup-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#su-error').textContent = '';
    try {
      const r = await api('POST', '/api/auth/signup', {
        stop_id: $('#su-stop').value, full_name: $('#su-full').value, organisation: $('#su-org').value,
        username: $('#su-user').value, password: $('#su-pass').value, contact: $('#su-contact').value,
      });
      $('#signup-form').classList.add('hidden'); $('#su-pass').value = '';
      $('#su-done').textContent = `${r.message} (${r.role_label} at ${r.stop})`; $('#su-done').classList.remove('hidden');
    } catch (err) { $('#su-error').textContent = err.message; }
  });

  function logout() { store.token = null; location.hash = ''; showLogin(); }
  $('#logout').addEventListener('click', logout);
  $('#demo-accounts').addEventListener('click', (e) => {
    const u = e.target.dataset && e.target.dataset.u; if (!u) return;
    $('#username').value = u; $('#password').value = 'Demo@12345';
  });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#login-error').textContent = '';
    try {
      const r = await api('POST', '/api/auth/login', { username: $('#username').value, password: $('#password').value });
      store.token = r.token; $('#password').value = ''; await start();
    } catch (err) { $('#login-error').textContent = err.message; }
  });

  async function start() {
    try {
      me = (await api('GET', '/api/auth/me')).user; meta = await api('GET', '/api/meta');
    } catch (e) { return showLogin(); }
    $('#login-view').classList.add('hidden'); $('#signup-view').classList.add('hidden'); $('#app-view').classList.remove('hidden');
    $('#who').textContent = `${me.full_name} · ${meta.role_label}`;
    const items = [['#/', 'Dashboard'], ['#/scan', 'Scan QR']];
    if (meta.can_register) items.push(['#/new', 'Register batch']);
    if (meta.can_audit) items.push(['#/audit', 'Audit']);
    if (me.role === 'admin') items.push(['#/users', 'Users & stops']);
    $('#nav').innerHTML = items.map(([h, l]) => `<button data-h="${h}">${l}</button>`).join('');
    updatePill(); route(); syncQueue(true);
  }
  $('#nav').addEventListener('click', (e) => { if (e.target.dataset.h) location.hash = e.target.dataset.h; });
  window.addEventListener('hashchange', () => { if (me) route(); else applyAuthRoute(); });

  // ---------- router ----------
  function route() {
    stopScanner(); $('#main').onclick = null;
    const h = location.hash || '#/';
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.h === h || (h.startsWith('#/batch/') && b.dataset.h === '#/')));
    const main = $('#main');
    const run = (fn) => fn(main).catch((err) => { main.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`; });
    if (h.startsWith('#/batch/')) return run((m) => viewBatch(m, decodeURIComponent(h.slice(8))));
    if (h === '#/scan') return run(viewScan);
    if (h === '#/new') return run(viewNew);
    if (h === '#/audit') return run(viewAudit);
    if (h === '#/users') return run(viewUsers);
    return run(viewDashboard);
  }

  const statusBadge = (s) => `<span class="badge ${s === 'received' || s === 'exported' ? 'ok' : ''}">${esc(STATUS[s] || s)}</span>`;

  // ---------- dashboard ----------
  async function viewDashboard(main) {
    main.innerHTML = '<p class="muted">Loading…</p>';
    const [stats, list] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/batches')]);
    const pend = me.role === 'admin' ? (await api('GET', '/api/users')).users.filter((u) => u.status === 'pending').length : 0;
    const scope = { mine: meta.stop ? `batches registered at ${meta.stop.name}` : 'your batches', buyer: 'shipments consigned to you', border: 'consignments on the move (left the mine)', port: 'consignments on the move (left the mine)' }[me.role] || 'all batches';
    main.innerHTML = `
      <h1>${esc(meta.role_label)} dashboard</h1>
      <p class="muted">Showing ${esc(scope)}.${meta.stop ? ` You are signed in at <b>${esc(meta.stop.name)}</b> (${esc(meta.stop.country)}); what you record is stamped with this place.` : ''}</p>
      ${pend ? `<div class="banner warn">${pend} access request${pend > 1 ? 's' : ''} waiting for your approval <a href="#/users">Review requests</a></div>` : ''}
      <div class="stats">
        <div class="stat"><div class="n">${stats.total_batches}</div><div class="l">Batches</div></div>
        <div class="stat"><div class="n">${(stats.by_status.in_transit || 0)}</div><div class="l">In transit</div></div>
        <div class="stat"><div class="n" style="color:${stats.flagged_batches ? 'var(--bad)' : 'inherit'}">${stats.flagged_batches}</div><div class="l">Flagged</div></div>
        <div class="stat"><div class="n">${Math.round(stats.total_declared_weight_kg / 1000).toLocaleString()}</div><div class="l">Declared tonnes</div></div>
      </div>
      <div class="card">
        <div class="row">
          <div><label for="f-q">Search batch code</label><input id="f-q" placeholder="e.g. ZM-CU-2026"></div>
          <div><label for="f-s">Status</label><select id="f-s"><option value="">All</option>${Object.keys(STATUS).map((k) => `<option value="${k}">${STATUS[k]}</option>`).join('')}</select></div>
        </div>
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th>Batch</th><th>Mineral</th><th>Origin</th><th>Weight</th><th>Status</th><th>Chain</th></tr></thead>
        <tbody id="rows"></tbody></table></div>`;
    const draw = () => {
      const q = $('#f-q').value.trim().toUpperCase(); const s = $('#f-s').value;
      const rows = list.batches.filter((b) => (!q || b.batch_code.includes(q)) && (!s || b.status === s));
      $('#rows').innerHTML = rows.length ? rows.map((b) => `
        <tr class="click" data-code="${esc(b.batch_code)}">
          <td class="mono">${esc(b.batch_code)}</td><td>${esc(b.mineral)}</td><td>${esc(b.mine_site)}</td>
          <td>${fmtKg(b.declared_weight_kg)}</td>
          <td>${statusBadge(b.status)} ${b.flagged ? '<span class="badge bad">⚑ flagged</span>' : ''}</td>
          <td class="small muted">${b.event_count} events</td></tr>`).join('') : '<tr><td colspan="6" class="muted">No batches found.</td></tr>';
    };
    draw(); $('#f-q').addEventListener('input', draw); $('#f-s').addEventListener('change', draw);
    $('#rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-code]'); if (tr) location.hash = '#/batch/' + encodeURIComponent(tr.dataset.code); });
  }

  // ---------- batch detail ----------
  function integrityBanner(i) {
    return i.valid
      ? `<div class="banner ok">✔ Chain intact<span class="small">${i.checked} events verified (SHA-256). No record has been altered, removed or re-ordered.</span></div>`
      : `<div class="banner bad">✖ TAMPERING DETECTED<span class="small">${esc(i.reason)} — first broken record: event #${i.brokenAtSeq}.</span></div>`;
  }

  async function viewBatch(main, code) {
    main.innerHTML = '<p class="muted">Loading…</p>';
    const d = await api('GET', '/api/batches/' + encodeURIComponent(code));
    const b = d.batch;
    const canAdd = meta.event_types.length && b.status !== 'received';
    const brokenSeq = d.integrity.valid ? null : d.integrity.brokenAtSeq;
    main.innerHTML = `
      <p><a href="#/">← All batches</a></p>
      <h1 class="mono">${esc(b.batch_code)} ${statusBadge(b.status)} ${b.flagged ? '<span class="badge bad">⚑ weight discrepancy</span>' : ''}</h1>
      ${integrityBanner(d.integrity)}
      <div class="grid cols-2">
        <div class="card">
          <h3>Batch details</h3>
          <table><tbody>
            <tr><th>Mineral</th><td>${esc(b.mineral)}</td></tr>
            <tr><th>Origin</th><td>${esc(b.mine_site)}${b.province ? ', ' + esc(b.province) : ''}</td></tr>
            <tr><th>Producer</th><td>${esc(b.producer_org)}</td></tr>
            <tr><th>Buyer</th><td>${esc(b.buyer_org || '—')}</td></tr>
            <tr><th>Declared</th><td>${fmtKg(b.declared_weight_kg)}</td></tr>
            <tr><th>Grade</th><td>${esc(b.grade || '—')}</td></tr>
            <tr><th>Destination</th><td>${esc(b.destination || '—')}</td></tr>
            <tr><th>Chain head</th><td class="mono small" style="word-break:break-all">${esc(b.head_hash)}</td></tr>
          </tbody></table>
        </div>
        <div class="card qr">
          <h3>Batch QR code</h3>
          <img id="qr-img" alt="Signed QR code for ${esc(b.batch_code)}" width="240" height="240">
          <p class="small muted">Signed identifier — forged codes fail validation. Scans open the public verification portal.</p>
          <p class="small"><a href="${esc(d.qr.url)}" target="_blank" rel="noopener">Open public verification page</a></p>
        </div>
      </div>
      ${canAdd ? `
      <div class="card">
        <h3>Record a handling event</h3>
        <form id="ev-form">
          <div class="row">
            <div><label for="ev-type">Event</label><select id="ev-type">${meta.event_types.map((t) => `<option value="${t.type}">${esc(t.label)}</option>`).join('')}</select></div>
            <div><label for="ev-loc">Location</label><input id="ev-loc" required maxlength="120" placeholder="e.g. Kasumbalesa Border Post" ${meta.stop ? `value="${esc(meta.stop.name)}" readonly title="Fixed to your stop"` : ''}></div>
            <div id="ev-w-wrap"><label for="ev-w">Weight (kg)</label><input id="ev-w" type="number" step="0.001" min="0"></div>
          </div>
          <label for="ev-n">Notes</label><input id="ev-n" maxlength="500">
          <p class="small muted">Recorded events are appended to the hash chain and cannot be edited. ${navigator.onLine ? '' : '<b>You are offline: the event will be queued and synced later.</b>'}</p>
          <button class="btn" type="submit">Append to chain</button>
        </form>
      </div>` : ''}
      <div class="card">
        <h3>Chain of custody (${d.events.length} events)</h3>
        <ol class="timeline">${d.events.map((e) => `
          <li class="${brokenSeq !== null && e.seq >= brokenSeq ? 'broken' : ''}">
            <b>#${e.seq} ${esc(e.label)}</b> ${e.offline ? '<span class="badge warn">synced offline</span>' : ''}
            ${e.details && e.details.weight_discrepancy ? `<span class="badge bad">⚑ ${esc(e.details.difference_pct)}% vs declared</span>` : ''}<br>
            <span class="small">${esc(e.location)} · ${esc(e.actor_org)} (${esc(e.actor_role)})</span><br>
            <span class="small muted">${fmtDate(e.occurred_at)}${e.weight_kg !== null ? ' · ' + fmtKg(e.weight_kg) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</span>
            <div class="hash">hash ${esc(e.hash)}<br>prev ${esc(e.prev_hash)}</div>
          </li>`).join('')}</ol>
      </div>`;
    loadQr(b.batch_code);
    const form = $('#ev-form');
    if (form) {
      const toggleW = () => { $('#ev-w-wrap').classList.toggle('hidden', !['WEIGHBRIDGE'].includes($('#ev-type').value) && $('#ev-w').value === ''); };
      const typeSel = $('#ev-type'); typeSel.addEventListener('change', toggleW); toggleW();
      form.addEventListener('submit', (e) => { e.preventDefault(); submitEvent(b.batch_code); });
    }
  }

  async function loadQr(code) {
    try {
      const res = await api('GET', '/api/batches/' + encodeURIComponent(code) + '/qr', null, true);
      const url = URL.createObjectURL(await res.blob()); const img = $('#qr-img'); if (img) img.src = url;
    } catch (e) { /* QR unavailable offline */ }
  }

  async function submitEvent(code) {
    const payload = {
      event_type: $('#ev-type').value, location: $('#ev-loc').value, notes: $('#ev-n').value,
      weight_kg: $('#ev-w').value || undefined, occurred_at: new Date().toISOString(), client_ref: uuid(),
    };
    const queue = () => { setQueue(getQueue().concat([Object.assign({ batch_code: code }, payload)])); toast('Saved offline — will sync when you are back online'); };
    if (!navigator.onLine) return queue();
    try {
      const r = await api('POST', '/api/batches/' + encodeURIComponent(code) + '/events', payload);
      toast(r.flagged ? 'Recorded — weight discrepancy flagged' : 'Event appended to the chain'); route();
    } catch (err) {
      if (err instanceof TypeError) return queue(); // network failure
      toast(err.message);
    }
  }

  // ---------- register batch ----------
  async function viewNew(main) {
    if (!meta.can_register) throw new Error('Your role cannot register batches');
    let producers = [];
    if (me.role === 'admin') producers = (await api('GET', '/api/users')).users.filter((u) => u.role === 'mine' && u.active && u.status === 'active');
    const stopMine = me.role === 'mine' && !!meta.stop;
    main.innerHTML = `
      <h1>Register a mineral batch</h1>
      <div class="card"><form id="nb">
        ${me.role === 'admin' ? `<label for="nb-p">Producer</label><select id="nb-p">${producers.map((p) => `<option value="${p.id}">${esc(p.organisation)}</option>`).join('')}</select>` : ''}
        <div class="row">
          <div><label for="nb-m">Mineral</label><select id="nb-m">${meta.minerals.map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
          <div><label for="nb-w">Declared weight (kg)</label><input id="nb-w" type="number" step="0.001" min="0.001" required></div>
          <div><label for="nb-g">Grade</label><input id="nb-g" maxlength="60" placeholder="e.g. LME Grade A"></div>
        </div>
        <div class="row">
          <div><label for="nb-s">Mine site</label><input id="nb-s" required maxlength="120" placeholder="e.g. Solwezi" ${stopMine ? `value="${esc(meta.stop.name)}" readonly title="Fixed to your mine"` : ''}></div>
          <div><label for="nb-pr">Province</label><input id="nb-pr" maxlength="60" ${stopMine ? `value="${esc(meta.stop.region || '')}" readonly` : ''}></div>
          <div><label for="nb-d">Destination</label><input id="nb-d" maxlength="120" placeholder="e.g. Switzerland"></div>
        </div>
        <label for="nb-b">Buyer</label>
        <select id="nb-b"><option value="">— none yet —</option>${meta.buyers.map((b) => `<option value="${b.id}">${esc(b.organisation)}</option>`).join('')}</select>
        <label for="nb-n">Notes</label><input id="nb-n" maxlength="500">
        <p><button class="btn" type="submit">Register batch &amp; generate QR</button></p>
      </form></div>`;
    $('#nb').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/batches', {
          producer_id: $('#nb-p') ? $('#nb-p').value : undefined,
          mineral: $('#nb-m').value, declared_weight_kg: $('#nb-w').value, grade: $('#nb-g').value,
          mine_site: $('#nb-s').value, province: $('#nb-pr').value, destination: $('#nb-d').value,
          buyer_id: $('#nb-b').value || undefined, notes: $('#nb-n').value,
        });
        toast('Batch ' + r.batch.batch_code + ' registered'); location.hash = '#/batch/' + encodeURIComponent(r.batch.batch_code);
      } catch (err) { toast(err.message); }
    });
  }

  // ---------- scan ----------
  function stopScanner() {
    if (scanner) { const s = scanner; scanner = null; s.stop().then(() => s.clear()).catch(() => {}); }
  }
  async function resolveToken(token) {
    try {
      const d = await api('POST', '/api/scan/resolve', { token });
      location.hash = '#/batch/' + encodeURIComponent(d.batch.batch_code);
    } catch (err) { toast(err.message); }
  }
  async function viewScan(main) {
    main.innerHTML = `
      <h1>Scan a batch QR code</h1>
      <div class="grid cols-2">
        <div class="card"><div id="reader"></div><p id="scan-msg" class="small muted">Point the camera at a batch QR code.</p></div>
        <div class="card"><h3>No camera? Paste the code</h3>
          <form id="manual"><label for="tok">QR link or token</label><input id="tok" placeholder="https://…/verify.html?t=v1.…" required>
          <p><button class="btn" type="submit">Look up</button></p></form>
          <p class="small muted">Every code is signature-checked on the server — copied or forged codes are rejected.</p></div>
      </div>`;
    $('#manual').addEventListener('submit', (e) => { e.preventDefault(); resolveToken($('#tok').value); });
    if (!window.Html5Qrcode) { $('#scan-msg').textContent = 'Camera scanner library could not load (offline?). Use the manual field.'; return; }
    try {
      scanner = new Html5Qrcode('reader'); let done = false;
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, (text) => { if (!done) { done = true; resolveToken(text); } }, () => {});
    } catch (e) { $('#scan-msg').textContent = 'Camera unavailable (permission denied or no camera). Use the manual field.'; scanner = null; }
  }

  // ---------- audit ----------
  async function viewAudit(main) {
    main.innerHTML = `
      <h1>Audit — verify every chain</h1>
      <div class="card"><p>Recomputes the SHA-256 chain of every batch from the stored records and compares it with the recorded hashes.</p>
      <button id="run" class="btn">Run full verification</button></div>
      <div id="audit-out"></div>
      ${meta.tamper_demo ? `<div class="card"><h3>Tamper-detection demo (admin)</h3>
        <p class="small muted">Simulates an insider editing a weight directly in the database, bypassing the API. Enabled by ENABLE_TAMPER_DEMO.</p>
        <div class="row"><div><label for="t-code">Batch code</label><input id="t-code" placeholder="ZM-CU-2026-0001"></div>
        <div><button id="t-go" class="btn danger" type="button">Tamper</button> <button id="t-undo" class="btn secondary" type="button">Restore</button></div></div></div>` : ''}`;
    const run = async () => {
      const r = await api('GET', '/api/audit/verify');
      $('#audit-out').innerHTML = `
        <div class="banner ${r.batches_tampered ? 'bad' : 'ok'}">${r.batches_tampered ? `✖ ${r.batches_tampered} batch(es) failed verification` : '✔ All chains intact'}
          <span class="small">${r.batches_valid}/${r.batches_checked} batches valid · checked ${fmtDate(r.checked_at)}</span></div>
        <div class="card table-wrap"><table><thead><tr><th>Batch</th><th>Events</th><th>Result</th></tr></thead><tbody>
        ${r.results.map((x) => `<tr class="click" data-code="${esc(x.batch_code)}"><td class="mono">${esc(x.batch_code)}</td><td>${x.events}</td>
          <td>${x.valid ? '<span class="badge ok">valid</span>' : `<span class="badge bad">TAMPERED</span> <span class="small">${esc(x.reason)} (event #${x.brokenAtSeq})</span>`}</td></tr>`).join('')}
        </tbody></table></div>`;
    };
    $('#run').addEventListener('click', () => run().catch((e) => toast(e.message)));
    $('#audit-out').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-code]'); if (tr) location.hash = '#/batch/' + encodeURIComponent(tr.dataset.code); });
    if (meta.tamper_demo) {
      $('#t-go').addEventListener('click', async () => { try { const r = await api('POST', '/api/admin/demo/tamper', { batch_code: $('#t-code').value }); toast(`Weight changed ${r.original_weight_kg} → ${r.forged_weight_kg}. Now run verification.`); } catch (e) { toast(e.message); } });
      $('#t-undo').addEventListener('click', async () => { try { await api('POST', '/api/admin/demo/restore', { batch_code: $('#t-code').value }); toast('Original value restored'); } catch (e) { toast(e.message); } });
    }
  }

  // ---------- users, stops and access requests ----------
  async function viewUsers(main) {
    const [{ users }, { stops, types }] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/stops')]);
    const pending = users.filter((u) => u.status === 'pending');
    const others = users.filter((u) => u.status !== 'pending');
    const roles = ['mine', 'transporter', 'weighbridge', 'inspector', 'regulator', 'buyer', 'border', 'port', 'admin'];
    const link = (id) => `${location.origin}/#/signup/${id}`;
    const where = (u) => (u.stop_name ? `${esc(u.stop_name)} <span class="muted small">(${esc(u.stop_country)})</span>` : '<span class="muted">—</span>');
    main.innerHTML = `
      <h1>Users, stops &amp; access requests</h1>

      <div class="card">
        <h2>Access requests ${pending.length ? `<span class="badge warn">${pending.length} waiting</span>` : ''}</h2>
        ${pending.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Applicant</th><th>Organisation</th><th>Stop</th><th>Account type</th><th>Contact</th><th>Requested</th><th></th></tr></thead><tbody>
          ${pending.map((u) => `<tr><td>${esc(u.full_name)}<br><span class="mono small muted">${esc(u.username)}</span></td><td>${esc(u.organisation)}</td><td>${where(u)}</td>
            <td>${esc(u.role)}</td><td class="small">${esc(u.contact || '—')}</td><td class="small">${fmtDate(u.created_at)}</td>
            <td style="white-space:nowrap"><button class="btn" data-a="approve" data-id="${u.id}" style="padding:.25rem .7rem">Approve</button>
              <button class="btn secondary" data-a="reject" data-id="${u.id}" style="padding:.25rem .7rem">Reject</button></td></tr>`).join('')}
          </tbody></table></div>
          <p class="small muted">Check that the person really works at the stop they chose before approving. They can record events only at that stop.</p>`
        : '<p class="muted">No requests waiting.</p>'}
      </div>

      <div class="card">
        <h2>Stops</h2>
        <p class="small muted">A stop is a place where information is recorded. People sign up at a stop and get the matching account type. Share a stop’s link so its staff can request access directly.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Stop</th><th>Country</th><th>Type</th><th>Sign-up link</th><th></th></tr></thead><tbody>
          ${stops.map((st) => `<tr><td>${esc(st.name)}${st.region ? `<br><span class="muted small">${esc(st.region)}</span>` : ''}</td><td>${esc(st.country)}</td>
            <td>${esc(st.type_label)}<br><span class="muted small">→ ${esc(st.role_label)}</span></td>
            <td><button class="btn secondary" data-a="copy" data-link="${esc(link(st.id))}" style="padding:.2rem .6rem" ${st.active ? '' : 'disabled'}>Copy link</button></td>
            <td>${st.active ? '<span class="badge ok">open</span>' : '<span class="badge bad">closed</span>'}
              <button class="btn secondary" data-a="stop-toggle" data-id="${st.id}" data-act="${st.active ? 0 : 1}" style="padding:.2rem .6rem">${st.active ? 'Close sign-ups' : 'Reopen'}</button></td></tr>`).join('')}
          </tbody></table></div>
        <h3 style="margin-top:1rem">Add a stop</h3>
        <form id="ns"><div class="row">
          <div><label for="ns-n">Name</label><input id="ns-n" required maxlength="120" placeholder="e.g. Walvis Bay Port"></div>
          <div><label for="ns-c">Country</label><input id="ns-c" required maxlength="60" placeholder="e.g. Namibia"></div>
          <div><label for="ns-r">Region (optional)</label><input id="ns-r" maxlength="60" placeholder="e.g. Erongo"></div>
          <div><label for="ns-t">Type</label><select id="ns-t">${Object.entries(types).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
        </div><p><button class="btn" type="submit">Add stop</button></p></form>
      </div>

      <div class="card table-wrap"><h2>Accounts</h2><table><thead><tr><th>Username</th><th>Name</th><th>Organisation</th><th>Role</th><th>Stop</th><th>Status</th><th></th></tr></thead><tbody>
      ${others.map((u) => `<tr><td class="mono">${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.organisation)}</td><td>${esc(u.role)}</td><td>${where(u)}</td>
        <td>${u.status === 'rejected' ? '<span class="badge bad">rejected</span>' : u.active ? '<span class="badge ok">active</span>' : '<span class="badge bad">disabled</span>'}</td>
        <td>${u.id === me.id || u.status === 'rejected' ? '' : `<button class="btn secondary" data-a="user-toggle" data-id="${u.id}" data-act="${u.active ? 0 : 1}" style="padding:.2rem .6rem">${u.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('')}
      </tbody></table></div>

      <div class="card"><h3>Create an account directly</h3><form id="nu">
        <div class="row"><div><label for="nu-u">Username</label><input id="nu-u" required></div>
        <div><label for="nu-p">Password (min 8)</label><input id="nu-p" type="password" minlength="8" required autocomplete="new-password"></div>
        <div><label for="nu-s">Stop (optional)</label><select id="nu-s"><option value="">— none, choose a role —</option>${stops.filter((x) => x.active).map((st) => `<option value="${st.id}">${esc(st.name)} (${esc(st.country)})</option>`).join('')}</select></div>
        <div><label for="nu-r">Role</label><select id="nu-r">${roles.map((r) => `<option>${r}</option>`).join('')}</select></div></div>
        <div class="row"><div><label for="nu-n">Full name</label><input id="nu-n" required></div>
        <div><label for="nu-o">Organisation</label><input id="nu-o" required></div></div>
        <p class="small muted" id="nu-hint">Accounts created here are active immediately. When a stop is chosen its type decides the role.</p>
        <p><button class="btn" type="submit">Create</button></p></form></div>`;

    $('#nu-s').addEventListener('change', () => { $('#nu-r').disabled = !!$('#nu-s').value; });
    main.onclick = async (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const act = b.dataset.a;
      try {
        if (act === 'copy') {
          try { await navigator.clipboard.writeText(b.dataset.link); toast('Sign-up link copied'); } catch (_) { toast(b.dataset.link); }
          return;
        }
        if (act === 'approve') { await api('POST', `/api/users/${b.dataset.id}/approve`); toast('Approved: they can now sign in'); }
        else if (act === 'reject') { await api('POST', `/api/users/${b.dataset.id}/reject`); toast('Request rejected'); }
        else if (act === 'user-toggle') await api('PATCH', `/api/users/${b.dataset.id}/active`, { active: b.dataset.act === '1' });
        else if (act === 'stop-toggle') await api('PATCH', `/api/stops/${b.dataset.id}/active`, { active: b.dataset.act === '1' });
        route();
      } catch (err) { toast(err.message); }
    };
    $('#ns').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/stops', { name: $('#ns-n').value, country: $('#ns-c').value, region: $('#ns-r').value, stop_type: $('#ns-t').value });
        toast('Stop added: people can now sign up there'); route();
      } catch (err) { toast(err.message); }
    });
    $('#nu').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/users', { username: $('#nu-u').value, password: $('#nu-p').value, role: $('#nu-r').value, stop_id: $('#nu-s').value || undefined, full_name: $('#nu-n').value, organisation: $('#nu-o').value });
        toast('User created'); route();
      } catch (err) { toast(err.message); }
    });
  }

  // ---------- boot ----------
  if (store.token) start(); else showLogin();
})();
