const $ = selector => document.querySelector(selector);
let token;
let refreshPromise = null;
let connected = false;
let lastState;
let failedMagnet;
let addingMagnet = false;
let magnetSubmission = Promise.resolve();
let idleShutdownAt = null;
let refreshTimer = null;
const rows = new Map();
const pendingActions = new Set();

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function message(text, kind = 'error') {
  $('#message').textContent = text;
  $('#message').hidden = !text;
  $('#message').classList.toggle('info', kind === 'info');
  $('#message').setAttribute('role', kind === 'info' ? 'status' : 'alert');
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
  magnetSubmission = magnetSubmission.then(() => addMagnet(magnet));
  return magnetSubmission;
}

async function addMagnet(magnet) {
  addingMagnet = true;
  failedMagnet = undefined;
  $('#retry-magnet').hidden = true;
  $('#retry-magnet').disabled = true;
  message('Adding your download...', 'info');
  try {
    // Refresh the session token even when an idle client has restarted.
    if (!await refresh()) throw new Error('The local client is not connected.');
    await request('/api/torrents', { kind: 'magnet', value: magnet });
    message('Download added.', 'info');
    await refreshAfterMutation();
  } catch (error) {
    if (error.status === 409) {
      message(error.message, 'info');
      await refreshAfterMutation();
    } else {
      failedMagnet = magnet;
      message(`Could not add the magnet link: ${error.message}. Use Retry magnet when the client is ready.`);
      $('#retry-magnet').hidden = false;
    }
  } finally {
    addingMagnet = false;
    $('#retry-magnet').disabled = false;
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
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function render(data) {
  lastState = data;
  idleShutdownAt = data.idleShutdownAt ?? null;
  $('#idle-note').hidden = !idleShutdownAt;
  $('#idle-note').textContent = idleShutdownAt ?
    `No active torrents. Client stops in ${Math.max(0, Math.ceil((idleShutdownAt - Date.now()) / 1000))}s. Approve a magnet link to start it again.` : '';
  $('#download-dir').textContent = data.completedDir ?
    `${data.completedDir} (new downloads)` : data.downloadDir;
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
    renderActions(row, torrent);
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

function renderActions(row, torrent) {
  const pending = pendingActions.has(torrent.id);
  row.setAttribute('aria-busy', String(pending));
  const toggle = row.querySelector('.toggle');
  const remove = row.querySelector('.remove');
  toggle.textContent = torrent.pendingMove ? 'Retry move' : torrent.pendingCompletion ? 'Retry completion' : torrent.paused ? 'Resume' : 'Pause';
  toggle.hidden = !!torrent.completed;
  toggle.disabled = !connected || pending || !!torrent.moving;
  remove.disabled = !connected || pending || !!torrent.pendingMove || !!torrent.pendingCompletion;
  toggle.dataset.action = torrent.paused ? 'resume' : 'pause';
  toggle.setAttribute('aria-label', `${toggle.textContent} ${torrent.name}`);
  remove.setAttribute('aria-label', `Remove ${torrent.name} from the queue`);
}

function refresh() {
  if (refreshPromise) return refreshPromise;
  $('#reconnect').disabled = true;
  refreshPromise = (async () => {
    try {
      const data = await request('/api/torrents');
      token = data.token;
      connected = true;
      render(data);
      $('#connection').textContent = 'Local & connected';
      $('#connection').classList.remove('offline');
      $('#connection').classList.remove('sleeping');
      $('#connection-notice').hidden = true;
      if (refreshTimer === null) refreshTimer = setInterval(refresh, 2000);
      return true;
    } catch (error) {
      connected = false;
      const idle = idleShutdownAt && Date.now() >= idleShutdownAt &&
        (error instanceof TypeError || error.name === 'TimeoutError');
      $('#connection').textContent = idle ? 'Sleeping' : 'Disconnected';
      $('#connection').classList.toggle('offline', !idle);
      $('#connection').classList.toggle('sleeping', !!idle);
      $('#connection-notice').hidden = false;
      $('#connection-notice').classList.toggle('info', !!idle);
      $('#connection-message').textContent = idle ?
        'The client is sleeping. Use Open downloads in the extension toolbar to start it, then reconnect here.' :
        `Cannot connect to the local client: ${error.message}. Use the extension toolbar to start it, then reconnect.`;
      if (idle) {
        $('#idle-note').textContent = 'The idle window has ended. The client is offline.';
        $('#idle-note').title = error.message;
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      for (const torrent of lastState?.torrents || []) renderActions(rows.get(torrent.id), torrent);
      return false;
    } finally {
      refreshPromise = null;
      $('#reconnect').disabled = false;
    }
  })();
  return refreshPromise;
}

async function refreshAfterMutation() {
  // An existing poll may contain state captured before the mutation finished.
  if (refreshPromise) await refreshPromise;
  return refresh();
}

$('#torrents').addEventListener('click', async event => {
  const button = event.target.closest('.actions button');
  if (!button || button.disabled || !connected) return;
  const row = button.closest('.torrent');
  const id = row.dataset.id;
  if (pendingActions.has(id)) return;
  const action = button.classList.contains('remove') ? 'remove' : button.dataset.action;
  if (action === 'remove' && !confirm('Remove this torrent from the queue? Downloaded files will be kept.')) return;
  pendingActions.add(id);
  renderActions(row, lastState.torrents.find(torrent => torrent.id === id));
  try {
    await request(`/api/torrents/${id}/${action}`, {});
    message(action === 'remove' ? 'Removed from the queue. Downloaded files were kept.' : 'Download updated.', 'info');
    await refreshAfterMutation();
  } catch (error) {
    message(error.message);
  } finally {
    pendingActions.delete(id);
    const torrent = lastState.torrents.find(torrent => torrent.id === id);
    if (torrent && rows.has(id)) renderActions(row, torrent);
  }
});

window.addEventListener('hashchange', receiveMagnet);
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
$('#reconnect').addEventListener('click', refresh);
$('#retry-magnet').addEventListener('click', () => {
  if (failedMagnet && !addingMagnet) {
    const magnet = failedMagnet;
    magnetSubmission = magnetSubmission.then(() => addMagnet(magnet));
    return magnetSubmission;
  }
});
receiveMagnet();
refresh();
refreshTimer = setInterval(refresh, 2000);
