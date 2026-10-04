// Read-only dashboard page served by the adapter at /dashboard. All data comes from /api/dashboard.
// Message text is untrusted peer input, so the script only ever writes it with textContent.
// Layout follows the image-scoring runs page: 48px shell, sidebar, underline tabs, and short cards.
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mailbox Dashboard</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16">
<style>
  :root {
    --color-bg-primary: #1e1e1e;
    --color-bg-secondary: #252526;
    --color-bg-elevated: #3c3c3c;
    --color-bg-preview: #141414;
    --color-border: #474747;
    --color-border-muted: #3c3c3c;
    --color-text-primary: #cccccc;
    --color-text-secondary: #9d9d9d;
    --color-text-muted: #6d6d6d;
    --color-text-on-accent: #ffffff;
    --color-accent: #007acc;
    --color-accent-hover: #1e8ad6;
    --color-accent-dim: #003f6e;
    --color-accent-bright: #4fc1ff;
    --color-success: #89d185;
    --color-success-bg: #1a3320;
    --color-success-border: #2d6a2d;
    --color-warning: #cca700;
    --color-warning-bg: #332900;
    --color-warning-border: #665200;
    --color-danger: #f44747;
    --color-danger-bg: #3a1515;
    --color-danger-border: #7a2a2a;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    flex-direction: column;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-text-primary);
    background: var(--color-bg-primary);
    -webkit-font-smoothing: antialiased;
  }
  [hidden] { display: none !important; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #424242; border-radius: 2px; }
  ::-webkit-scrollbar-thumb:hover { background: #555; }

  .shell {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 12px;
    height: 48px;
    padding: 0 16px;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--color-bg-secondary);
    border-bottom: 1px solid var(--color-border-muted);
  }
  .brand { display: flex; align-items: center; gap: 8px; margin-right: 16px; }
  .brand-mark { color: var(--color-accent-bright); flex-shrink: 0; }
  .brand-name { font-size: 14px; font-weight: 600; color: var(--color-text-primary); }
  .nav-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-primary);
    background: var(--color-bg-elevated);
  }
  .shell-right { margin-left: auto; display: flex; align-items: center; gap: 12px; min-width: 0; }
  .headline {
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-muted); flex-shrink: 0; }
  .live-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--color-success); }
  .live-dot.is-paused { background: var(--color-warning); }
  .live-dot.is-off { background: var(--color-text-muted); }

  .workspace { display: flex; flex: 1; min-height: 0; }
  .sidebar {
    width: 224px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-bg-secondary);
    border-right: 1px solid var(--color-border-muted);
  }
  .sidebar-action { padding: 12px; border-bottom: 1px solid var(--color-border-muted); }
  .sidebar-scroll { flex: 1; overflow: auto; padding: 8px; }
  .side-label {
    padding: 0 4px;
    margin: 8px 0;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  .side-meta { margin: 4px 4px 8px; font-size: 11px; color: var(--color-text-muted); overflow-wrap: anywhere; }
  .side-link {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--color-text-secondary);
  }
  .side-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--color-text-muted);
    flex-shrink: 0;
  }
  .side-num { margin-left: auto; color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
  .is-hot .side-dot { background: var(--color-danger); }
  .is-ok .side-dot { background: var(--color-success); }
  .is-warn .side-dot { background: var(--color-warning); }
  .is-self { color: var(--color-text-primary); }
  .is-self .side-dot { background: var(--color-success); }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
    padding: 4px 12px;
    border-radius: 6px;
    cursor: pointer;
    background: var(--color-accent);
    color: var(--color-text-on-accent);
    border: 1px solid var(--color-accent-hover);
  }
  .btn:hover { background: var(--color-accent-hover); }
  .btn:focus-visible { outline: 1px solid var(--color-accent-bright); outline-offset: 2px; }

  .content { flex: 1; min-width: 0; overflow: auto; }
  .page { width: 100%; max-width: 1024px; margin: 0 auto; padding: 24px; }
  .page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }
  .page-head h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--color-text-primary);
  }
  .updated { font-size: 12px; color: var(--color-text-secondary); }

  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--color-border-muted);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: -1px;
    padding: 8px 16px;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--color-text-secondary);
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .tab:hover { color: var(--color-text-primary); }
  .tab.is-active { color: var(--color-text-primary); border-bottom-color: var(--color-accent-bright); }
  .tab-count {
    min-width: 20px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--color-bg-elevated);
    color: var(--color-text-secondary);
    font-size: 12px;
    text-align: center;
  }

  .run-card {
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .run-card:hover { border-color: var(--color-accent-bright); }
  .run-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .run-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .run-id {
    flex-shrink: 0;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .run-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text-primary);
  }
  .run-desc {
    margin: 0 0 8px;
    font-size: 11px;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }
  .run-desc summary { cursor: pointer; }
  .run-foot { font-size: 12px; color: var(--color-text-muted); }
  .alert {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 12px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-elevated);
    color: var(--color-text-secondary);
    font-size: 12px;
    font-weight: 500;
  }
  .badge-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--color-text-muted); }
  .badge-success { background: var(--color-success-bg); color: var(--color-success); border-color: var(--color-success-border); }
  .badge-success .badge-dot { background: var(--color-success); }
  .badge-warning { background: var(--color-warning-bg); color: var(--color-warning); border-color: var(--color-warning-border); }
  .badge-warning .badge-dot { background: var(--color-warning); }
  .badge-danger { background: var(--color-danger-bg); color: var(--color-danger); border-color: var(--color-danger-border); }
  .badge-danger .badge-dot { background: var(--color-danger); }
  .badge-running { background: var(--color-accent-dim); color: var(--color-accent-bright); border-color: var(--color-accent); }
  .badge-running .badge-dot { background: var(--color-accent-bright); }
  .badge-muted { background: var(--color-bg-secondary); color: var(--color-text-muted); border-color: var(--color-border-muted); }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 64px 0;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 14px;
  }
  pre {
    margin: 0;
    padding: 16px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 12px/1.5 ui-monospace, Consolas, monospace;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    max-height: 480px;
    overflow: auto;
  }

  @media (max-width: 720px) {
    .workspace { flex-direction: column; }
    .sidebar { width: auto; max-height: 220px; border-right: 0; border-bottom: 1px solid var(--color-border-muted); }
    .page { padding: 16px; }
    .headline { display: none; }
  }
</style>
</head>
<body>
<header class="shell">
  <div class="brand">
    <svg class="brand-mark" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
    </svg>
    <span class="brand-name">Mailbox</span>
  </div>
  <nav>
    <span class="nav-item">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect width="7" height="9" x="3" y="3" rx="1"/>
        <rect width="7" height="5" x="14" y="3" rx="1"/>
        <rect width="7" height="9" x="14" y="12" rx="1"/>
        <rect width="7" height="5" x="3" y="16" rx="1"/>
      </svg>
      Inbox
    </span>
  </nav>
  <div class="shell-right">
    <span id="headline" class="headline"></span>
    <span class="live" title="Refreshes every 5 seconds">
      <span class="live-dot" id="live-dot" aria-hidden="true"></span>
      <span id="live-label">Live</span>
    </span>
  </div>
</header>

<div class="workspace">
  <aside class="sidebar">
    <div class="sidebar-action">
      <button id="toggle" class="btn" type="button">Pause</button>
    </div>
    <div class="sidebar-scroll">
      <div class="side-label">Status</div>
      <div id="who" class="side-link"><span class="side-dot"></span><span>loading</span></div>
      <div id="conn" class="side-link"><span class="side-dot"></span><span>...</span></div>
      <div id="wake" class="side-link"><span class="side-dot"></span><span>wake ...</span></div>
      <p id="route" class="side-meta"></p>
      <div class="side-label">Agents</div>
      <div id="agents"></div>
      <div class="side-label">Inbox</div>
      <div id="inbox"></div>
      <div class="side-label">Tasks</div>
      <div id="tasks"></div>
      <div class="side-label">This PC</div>
      <div id="local"></div>
    </div>
  </aside>

  <main class="content">
    <div class="page">
      <div class="page-head">
        <h1>Mailbox dashboard</h1>
        <span id="stamp" class="updated"></span>
      </div>
      <div class="tabs">
        <button type="button" class="tab is-active" data-filter="received">Received <span id="count-received" class="tab-count">0</span></button>
        <button type="button" class="tab" data-filter="waiting">Waiting <span id="count-waiting" class="tab-count">0</span></button>
        <button type="button" class="tab" data-filter="log">Log</button>
      </div>
      <div id="err" class="alert" hidden></div>
      <div id="received"></div>
      <div id="waiting" hidden></div>
      <div id="logpanel" hidden><pre id="log"></pre></div>
    </div>
  </main>
</div>
<script>
(function () {
  var paused = false;
  var filter = 'received';
  var timer = null;
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function syncLive(offline) {
    var dot = $('live-dot');
    var label = $('live-label');
    if (offline) { dot.className = 'live-dot is-off'; label.textContent = 'Offline'; return; }
    if (paused) { dot.className = 'live-dot is-paused'; label.textContent = 'Paused'; return; }
    dot.className = 'live-dot';
    label.textContent = 'Live';
  }
  function statusRow(node, text, kind) {
    clear(node);
    node.className = 'side-link' + (kind === 'ok' ? ' is-ok' : kind === 'warn' ? ' is-warn' : kind === 'bad' ? ' is-hot' : '');
    node.appendChild(el('span', null, 'side-dot'));
    node.appendChild(el('span', text));
  }
  function badge(text, kind) {
    var node = el('span', null, 'badge badge-' + kind);
    node.appendChild(el('span', null, 'badge-dot'));
    node.appendChild(el('span', text));
    return node;
  }
  function counts(node, data, hot) {
    clear(node);
    if (!data) { node.appendChild(el('div', 'unavailable', 'side-link')); return; }
    Object.keys(data).forEach(function (key) {
      var hotRow = hot.indexOf(key) >= 0 && data[key] > 0;
      var row = el('div', null, 'side-link' + (hotRow ? ' is-hot' : ''));
      row.appendChild(el('span', null, 'side-dot'));
      row.appendChild(el('span', key.split('_').join(' ')));
      row.appendChild(el('span', data[key], 'side-num'));
      node.appendChild(row);
    });
  }
  function emptyState(node, text) {
    clear(node);
    node.appendChild(el('div', text, 'empty'));
  }
  function messageText(body) {
    if (!body) return '';
    return typeof body === 'string' ? body : (body.text || '');
  }
  function card(parent, idText, title, kind, status, desc, foot) {
    var box = el('article', null, 'run-card');
    var head = el('div', null, 'run-card-head');
    var titles = el('div', null, 'run-card-title');
    titles.appendChild(el('span', idText, 'run-id'));
    titles.appendChild(el('span', title, 'run-path'));
    head.appendChild(titles);
    head.appendChild(badge(status, kind));
    box.appendChild(head);
    if (desc) {
      var details = el('details', null, 'run-desc');
      details.appendChild(el('summary', desc.length > 140 ? desc.slice(0, 140) + '...' : desc));
      if (desc.length > 140) details.appendChild(el('div', desc));
      box.appendChild(details);
    }
    if (foot) box.appendChild(el('div', foot, 'run-foot'));
    parent.appendChild(box);
  }
  function applyFilter() {
    $('received').hidden = filter !== 'received';
    $('waiting').hidden = filter !== 'waiting';
    $('logpanel').hidden = filter !== 'log';
    document.querySelectorAll('[data-filter]').forEach(function (tab) {
      tab.classList.toggle('is-active', tab.getAttribute('data-filter') === filter);
    });
  }
  function kindFor(status) {
    if (status === 'needs_attention' || status === 'rejected' || status === 'dead' || status === 'failed') return 'danger';
    if (status === 'new' || status === 'queued' || status === 'pending') return 'running';
    if (status === 'acked' || status === 'acknowledged' || status === 'delivered' || status === 'done') return 'success';
    return 'muted';
  }

  function render(d) {
    statusRow($('who'), d.agent.id, 'ok');
    if (d.mailbox.fatal) statusRow($('conn'), 'stopped', 'bad');
    else if (d.mailbox.connected) statusRow($('conn'), 'mailbox connected', 'ok');
    else statusRow($('conn'), 'mailbox unreachable', 'warn');
    statusRow($('wake'), 'wake ' + d.wake.mode + (d.wake.mode === 'off' ? '' : ' (' + d.wake.client + ')'), d.wake.mode === 'off' ? '' : 'warn');
    var others = (d.mailbox.candidates || []).length - 1;
    $('route').textContent = 'via ' + d.mailbox.url + (others > 0 ? ' (+' + others + ' fallback)' : '');
    $('stamp').textContent = 'Updated ' + new Date(d.generated_at).toLocaleTimeString();
    var receivedN = (d.recent || []).length;
    $('headline').textContent = d.agent.id + (receivedN ? ' · ' + receivedN + ' received' : '') + (d.outbox && d.outbox.length ? ' · ' + d.outbox.length + ' waiting' : '');
    syncLive(false);

    var err = $('err');
    var problems = [d.mailbox.fatal, d.remote_error, d.agents_error].filter(Boolean);
    err.hidden = problems.length === 0;
    clear(err);
    problems.forEach(function (p) { err.appendChild(el('div', p)); });

    counts($('inbox'), d.remote && d.remote.inbox, ['dead', 'expired']);
    counts($('tasks'), d.remote && d.remote.tasks, ['failed']);
    counts($('local'), d.local, ['rejected', 'needs_attention']);

    var agents = $('agents'); clear(agents);
    var list = (d.agents && d.agents.agents) || [];
    if (!list.length) agents.appendChild(el('div', 'No agents', 'side-link'));
    list.forEach(function (a) {
      var row = el('div', null, 'side-link' + (a.id === d.agent.id ? ' is-self' : ''));
      row.appendChild(el('span', null, 'side-dot'));
      row.appendChild(el('span', a.id + (a.id === d.agent.id ? ' · this PC' : '')));
      agents.appendChild(row);
    });

    $('count-received').textContent = String(receivedN);
    $('count-waiting').textContent = String((d.outbox || []).length);
    var recent = $('received');
    if (!d.recent.length) emptyState(recent, 'No messages received on this PC yet.');
    else {
      clear(recent);
      d.recent.forEach(function (r) {
        var m = r.message;
        var text = messageText(m.body);
        card(recent, new Date(m.created_at).toLocaleTimeString(), m.sender, kindFor(r.status), r.status, text, m.type + (m.task_id ? ' · task' : '') + ' · ' + m.conversation_id);
      });
    }

    var outbox = $('waiting');
    if (!d.outbox.length) emptyState(outbox, 'Nothing waiting to send.');
    else {
      clear(outbox);
      d.outbox.forEach(function (o) {
        card(outbox, new Date(o.created_at).toLocaleTimeString(), o.recipient, kindFor(o.status), o.status, o.last_error || '', o.type + ' · ' + o.attempts + ' tries');
      });
    }

    $('log').textContent = d.log || '(empty)';
    applyFilter();
  }

  function load() {
    fetch('/api/dashboard', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render)
      .catch(function (e) {
        var err = $('err'); err.hidden = false; clear(err); err.appendChild(el('div', 'Dashboard could not reach the adapter: ' + e.message));
        statusRow($('conn'), 'adapter unreachable', 'bad');
        syncLive(true);
      });
  }
  function schedule() { clearInterval(timer); if (!paused) timer = setInterval(load, 5000); }
  $('toggle').addEventListener('click', function () {
    paused = !paused; $('toggle').textContent = paused ? 'Resume' : 'Pause'; syncLive(false); schedule(); if (!paused) load();
  });
  document.querySelector('.tabs').addEventListener('click', function (event) {
    var button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.getAttribute('data-filter');
    applyFilter();
  });
  load(); schedule();
})();
</script>
</body>
</html>
`;
