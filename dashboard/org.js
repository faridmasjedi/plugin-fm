// NomadSF Org explorer: query, data, users & access, metadata, tests, activity.
// Loaded only by the live dashboard (sf fm dashboard); uses helpers from index.html.
(() => {
  const { esc, post, getJson, fmtTime, go } = window.NomadSF;
  const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
  const store = {
    get: (k, d) => {
      try {
        return JSON.parse(localStorage.getItem(`nomadsf.${k}`)) ?? d;
      } catch (e) {
        return d;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(`nomadsf.${k}`, JSON.stringify(v));
      } catch (e) {
        /* ignore */
      }
    },
  };
  const S = { org: store.get('org', ''), tab: store.get('orgTab', 'query'), orgs: [], sobjects: null, describe: null };
  let main;

  // ---------- results table ----------
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const toCsv = (cols, rows) =>
    [cols.join(','), ...rows.map((r) => cols.map((c) => `"${cell(r[c]).replace(/"/g, '""')}"`).join(','))].join('\n');

  /** Sortable, filterable table with copy / CSV / JSON export. Returns { selected() }. */
  function resultTable(el, data, opts = {}) {
    const cols = data.columns || (data.rows[0] ? Object.keys(data.rows[0]) : []);
    const st = {
      sort: null,
      dir: 1,
      filter: '',
      colFilters: {},
      selected: new Set(opts.selectAll ? data.rows.map((_, i) => i) : []),
    };
    const LIMIT = 1000;
    const match = (value, f) => {
      const v = cell(value).toLowerCase();
      const q = f.toLowerCase();
      if (q.startsWith('=')) return v === q.slice(1);
      if (q.startsWith('!')) return !v.includes(q.slice(1));
      if (/^[<>]/.test(q) && !isNaN(parseFloat(q.slice(1))))
        return q[0] === '<' ? parseFloat(v) < parseFloat(q.slice(1)) : parseFloat(v) > parseFloat(q.slice(1));
      return v.includes(q);
    };
    const visible = () => {
      let rows = data.rows.map((r, i) => ({ r, i }));
      if (st.filter) rows = rows.filter(({ r }) => cols.some((c) => match(r[c], st.filter)));
      for (const [c, f] of Object.entries(st.colFilters)) if (f) rows = rows.filter(({ r }) => match(r[c], f));
      if (st.sort)
        rows.sort((a, b) => {
          const x = a.r[st.sort],
            y = b.r[st.sort];
          const nx = parseFloat(x),
            ny = parseFloat(y);
          return (isNaN(nx) || isNaN(ny) ? cell(x).localeCompare(cell(y)) : nx - ny) * st.dir;
        });
      return rows;
    };
    const fmt = (c, v) => {
      const s = cell(v);
      if (ID_RE.test(s) && (c === 'Id' || c.endsWith('Id') || c.endsWith('.Id')) && data.instanceUrl)
        return `<a href="${esc(data.instanceUrl)}/${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a>`;
      return esc(s.length > 300 ? `${s.slice(0, 300)}…` : s);
    };
    function render() {
      const rows = visible();
      const shown = rows.slice(0, LIMIT);
      el.innerHTML = `
        <div class="rt-bar">
          <input class="rt-filter" placeholder="Filter all columns…  (=exact  !not  >10  <5)" value="${esc(st.filter)}">
          <span class="desc">${rows.length.toLocaleString()} of ${data.rows.length.toLocaleString()} rows${
        data.truncated ? ' · more rows in the org (use Bulk export)' : ''
      }${data.tookMs ? ` · ${data.tookMs} ms` : ''}</span>
          <span style="flex:1"></span>
          <button data-x="copy">Copy</button><button data-x="csv">CSV</button><button data-x="json">JSON</button>
        </div>
        <div class="rt-wrap"><table class="rt"><thead>
          <tr>${opts.selectable ? '<th class="sel"><input type="checkbox" data-all></th>' : ''}${cols
        .map((c) => `<th data-sort="${esc(c)}">${esc(c)}${st.sort === c ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`)
        .join('')}</tr>
          <tr class="filters">${opts.selectable ? '<th></th>' : ''}${cols
        .map((c) => `<th><input data-col="${esc(c)}" value="${esc(st.colFilters[c] || '')}" placeholder="filter"></th>`)
        .join('')}</tr>
        </thead><tbody>${shown
          .map(
            ({ r, i }) =>
              `<tr>${
                opts.selectable
                  ? `<td class="sel"><input type="checkbox" data-i="${i}" ${st.selected.has(i) ? 'checked' : ''}></td>`
                  : ''
              }${cols.map((c) => `<td>${fmt(c, r[c])}</td>`).join('')}</tr>`
          )
          .join('')}</tbody></table></div>
        ${
          rows.length > LIMIT
            ? `<p class="desc">Showing the first ${LIMIT} rows. Filter, or download CSV for all ${rows.length.toLocaleString()}.</p>`
            : ''
        }`;
      const keepFocus = (sel, fn) => {
        const input = el.querySelector(sel);
        input.oninput = () => {
          fn(input.value);
          const pos = input.selectionStart;
          render();
          const again = el.querySelector(sel);
          again.focus();
          again.setSelectionRange(pos, pos);
        };
      };
      keepFocus('.rt-filter', (v) => {
        st.filter = v;
      });
      el.querySelectorAll('[data-col]').forEach((input) =>
        keepFocus(`[data-col="${CSS.escape(input.dataset.col)}"]`, (v) => {
          st.colFilters[input.dataset.col] = v;
        })
      );
      el.querySelectorAll('[data-sort]').forEach(
        (th) =>
          (th.onclick = () => {
            st.dir = st.sort === th.dataset.sort ? -st.dir : 1;
            st.sort = th.dataset.sort;
            render();
          })
      );
      el.querySelectorAll('[data-i]').forEach(
        (cb) =>
          (cb.onchange = () => {
            const i = Number(cb.dataset.i);
            cb.checked ? st.selected.add(i) : st.selected.delete(i);
          })
      );
      const all = el.querySelector('[data-all]');
      if (all)
        all.onchange = () => {
          for (const { i } of visible()) all.checked ? st.selected.add(i) : st.selected.delete(i);
          render();
        };
      const out = () => visible().map(({ r }) => r);
      const name = (opts.name || data.sobject || 'results').replace(/[^\w-]/g, '_');
      el.querySelector('[data-x="copy"]').onclick = () =>
        navigator.clipboard.writeText(
          [cols.join('\t'), ...out().map((r) => cols.map((c) => cell(r[c])).join('\t'))].join('\n')
        );
      el.querySelector('[data-x="csv"]').onclick = () => download(`${name}.csv`, toCsv(cols, out()), 'text/csv');
      el.querySelector('[data-x="json"]').onclick = () =>
        download(`${name}.json`, JSON.stringify(out(), null, 2), 'application/json');
    }
    render();
    return { selected: () => [...st.selected].map((i) => data.rows[i]) };
  }

  // ---------- helpers ----------
  const orgType = () => (S.orgs.find((o) => (o.alias || o.username) === S.org) || {}).type || '';
  const confirmChange = (what) => {
    const warn = ['Production', 'Dev Hub'].includes(orgType()) ? `\n\n⚠ ${S.org} is a ${orgType()} org.` : '';
    const typed = prompt(`${what}${warn}\n\nType the org name "${S.org}" to confirm:`);
    return typed === S.org ? typed : null;
  };
  async function call(fn, statusEl) {
    if (statusEl) statusEl.innerHTML = '<span class="desc">Working…</span>';
    try {
      const r = await fn();
      if (statusEl) statusEl.innerHTML = '';
      return r;
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<div class="error">${esc(e.message)}</div>`;
      return undefined;
    }
  }
  async function api(path, body) {
    const res = body ? await post(path, body) : await getJson(path);
    if (res && res.error) throw new Error(res.error);
    return res;
  }
  const qs = (o) => new URLSearchParams({ org: S.org, ...o }).toString();

  // ---------- page ----------
  async function render(el) {
    main = el;
    if (!S.orgs.length) S.orgs = await getJson('/api/orgs').catch(() => []);
    if (!S.org && S.orgs[0]) S.org = S.orgs[0].alias || S.orgs[0].username;
    const tabs = [
      ['query', 'Query'],
      ['data', 'Data'],
      ['access', 'Users & access'],
      ['metadata', 'Metadata'],
      ['tests', 'Tests'],
      ['activity', 'Activity'],
    ];
    main.innerHTML = `
      <div class="org-head">
        <h1>Org explorer</h1>
        <select id="oxOrg">${S.orgs
          .map(
            (o) =>
              `<option value="${esc(o.alias || o.username)}" ${
                (o.alias || o.username) === S.org ? 'selected' : ''
              }>${esc(o.alias || o.username)} — ${esc(o.type)}</option>`
          )
          .join('')}</select>
        ${['Production', 'Dev Hub'].includes(orgType()) ? `<span class="pill failed">${esc(orgType())}</span>` : ''}
      </div>
      ${S.orgs.length ? '' : '<div class="error">No orgs connected. Connect one on the Orgs page.</div>'}
      <div class="tabs">${tabs
        .map(([id, label]) => `<div class="tab ${S.tab === id ? 'active' : ''}" data-tab="${id}">${label}</div>`)
        .join('')}</div>
      <div id="oxBody"></div>`;
    main.querySelector('#oxOrg').onchange = (e) => {
      S.org = e.target.value;
      store.set('org', S.org);
      S.sobjects = null;
      render(main);
    };
    main.querySelectorAll('[data-tab]').forEach(
      (t) =>
        (t.onclick = () => {
          S.tab = t.dataset.tab;
          store.set('orgTab', S.tab);
          render(main);
        })
    );
    if (!S.org) return;
    (
      ({
        query: renderQuery,
        data: renderData,
        access: renderAccess,
        metadata: renderMetadata,
        tests: renderTests,
        activity: renderActivity,
      })[S.tab] || renderQuery
    )(main.querySelector('#oxBody'));
  }

  // ---------- Query ----------
  async function renderQuery(el) {
    const history = store.get('history', []);
    const soql = store.get('soql', 'SELECT Id, Name, CreatedDate FROM Account ORDER BY CreatedDate DESC LIMIT 100');
    el.innerHTML = `
      <div class="ox-split">
        <div class="card ox-side">
          <input id="oxObjFilter" placeholder="Objects…">
          <div id="oxObjects" class="ox-list"><span class="desc">Loading…</span></div>
          <div id="oxFields"></div>
        </div>
        <div>
          <div class="card">
            <textarea id="oxSoql" class="ox-editor" spellcheck="false">${esc(soql)}</textarea>
            <div class="form">
              <label class="check"><input type="checkbox" id="oxTooling" ${
                store.get('tooling', false) ? 'checked' : ''
              }> Tooling API</label>
              <label class="check"><input type="checkbox" id="oxAll"> Include deleted &amp; archived</label>
              <label>Max rows<select id="oxMax"><option>2000</option><option selected>10000</option><option>50000</option></select></label>
              <select id="oxHistory"><option value="">History…</option>${history
                .map((h, i) => `<option value="${i}">${esc(h.slice(0, 90))}</option>`)
                .join('')}</select>
              <span style="flex:1"></span>
              <button id="oxBulk" title="Bulk API 2.0 export to CSV">Bulk export</button>
              <button class="primary" id="oxRun">Run ⌘⏎</button>
            </div>
            <div id="oxStatus"></div>
          </div>
          <div class="card" id="oxResults"><p class="desc">Results appear here. Click an object on the left to see its fields; “All fields” writes a SELECT with every field.</p></div>
        </div>
      </div>`;
    const ed = el.querySelector('#oxSoql');
    const tooling = el.querySelector('#oxTooling');
    const run = async () => {
      const q = ed.value.trim();
      if (!q) return;
      store.set('soql', q);
      store.set('tooling', tooling.checked);
      store.set('history', [q, ...history.filter((h) => h !== q)].slice(0, 25));
      const data = await call(
        () =>
          api('/api/org/query', {
            org: S.org,
            soql: q,
            tooling: tooling.checked,
            includeDeleted: el.querySelector('#oxAll').checked,
            maxRows: Number(el.querySelector('#oxMax').value),
          }),
        el.querySelector('#oxStatus')
      );
      if (data) resultTable(el.querySelector('#oxResults'), data);
    };
    el.querySelector('#oxRun').onclick = run;
    ed.onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    };
    el.querySelector('#oxHistory').onchange = (e) => {
      if (e.target.value !== '') ed.value = history[Number(e.target.value)];
    };
    el.querySelector('#oxBulk').onclick = async () => {
      const r = await call(
        () =>
          api('/api/org/bulk/export', {
            org: S.org,
            soql: ed.value,
            includeDeleted: el.querySelector('#oxAll').checked,
          }),
        el.querySelector('#oxStatus')
      );
      if (r)
        el.querySelector(
          '#oxStatus'
        ).innerHTML = `<p>Exported ${r.rows.toLocaleString()} rows — <a href="/api/org/exports/${encodeURIComponent(
          r.file
        )}">download ${esc(r.file)}</a></p>`;
    };
    tooling.onchange = () => {
      S.sobjects = null;
      loadObjects();
    };

    const listEl = el.querySelector('#oxObjects');
    async function loadObjects() {
      if (tooling.checked) {
        listEl.innerHTML =
          '<p class="desc">Tooling objects: type the object name in the query, then use All fields.</p>';
        return;
      }
      if (!S.sobjects)
        S.sobjects = await api(`/api/org/sobjects?${qs({})}`).catch((e) => {
          listEl.innerHTML = `<div class="error">${esc(e.message)}</div>`;
          return null;
        });
      if (!S.sobjects) return;
      const f = el.querySelector('#oxObjFilter').value.toLowerCase();
      listEl.innerHTML = S.sobjects
        .filter((o) => !f || o.name.toLowerCase().includes(f) || o.label.toLowerCase().includes(f))
        .slice(0, 300)
        .map(
          (o) =>
            `<div class="ox-item" data-obj="${esc(o.name)}"><b>${esc(o.name)}</b><span class="desc"> ${esc(
              o.label
            )}</span></div>`
        )
        .join('');
      listEl.querySelectorAll('[data-obj]').forEach((it) => (it.onclick = () => showFields(it.dataset.obj)));
    }
    el.querySelector('#oxObjFilter').oninput = loadObjects;
    async function showFields(name) {
      const fieldsEl = el.querySelector('#oxFields');
      fieldsEl.innerHTML = '<p class="desc">Loading fields…</p>';
      const d = await api(`/api/org/describe?${qs({ sobject: name, tooling: tooling.checked ? '1' : '' })}`).catch(
        (e) => ({ error: e.message })
      );
      if (d.error) {
        fieldsEl.innerHTML = `<div class="error">${esc(d.error)}</div>`;
        return;
      }
      fieldsEl.innerHTML = `
        <div class="ox-fields-head"><b>${esc(d.name)}</b> <span class="desc">${d.fields.length} fields</span></div>
        <div class="form"><button id="oxAllFields">All fields</button><button id="oxCount">Count</button></div>
        <input id="oxFieldFilter" placeholder="Fields…">
        <div class="ox-list" id="oxFieldList"></div>`;
      const draw = () => {
        const f = fieldsEl.querySelector('#oxFieldFilter').value.toLowerCase();
        fieldsEl.querySelector('#oxFieldList').innerHTML = d.fields
          .filter((x) => !f || x.name.toLowerCase().includes(f) || x.label.toLowerCase().includes(f))
          .map(
            (x) =>
              `<div class="ox-item" data-field="${esc(
                x.relationshipName && x.referenceTo.length ? `${x.relationshipName}.Name` : x.name
              )}" title="${esc(x.label)} · ${esc(x.type)}${
                x.referenceTo.length ? ` → ${esc(x.referenceTo.join(', '))}` : ''
              }">${esc(x.name)} <span class="desc">${esc(x.type)}</span></div>`
          )
          .join('');
        fieldsEl.querySelectorAll('[data-field]').forEach(
          (it) =>
            (it.onclick = () => {
              const pos = ed.selectionStart;
              const v = ed.value;
              const insert = (/[\s,(]$/.test(v.slice(0, pos)) ? '' : ', ') + it.dataset.field;
              ed.value = v.slice(0, pos) + insert + v.slice(pos);
              ed.focus();
              ed.selectionStart = ed.selectionEnd = pos + insert.length;
            })
        );
      };
      fieldsEl.querySelector('#oxFieldFilter').oninput = draw;
      draw();
      fieldsEl.querySelector('#oxAllFields').onclick = async () => {
        const r = await api(`/api/org/all-fields?${qs({ sobject: name, tooling: tooling.checked ? '1' : '' })}`);
        ed.value = r.soql;
      };
      fieldsEl.querySelector('#oxCount').onclick = () => {
        ed.value = `SELECT COUNT() FROM ${name}`;
      };
    }
    loadObjects();
  }

  // ---------- Data ----------
  function renderData(el) {
    el.innerHTML = `
      <div class="grid2">
        <div class="card"><h2>Import / update / delete (Bulk API 2.0)</h2>
          <p class="desc">CSV with a header row of API field names. Delete and hard delete need an <code>Id</code> column.</p>
          <div class="form vertical">
            <label>Object<input id="dxObj" placeholder="Account" list="dxObjects"></label><datalist id="dxObjects">${(
              S.sobjects || []
            )
              .map((o) => `<option value="${esc(o.name)}">`)
              .join('')}</datalist>
            <label>Operation<select id="dxOp"><option value="insert">Insert</option><option value="update">Update</option><option value="upsert">Upsert</option><option value="delete">Delete</option><option value="hardDelete">Hard delete (skips recycle bin)</option></select></label>
            <label id="dxExtWrap" style="display:none">External ID field<input id="dxExt" placeholder="External_Id__c"></label>
            <label>CSV file<input type="file" id="dxFile" accept=".csv,text/csv"></label>
            <div id="dxPreview" class="desc"></div>
            <div><button class="primary" id="dxGo" disabled>Run</button></div>
          </div>
          <div id="dxStatus"></div><div id="dxResult"></div>
        </div>
        <div class="card"><h2>Delete records matching a query</h2>
          <p class="desc">Every record the query returns is deleted with Bulk API 2.0. Check the count first.</p>
          <textarea id="ddSoql" class="ox-editor" style="min-height:90px" spellcheck="false">SELECT Id FROM Case WHERE Subject LIKE 'TEST%'</textarea>
          <div class="form"><label class="check"><input type="checkbox" id="ddHard"> Hard delete</label><button id="ddCount">Count</button><button class="danger" id="ddGo">Delete…</button></div>
          <div id="ddStatus"></div>
          <h2 style="margin-top:18px">Export</h2><p class="desc">Use <b>Bulk export</b> on the Query tab to download any query as CSV, including deleted and archived records.</p>
        </div>
      </div>`;
    let csv = '';
    const op = el.querySelector('#dxOp');
    op.onchange = () => {
      el.querySelector('#dxExtWrap').style.display = op.value === 'upsert' ? '' : 'none';
    };
    el.querySelector('#dxFile').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        csv = String(reader.result);
        const lines = csv.split(/\r?\n/).filter(Boolean);
        el.querySelector('#dxPreview').innerHTML = `${esc(file.name)} · ${(
          lines.length - 1
        ).toLocaleString()} rows · columns: <code>${esc(lines[0] || '')}</code>`;
        el.querySelector('#dxGo').disabled = lines.length < 2;
      };
      reader.readAsText(file);
    };
    el.querySelector('#dxGo').onclick = async () => {
      const sobject = el.querySelector('#dxObj').value.trim();
      const confirm = confirmChange(
        `${op.selectedOptions[0].text} ${(
          csv.split(/\r?\n/).filter(Boolean).length - 1
        ).toLocaleString()} ${sobject} records in ${S.org}.`
      );
      if (!confirm) return;
      const r = await call(
        () =>
          api('/api/org/bulk/ingest', {
            org: S.org,
            sobject,
            operation: op.value,
            csv,
            externalIdField: el.querySelector('#dxExt').value.trim(),
            confirm,
          }),
        el.querySelector('#dxStatus')
      );
      if (!r) return;
      el.querySelector('#dxResult').innerHTML = `<div class="metrics"><div class="metric good"><div class="v">${
        r.succeeded
      }</div><div class="l">Succeeded</div></div><div class="metric ${r.failed ? 'bad' : ''}"><div class="v">${
        r.failed
      }</div><div class="l">Failed</div></div><div class="metric"><div class="v">${
        r.unprocessed
      }</div><div class="l">Unprocessed</div></div></div>
        ${
          r.failuresFile
            ? `<p><a href="/api/org/exports/${encodeURIComponent(r.failuresFile)}">Download failures CSV</a></p>`
            : ''
        }<div id="dxFailures"></div>`;
      if (r.failures.length) resultTable(el.querySelector('#dxFailures'), { rows: r.failures, name: 'failures' });
    };
    const soqlEl = el.querySelector('#ddSoql');
    el.querySelector('#ddCount').onclick = async () => {
      const from = /\bfrom\s+[\s\S]*/i.exec(soqlEl.value);
      if (!from) return;
      const r = await call(
        () => api('/api/org/query', { org: S.org, soql: `SELECT COUNT() ${from[0].replace(/\blimit\s+\d+/i, '')}` }),
        el.querySelector('#ddStatus')
      );
      if (r) el.querySelector('#ddStatus').innerHTML = `<p><b>${r.totalSize.toLocaleString()}</b> record(s) match.</p>`;
    };
    el.querySelector('#ddGo').onclick = async () => {
      const hard = el.querySelector('#ddHard').checked;
      const confirm = confirmChange(`${hard ? 'HARD delete' : 'Delete'} every record returned by:\n${soqlEl.value}`);
      if (!confirm) return;
      const r = await call(
        () => api('/api/org/bulk/delete-query', { org: S.org, soql: soqlEl.value, hardDelete: hard, confirm }),
        el.querySelector('#ddStatus')
      );
      if (r)
        el.querySelector('#ddStatus').innerHTML = `<p>Deleted <b>${r.succeeded}</b>, failed <b>${r.failed}</b>.${
          r.failuresFile ? ` <a href="/api/org/exports/${encodeURIComponent(r.failuresFile)}">Failures CSV</a>` : ''
        }</p>`;
    };
  }

  // ---------- Users & access ----------
  async function renderAccess(el) {
    el.innerHTML = `
      <div class="grid2">
        <div class="card"><h2>Login history</h2><div class="form"><label>Last<select id="lhDays"><option>1</option><option selected>7</option><option>30</option><option>90</option><option>180</option></select></label><span class="desc">days</span><button class="primary" id="lhGo">Load</button></div></div>
        <div class="card"><h2>Setup audit trail</h2><div class="form"><label>Last<select id="atDays"><option>7</option><option selected>30</option><option>90</option><option>180</option></select></label><span class="desc">days</span><button class="primary" id="atGo">Load</button></div></div>
      </div>
      <div class="card" id="logResult" style="display:none"></div>
      <div class="card"><h2>Permission sets &amp; groups</h2>
        <div class="form"><input id="psFilter" placeholder="Filter permission sets…" style="min-width:260px"><select id="psSelect" style="min-width:360px"><option value="">Loading…</option></select></div>
        <div class="grid2">
          <div><h3>Assigned users</h3><div id="psStatus"></div><div id="psAssigned"><p class="desc">Choose a permission set.</p></div><div class="form"><button class="danger" id="psRemove" disabled>Remove selected…</button></div></div>
          <div><h3>Assign to users</h3>
            <div class="form vertical">
              <label>Find users by<select id="psBy"><option value="usernames">Usernames</option><option value="profile">Profile</option><option value="role">Role</option><option value="publicGroup">Public group</option></select></label>
              <label id="psValueLabel">Usernames (comma or new line)<textarea id="psValue" rows="3"></textarea></label>
              <label>Expires (optional)<input type="date" id="psExpires"></label>
              <div><button id="psFind">Find users</button></div>
            </div>
            <div id="psUsers"></div><div class="form"><button class="primary" id="psAssign" disabled>Assign to selected…</button></div><div id="psAssignStatus"></div>
          </div>
        </div>
      </div>`;
    const showLog = async (path, name) => {
      const box = el.querySelector('#logResult');
      box.style.display = '';
      box.innerHTML = `<h2>${esc(name)}</h2><div id="logTable"><p class="desc">Loading…</p></div>`;
      const r = await call(() => api(path), box.querySelector('#logTable'));
      if (r) resultTable(box.querySelector('#logTable'), { ...r, name: `${S.org}-${name}` });
    };
    el.querySelector('#lhGo').onclick = () =>
      showLog(`/api/org/login-history?${qs({ days: el.querySelector('#lhDays').value })}`, 'login-history');
    el.querySelector('#atGo').onclick = () =>
      showLog(`/api/org/audit-trail?${qs({ days: el.querySelector('#atDays').value })}`, 'audit-trail');

    const sets = await api(`/api/org/permsets?${qs({})}`).catch((e) => {
      el.querySelector('#psStatus').innerHTML = `<div class="error">${esc(e.message)}</div>`;
      return [];
    });
    const select = el.querySelector('#psSelect');
    const fill = () => {
      const f = el.querySelector('#psFilter').value.toLowerCase();
      select.innerHTML =
        '<option value="">Choose…</option>' +
        sets
          .filter((p) => !f || p.label.toLowerCase().includes(f) || p.name.toLowerCase().includes(f))
          .map(
            (p) =>
              `<option value="${p.kind}:${p.id}">${p.kind === 'group' ? '▣ ' : ''}${esc(p.label)} (${esc(
                p.name
              )})</option>`
          )
          .join('');
    };
    el.querySelector('#psFilter').oninput = fill;
    fill();
    let assignedTable;
    let usersTable;
    const target = () => {
      const [kind, id] = select.value.split(':');
      return id ? { kind, id } : null;
    };
    const loadAssigned = async () => {
      const t = target();
      if (!t) return;
      const r = await call(() => api(`/api/org/assignments?${qs(t)}`), el.querySelector('#psStatus'));
      if (!r) return;
      assignedTable = resultTable(el.querySelector('#psAssigned'), { ...r, name: 'assignments' }, { selectable: true });
      el.querySelector('#psRemove').disabled = false;
    };
    select.onchange = loadAssigned;
    el.querySelector('#psRemove').onclick = async () => {
      const ids = (assignedTable ? assignedTable.selected() : []).map((r) => r.Id);
      if (!ids.length) return;
      const confirm = confirmChange(`Remove ${ids.length} assignment(s) of ${select.selectedOptions[0].text}.`);
      if (!confirm) return;
      const r = await call(
        () => api('/api/org/unassign', { org: S.org, assignmentIds: ids, confirm }),
        el.querySelector('#psStatus')
      );
      if (r) {
        await loadAssigned();
        el.querySelector('#psStatus').innerHTML = `<p>Removed ${r.removed}.${
          r.errors.length ? ` Errors: ${esc(r.errors.join('; '))}` : ''
        }</p>`;
      }
    };
    const by = el.querySelector('#psBy');
    by.onchange = () => {
      el.querySelector('#psValueLabel').firstChild.textContent = {
        usernames: 'Usernames (comma or new line)',
        profile: 'Profile name',
        role: 'Role name',
        publicGroup: 'Public group (developer or label name)',
      }[by.value];
    };
    el.querySelector('#psFind').onclick = async () => {
      const r = await call(
        () => api('/api/org/users', { org: S.org, [by.value]: el.querySelector('#psValue').value }),
        el.querySelector('#psAssignStatus')
      );
      if (!r) return;
      usersTable = resultTable(
        el.querySelector('#psUsers'),
        { rows: r, name: 'users' },
        { selectable: true, selectAll: true }
      );
      el.querySelector('#psAssign').disabled = !r.length;
    };
    el.querySelector('#psAssign').onclick = async () => {
      const t = target();
      const users = usersTable ? usersTable.selected() : [];
      if (!t) {
        el.querySelector('#psAssignStatus').innerHTML = '<div class="error">Choose a permission set first.</div>';
        return;
      }
      if (!users.length) return;
      const confirm = confirmChange(`Assign ${select.selectedOptions[0].text} to ${users.length} user(s).`);
      if (!confirm) return;
      const r = await call(
        () =>
          api('/api/org/assign', {
            org: S.org,
            target: t,
            userIds: users.map((u) => u.Id),
            expirationDate: el.querySelector('#psExpires').value,
            confirm,
          }),
        el.querySelector('#psAssignStatus')
      );
      if (r) {
        el.querySelector('#psAssignStatus').innerHTML = `<p>Assigned ${r.assigned}, already had it ${r.skipped}.${
          r.errors.length ? ` Errors: ${esc(r.errors.join('; '))}` : ''
        }</p>`;
        loadAssigned();
      }
    };
  }

  // ---------- Metadata ----------
  async function renderMetadata(el) {
    el.innerHTML = `<div class="card"><h2>Retrieve metadata into the project</h2>
      <p class="desc">Lists components in the org with the Metadata API and retrieves the selected ones with <code>sf project retrieve start</code>.</p>
      <div class="form"><input id="mdType" list="mdTypes" placeholder="Metadata type, e.g. ApexClass" style="min-width:300px"><datalist id="mdTypes"></datalist><button class="primary" id="mdList">List</button><button id="mdRetrieve" disabled>Retrieve selected</button></div>
      <div id="mdStatus"></div><div id="mdTable"></div><div id="mdResult"></div></div>`;
    api(`/api/org/metadata-types?${qs({})}`)
      .then((types) => {
        el.querySelector('#mdTypes').innerHTML = types.map((t) => `<option value="${esc(t)}">`).join('');
      })
      .catch(() => {});
    let table;
    el.querySelector('#mdList').onclick = async () => {
      const type = el.querySelector('#mdType').value.trim();
      const r = await call(() => api(`/api/org/metadata?${qs({ type })}`), el.querySelector('#mdStatus'));
      if (!r) return;
      table = resultTable(el.querySelector('#mdTable'), { rows: r, name: `${type}-members` }, { selectable: true });
      el.querySelector('#mdRetrieve').disabled = !r.length;
    };
    el.querySelector('#mdRetrieve').onclick = async () => {
      const rows = table ? table.selected() : [];
      if (!rows.length) return;
      const r = await call(
        () => api('/api/org/retrieve', { org: S.org, members: rows.map((m) => `${m.type}:${m.fullName}`) }),
        el.querySelector('#mdStatus')
      );
      if (!r) return;
      el.querySelector('#mdResult').innerHTML = `<h3>Retrieved</h3>${
        r.error ? `<div class="error">${esc(r.error)}</div>` : ''
      }<div id="mdFiles"></div>`;
      if (r.files.length) resultTable(el.querySelector('#mdFiles'), { rows: r.files, name: 'retrieved' });
    };
  }

  // ---------- Tests (Playwright) ----------
  async function renderTests(el) {
    const info = await api('/api/e2e/specs').catch(() => ({ specs: [], hasConfig: false }));
    if (!info.hasConfig) {
      el.innerHTML = `<div class="empty"><h2>No Playwright setup yet</h2><p>Create one in the Salesforce project, then install Playwright:</p><pre>sf fm e2e init\nnpm install --save-dev @playwright/test\nnpx playwright install chromium</pre></div>`;
      return;
    }
    const runs = await getJson('/api/runs').catch(() => []);
    const last = runs.flatMap((r) => r.stages.filter((s) => s.uses === 'e2e' && s.result).map((s) => ({ r, s })))[0];
    el.innerHTML = `
      <div class="card"><h2>Playwright scenarios</h2>
        <p class="desc">Tests log in to <b>${esc(S.org)}</b> through its frontdoor URL; nothing is stored. ${
      info.specs.length
    } spec file(s) in <code>tests/e2e</code>.</p>
        <div class="form"><input id="e2eGrep" placeholder="Only tests matching… (optional)" style="min-width:300px"><button class="primary" id="e2eRun">Run on ${esc(
          S.org
        )}</button><a href="/api/e2e/report/" target="_blank" rel="noopener">Last HTML report ↗</a></div>
        <div id="e2eStatus"></div>
        <div class="chips">${info.specs.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div>
      </div>
      <div class="card"><h2>Last results</h2>${
        last
          ? `<p class="desc">${fmtTime(last.s.startedAt)} · ${esc(
              last.s.targetOrg || ''
            )} · <a href="#page=runs&run=${esc(last.r.id)}&stage=${esc(
              last.s.id
            )}">open run</a></p><div id="e2eLast"></div>`
          : '<p class="desc">No runs yet.</p>'
      }</div>`;
    if (last)
      resultTable(el.querySelector('#e2eLast'), {
        rows: last.s.result.tests.map((t) => ({
          status: t.status,
          title: t.title,
          file: t.file,
          seconds: (t.durationMs / 1000).toFixed(1),
          retries: t.retries,
          error: t.error || '',
        })),
        name: 'e2e-results',
      });
    el.querySelector('#e2eRun').onclick = async () => {
      const r = await call(
        () => api('/api/e2e/run', { org: S.org, grep: el.querySelector('#e2eGrep').value.trim() }),
        el.querySelector('#e2eStatus')
      );
      if (r) {
        el.querySelector('#e2eStatus').innerHTML = '<p>Started — opening the run…</p>';
        setTimeout(async () => {
          const rs = await getJson('/api/runs');
          go({ page: 'runs', run: rs[0] && rs[0].id, stage: null, view: 'run' });
        }, 2500);
      }
    };
  }

  // ---------- Activity ----------
  async function renderActivity(el) {
    el.innerHTML =
      '<div class="card"><h2>Changes made from NomadSF</h2><p class="desc">Every import, delete, permission change and retrieve is recorded in <code>.fm/org-activity.log</code>.</p><div id="actTable"></div></div>';
    const rows = await api('/api/org/activity').catch(() => []);
    resultTable(el.querySelector('#actTable'), {
      rows: rows.map((r) => ({
        ...r,
        details: JSON.stringify(
          Object.fromEntries(Object.entries(r).filter(([k]) => !['at', 'user', 'org', 'action'].includes(k)))
        ),
      })),
      columns: ['at', 'user', 'org', 'action', 'details'],
      name: 'activity',
    });
  }

  window.NomadSFOrg = { render };
})();
