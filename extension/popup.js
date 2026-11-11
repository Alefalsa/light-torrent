const openButton = document.querySelector('#open-downloads');
const folderButton = document.querySelector('#change-folder');
const status = document.querySelector('#status');
let busy = false;

async function control(action) {
  if (busy) return;
  busy = true;
  openButton.disabled = folderButton.disabled = true;
  status.classList.remove('error');
  status.setAttribute('role', 'status');
  status.textContent = action === 'change-folder' ?
    'Choose a folder in the native dialog. Cancel keeps your current folder.' :
    'Opening downloads. On first use, choose a final folder in the native dialog.';
  try {
    const result = await LightTorrentBridge.api.runtime.sendMessage({ type: 'client-control', action });
    if (!result?.ok) throw new Error(result?.error || 'The extension did not respond.');
    status.textContent = action === 'change-folder' ?
      'Folder updated. New downloads use it; existing downloads stay where they are.' :
      'Downloads opened.';
  } catch (error) {
    console.error('Light Torrent toolbar action failed:', error);
    status.textContent = error.message;
    status.classList.add('error');
    status.setAttribute('role', 'alert');
  } finally {
    busy = false;
    openButton.disabled = folderButton.disabled = false;
  }
}

openButton.addEventListener('click', () => control('open'));
folderButton.addEventListener('click', () => control('change-folder'));
