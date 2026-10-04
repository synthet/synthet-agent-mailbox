// Read-only dashboard page served by the adapter at /dashboard. All data comes from /api/dashboard.
// Message text is untrusted peer input, so the script only ever writes it with textContent.
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mailbox Dashboard</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #ffffff; --edge: #d7dce4; --ink: #18202c; --mute: #5d6878;
    --ok: #0f766e; --ok-bg: #dff3ef; --warn: #b45309; --warn-bg: #fdefd8; --bad: #b91c1c; --bad-bg: #fde4e4;
    --accent: #1d4ed8; --accent-bg: #e3ebfd;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #10141a; --card: #171d26; --edge: #2a3445; --ink: #e5eaf1; --mute: #92a0b3;
      --ok: #5eead4; --ok-bg: #123631; --warn: #fbbf5a; --warn-bg: #3a2b12; --bad: #f87171; --bad-bg: #402020;
      --accent: #93b4ff; --accent-bg: #1b2a4d;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--mute); }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--accent-bg); color: var(--accent); }
  .pill.ok { background: var(--ok-bg); color: var(--ok); }
  .pill.warn { background: var(--warn-bg); color: var(--warn); }
  .pill.bad { background: var(--bad-bg); color: var(--bad); }
  .spacer { flex: 1; }
  .meta { color: var(--mute); font-size: 12px; }
  button { font: inherit; padding: 4px 12px; border-radius: 8px; border: 1px solid var(--edge); background: var(--card); color: var(--ink); cursor: pointer; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-bottom: 12px; }
  .card { background: var(--card); border: 1px solid var(--edge); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
  .grid .card { margin-bottom: 0; }
  .counts { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 8px; }
  .count { text-align: center; padding: 6px 4px; border-radius: 8px; background: var(--bg); }
  .count b { display: block; font-size: 20px; }
  .count span { font-size: 11px; color: var(--mute); }
  .count.hot b { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--edge); vertical-align: top; }
  th { font-size: 12px; color: var(--mute); font-weight: 600; }
  td.text { max-width: 420px; overflow-wrap: anywhere; }
  td.text details summary { cursor: pointer; }
  .wrap { overflow-x: auto; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, Consolas, monospace; max-height: 260px; overflow: auto; }
  .empty { color: var(--mute); }
  ul.agents { margin: 0; padding: 0; list-style: none; }
  ul.agents li { padding: 6px 0; border-bottom: 1px solid var(--edge); }
  ul.agents li:last-child { border-bottom: 0; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Mailbox dashboard</h1>
    <span id="who" class="pill">loading</span>
    <span id="conn" class="pill">...</span>
    <span id="wake" class="pill">wake ...</span>
    <span class="spacer"></span>
    <span id="route" class="meta"></span>
    <span id="stamp" class="meta"></span>
    <button id="toggle" type="button">Pause</button>
  </header>
  <div id="err" class="card" hidden></div>

  <div class="grid">
    <section class="card"><h2>Mailbox inbox (shared)</h2><div id="inbox" class="counts"></div></section>
    <section class="card"><h2>Tasks (shared)</h2><div id="tasks" class="counts"></div></section>
    <section class="card"><h2>This PC (local)</h2><div id="local" class="counts"></div></section>
  </div>

  <section class="card"><h2>Agents</h2><ul id="agents" class="agents"></ul></section>

  <section class="card"><h2>Received on this PC</h2>
    <div class="wrap"><table><thead><tr><th>Time</th><th>From</th><th>Type</th><th>Local status</th><th>Message</th></tr></thead><tbody id="recent"></tbody></table></div>
  </section>

  <section class="card"><h2>Waiting to send</h2>
    <div class="wrap"><table><thead><tr><th>Time</th><th>To</th><th>Type</th><th>Status</th><th>Tries</th><th>Last error</th></tr></thead><tbody id="outbox"></tbody></table></div>
  </section>

  <section class="card"><h2>Conversation log (tail)</h2><pre id="log"></pre></section>
</main>
<script>
(function () {
  var paused = false;
  var timer = null;
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function pill(node, text, kind) { node.textContent = text; node.className = 'pill' + (kind ? ' ' + kind : ''); }

  function counts(node, data, hot) {
    clear(node);
    if (!data) { node.appendChild(el('span', 'unavailable', 'empty')); return; }
    Object.keys(data).forEach(function (key) {
      var box = el('div', null, 'count' + (hot.indexOf(key) >= 0 && data[key] > 0 ? ' hot' : ''));
      box.appendChild(el('b', data[key]));
      box.appendChild(el('span', key.split('_').join(' ')));
      node.appendChild(box);
    });
  }

  function emptyRow(body, cols, text) {
    var tr = el('tr'); var td = el('td', text, 'empty'); td.colSpan = cols; tr.appendChild(td); body.appendChild(tr);
  }

  function messageText(body) {
    if (!body) return '';
    return typeof body === 'string' ? body : (body.text || '');
  }

  function render(d) {
    var err = $('err');
    pill($('who'), d.agent.id, '');
    if (d.mailbox.fatal) { pill($('conn'), 'stopped', 'bad'); }
    else if (d.mailbox.connected) { pill($('conn'), 'mailbox connected', 'ok'); }
    else { pill($('conn'), 'mailbox unreachable', 'warn'); }
    pill($('wake'), 'wake ' + d.wake.mode + (d.wake.mode === 'off' ? '' : ' (' + d.wake.client + ')'), d.wake.mode === 'off' ? '' : 'warn');
    var others = (d.mailbox.candidates || []).length - 1;
    $('route').textContent = 'via ' + d.mailbox.url + (others > 0 ? ' (+' + others + ' fallback)' : '');
    $('stamp').textContent = 'updated ' + new Date(d.generated_at).toLocaleTimeString();

    var problems = [d.mailbox.fatal, d.remote_error, d.agents_error].filter(Boolean);
    err.hidden = problems.length === 0;
    clear(err);
    problems.forEach(function (p) { err.appendChild(el('div', p)); });

    counts($('inbox'), d.remote && d.remote.inbox, ['dead', 'expired']);
    counts($('tasks'), d.remote && d.remote.tasks, ['failed']);
    counts($('local'), d.local, ['rejected', 'needs_attention']);

    var agents = $('agents'); clear(agents);
    var list = (d.agents && d.agents.agents) || [];
    if (!list.length) agents.appendChild(el('li', 'No agent list available.', 'empty'));
    list.forEach(function (a) {
      var li = el('li');
      li.appendChild(el('b', a.id));
      if (a.id === d.agent.id) li.appendChild(el('span', ' this PC', 'pill'));
      li.appendChild(el('span', '  ' + (a.capabilities || []).join(', ') + '  |  projects: ' + (a.projects || []).join(', '), 'meta'));
      agents.appendChild(li);
    });

    var recent = $('recent'); clear(recent);
    if (!d.recent.length) emptyRow(recent, 5, 'No messages received on this PC yet.');
    d.recent.forEach(function (r) {
      var m = r.message; var tr = el('tr');
      tr.appendChild(el('td', new Date(m.created_at).toLocaleString()));
      tr.appendChild(el('td', m.sender));
      tr.appendChild(el('td', m.type + (m.task_id ? ' (task)' : '')));
      var st = el('td'); st.appendChild(el('span', r.status, 'pill' + (r.status === 'needs_attention' ? ' bad' : r.status === 'new' ? ' warn' : ' ok'))); tr.appendChild(st);
      var td = el('td', null, 'text'); var text = messageText(m.body);
      var details = el('details'); details.appendChild(el('summary', text.length > 90 ? text.slice(0, 90) + '...' : text));
      var full = el('div', text); full.style.marginTop = '6px';
      details.appendChild(full);
      var ids = el('div', 'conversation ' + m.conversation_id + (m.reply_to ? '  reply to ' + m.reply_to : ''), 'meta'); details.appendChild(ids);
      td.appendChild(details); tr.appendChild(td);
      recent.appendChild(tr);
    });

    var outbox = $('outbox'); clear(outbox);
    if (!d.outbox.length) emptyRow(outbox, 6, 'Nothing waiting.');
    d.outbox.forEach(function (o) {
      var tr = el('tr');
      tr.appendChild(el('td', new Date(o.created_at).toLocaleString()));
      tr.appendChild(el('td', o.recipient));
      tr.appendChild(el('td', o.type));
      var st = el('td'); st.appendChild(el('span', o.status, 'pill ' + (o.status === 'rejected' ? 'bad' : 'warn'))); tr.appendChild(st);
      tr.appendChild(el('td', o.attempts));
      tr.appendChild(el('td', o.last_error || ''));
      outbox.appendChild(tr);
    });

    $('log').textContent = d.log || '(empty)';
  }

  function load() {
    fetch('/api/dashboard', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render)
      .catch(function (e) {
        var err = $('err'); err.hidden = false; clear(err); err.appendChild(el('div', 'Dashboard could not reach the adapter: ' + e.message));
        pill($('conn'), 'adapter unreachable', 'bad');
      });
  }
  function schedule() { clearInterval(timer); if (!paused) timer = setInterval(load, 5000); }
  $('toggle').addEventListener('click', function () {
    paused = !paused; $('toggle').textContent = paused ? 'Resume' : 'Pause'; schedule(); if (!paused) load();
  });
  load(); schedule();
})();
</script>
</body>
</html>
`;
