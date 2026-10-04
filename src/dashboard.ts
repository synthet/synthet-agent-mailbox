/** Browser UI: credentials stay in memory and private data requires a bearer token. */
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent mailbox dashboard</title>
  <style>
    body { font: 16px system-ui, sans-serif; background: #f4f6fa; color: #182438; margin: 0; }
    main { max-width: 960px; margin: 40px auto; padding: 0 24px; }
    section { background: white; border: 1px solid #dbe1ea; border-radius: 12px; padding: 24px; margin: 20px 0; }
    h1 { margin-bottom: 8px; } h2 { margin-top: 0; font-size: 20px; }
    p { line-height: 1.5; } label { display: block; margin-bottom: 8px; }
    input, button { font: inherit; padding: 10px; border: 1px solid #aab7c8; border-radius: 6px; }
    input { width: min(100%, 420px); box-sizing: border-box; } button { background: #183f80; color: white; cursor: pointer; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f4f6fa; padding: 16px; max-height: 480px; overflow: auto; }
    #notice { color: #93401c; } dt { font-weight: 600; } dd { margin: 4px 0 16px; }
  </style>
</head>
<body><main>
  <h1>Agent mailbox</h1>
  <p>Local adapter dashboard. Status refreshes every five seconds.</p>
  <section><h2>Connection</h2><p id="health" role="status">Loading adapter status…</p></section>
  <section>
    <h2>Queue and conversation log</h2>
    <form id="login"><label for="token">This PC's agent token</label>
      <input id="token" type="password" autocomplete="off" required>
      <button type="submit">Connect</button>
      <button type="button" id="lock" hidden>Lock</button>
    </form>
    <p>The token is kept in this page's memory until you lock or close it.</p>
    <p id="notice" role="status">Enter the token to view private data.</p>
    <div id="private" hidden><h2>Local queue</h2><dl id="queue"></dl><h2>Conversation log</h2><pre id="log"></pre></div>
  </section>
</main>
<script>
  let token = '';
  let refreshing = false;
  const byId = id => document.getElementById(id);
  const labels = { outbox: 'Waiting to send', rejected: 'Rejected sends', spool_new: 'New inbox messages', spool_handed: 'Handed to agent', needs_attention: 'Needs attention' };
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const currentToken = token;
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (!response.ok) throw new Error('Adapter status unavailable.');
      const health = await response.json();
      byId('health').textContent = 'Agent: ' + health.agent_id + ' · Mailbox: ' + health.mailbox;
      if (!currentToken) return;
      const result = await fetch('/dashboard/data', { headers: { Authorization: 'Bearer ' + currentToken }, cache: 'no-store' });
      if (!result.ok) throw new Error(result.status === 401 ? 'Invalid agent token.' : 'Dashboard data unavailable.');
      const data = await result.json();
      if (token !== currentToken) return;
      byId('queue').replaceChildren();
      for (const [key, label] of Object.entries(labels)) {
        const title = document.createElement('dt'); title.textContent = label;
        const count = document.createElement('dd'); count.textContent = data.local[key];
        byId('queue').append(title, count);
      }
      byId('log').textContent = data.log || 'No conversation messages yet.';
      byId('private').hidden = false;
      byId('notice').textContent = data.error || 'Updated ' + new Date().toLocaleTimeString();
    } catch (error) {
      if (token === currentToken) {
        byId('notice').textContent = error.message;
        byId('private').hidden = true;
        byId('queue').replaceChildren();
        byId('log').textContent = '';
      }
    } finally { refreshing = false; }
  }
  byId('login').addEventListener('submit', event => {
    event.preventDefault(); token = byId('token').value; byId('token').value = '';
    byId('lock').hidden = false; void refresh();
  });
  byId('lock').addEventListener('click', () => {
    token = ''; byId('private').hidden = true; byId('lock').hidden = true;
    byId('queue').replaceChildren(); byId('log').textContent = '';
    byId('notice').textContent = 'Enter the token to view private data.';
  });
  void refresh(); setInterval(refresh, 5000);
</script>
</body></html>`;
