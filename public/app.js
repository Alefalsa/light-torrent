const $ = selector => document.querySelector(selector);
let token;
let refreshing = false;
let messageKind = 'action';
let idleShutdownAt = null;
let refreshTimer = null;
const rows = new Map();

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function message(text, kind = 'action') {
  messageKind = kind;
  $('#message').textContent = text;
  $('#message').hidden = !text;
  $('#message').classList.toggle('info', kind === 'idle');
}

async function receiveMagnet() {
  const parameters = new URLSearchParams(location.hash.slice(1));
  if (!parameters.has('magnet')) return;
  const magnet = parameters.get('magnet').trim().replace(/^magnet:/i, 'magnet:');
  // Consume the handoff before awaiting requests so hash events cannot submit it twice.
  history.replaceState(null, '', location.pathname + location.search);
  if (!magnet.startsWith('magnet:?') || magnet.length > 16384) {
    message('The received magnet link is invalid or too long. Approve a valid link in the extension to continue.');
    return;
  }
  try {
    // A new tab may receive its magnet before the initial stats refresh finishes.
    if (!token) token = (await request('/api/torrents')).token;
    await request('/api/torrents', { kind: 'magnet', value: magnet });
    message('');
    await refresh();
  } catch (error) {
    message(`Could not add the magnet link: ${error.message}. Approve the link in the extension again to retry.`);
  }
}

function warningDetails(warning) {
  if (/tracker/i.test(warning)) {
    return {
      label: 'Tracker warning',
      explanation: /timed out|timeout|ETIMEDOUT/i.test(warning) ?
        'A tracker recently did not respond in time. Trackers help find peers; downloading can continue through other trackers or peer discovery.' :
        'A tracker recently could not be contacted or reported a problem. This does not necessarily stop the download; peers can be found in other ways.'
    };
  }
  return {
    label: 'Torrent warning',
    explanation: 'The torrent engine reported a non-fatal issue. It may affect connectivity or progress. This is the most recent warning, not necessarily a current failure.'
  };
}

async function request(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Client-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function render(data) {
  idleShutdownAt = data.idleShutdownAt ?? null;
  $('#idle-note').hidden = !idleShutdownAt;
  $('#idle-note').textContent = idleShutdownAt ?
    `No active torrents. Client stops in ${Math.max(0, Math.ceil((idleShutdownAt - Date.now()) / 1000))}s. Approve a magnet link to start it again.` : '';
  $('#download-dir').textContent = data.completedDir ?
    `${data.downloadDir} (unfinished) → ${data.completedDir} (completed)` : data.downloadDir;
  $('#engine-error').textContent = data.error || '';
  $('#engine-error').hidden = !data.error;
  $('#download-speed').textContent = `${bytes(data.torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0))}/s`;
  $('#upload-speed').textContent = `${bytes(data.torrents.reduce((sum, torrent) => sum + torrent.uploadSpeed, 0))}/s`;
  $('#active-count').textContent = data.torrents.filter(torrent => !torrent.paused || torrent.moving).length;
  $('#total-count').textContent = data.torrents.length;
  $('#empty').hidden = data.torrents.length > 0;
  const ids = new Set(data.torrents.map(torrent => torrent.id));
  for (const [id, row] of rows) {
    if (!ids.has(id)) { row.remove(); rows.delete(id); }
  }
  for (const torrent of data.torrents) {
    let row = rows.get(torrent.id);
    if (!row) {
      row = $('#torrent-template').content.firstElementChild.cloneNode(true);
      row.dataset.id = torrent.id;
      rows.set(torrent.id, row);
      $('#torrents').append(row);
      const warning = row.querySelector('.torrent-warning');
      const trigger = row.querySelector('.warning-trigger');
      const tooltip = row.querySelector('.warning-tooltip');
      tooltip.id = `warning-${torrent.id}`;
      trigger.setAttribute('aria-describedby', tooltip.id);
      trigger.addEventListener('keydown', event => {
        if (event.key === 'Escape') warning.dataset.dismissed = 'true';
      });
      trigger.addEventListener('click', () => {
        delete warning.dataset.dismissed;
        trigger.focus();
      });
      trigger.addEventListener('blur', () => { delete warning.dataset.dismissed; });
      warning.addEventListener('mouseleave', () => { delete warning.dataset.dismissed; });
    }
    row.querySelector('h3').textContent = torrent.name;
    row.querySelector('.status').textContent = torrent.status;
    row.querySelector('progress').value = torrent.progress;
    row.querySelector('progress').setAttribute('aria-label', `Download progress for ${torrent.name}`);
    row.querySelector('.size').textContent = torrent.length || torrent.completed ?
      `${Math.floor(torrent.progress * 100)}% · ${bytes(torrent.downloaded)} of ${bytes(torrent.length)}` :
      'Waiting for peers to share file information';
    row.querySelector('.speed').textContent = `${bytes(torrent.downloadSpeed)}/s down · ${bytes(torrent.uploadSpeed)}/s up`;
    row.querySelector('.peers').textContent = `${torrent.peers} peer${torrent.peers === 1 ? '' : 's'}`;
    row.querySelector('.toggle').textContent = torrent.pendingMove ? 'Retry move' : torrent.paused ? 'Resume' : 'Pause';
    row.querySelector('.toggle').hidden = !!torrent.completed;
    row.querySelector('.toggle').disabled = !!torrent.moving;
    row.querySelector('.remove').disabled = !!torrent.pendingMove;
    row.querySelector('.toggle').dataset.action = torrent.paused ? 'resume' : 'pause';
    row.querySelector('.file-path').textContent = torrent.path;
    row.querySelector('.torrent-error').textContent = torrent.error || '';
    row.querySelector('.torrent-error').hidden = !torrent.error;
    row.querySelector('.torrent-warning').hidden = !torrent.warning || !!torrent.error;
    if (torrent.warning) {
      const details = warningDetails(torrent.warning);
      row.querySelector('.warning-label').textContent = details.label;
      row.querySelector('.warning-trigger').setAttribute('aria-label', `${details.label}: show explanation`);
      row.querySelector('.warning-explanation').textContent = details.explanation;
      row.querySelector('.warning-details').textContent = `Details: ${torrent.warning}`;
    }
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await request('/api/torrents');
    token = data.token;
    render(data);
    $('#connection').textContent = 'Local & connected';
    $('#connection').classList.remove('offline');
    $('#connection').classList.remove('sleeping');
    if (messageKind === 'connection' || messageKind === 'idle') message('');
    if (refreshTimer === null) refreshTimer = setInterval(refresh, 2000);
  } catch (error) {
    const idle = idleShutdownAt && Date.now() >= idleShutdownAt &&
      (error instanceof TypeError || error.name === 'TimeoutError');
    if (idle) {
      $('#connection').textContent = 'Sleeping';
      $('#connection').classList.remove('offline');
      $('#connection').classList.add('sleeping');
      $('#idle-note').textContent = 'The idle window has ended. The client is offline.';
      $('#idle-note').title = error.message;
      message('Approve a magnet link in the extension to start the client, or start it manually and reload.', 'idle');
      clearInterval(refreshTimer);
      refreshTimer = null;
    } else {
      $('#connection').textContent = 'Disconnected';
      $('#connection').classList.add('offline');
      message(`Cannot connect to the local client: ${error.message}`, 'connection');
    }
  } finally {
    refreshing = false;
  }
}

$('#torrents').addEventListener('click', async event => {
  const button = event.target.closest('.actions button');
  if (!button || button.disabled) return;
  const row = button.closest('.torrent');
  const action = button.classList.contains('remove') ? 'remove' : button.dataset.action;
  if (action === 'remove' && !confirm('Remove this torrent from the queue? Downloaded files will be kept.')) return;
  row.querySelectorAll('button').forEach(control => { control.disabled = true; });
  try {
    await request(`/api/torrents/${row.dataset.id}/${action}`, {});
    message('');
    await refresh();
  } catch (error) {
    message(error.message);
  } finally {
    row.querySelectorAll('button').forEach(control => { control.disabled = false; });
  }
});

window.addEventListener('hashchange', receiveMagnet);
receiveMagnet();
refresh();
refreshTimer = setInterval(refresh, 2000);
