import { invoke } from '@tauri-apps/api/core';
import clientConfig from './client-config.generated.js';
import { transition } from './connection-state.js';
import { validateServiceUrl } from './trust.js';
import './styles.css';

const heading = document.querySelector('#heading');
const detail = document.querySelector('#detail');
const address = document.querySelector('#service-address');
const form = document.querySelector('#connect-form');
const connectButton = document.querySelector('#connect');
const error = document.querySelector('#error');
const exportDiagnosticsButton = document.querySelector('#export-diagnostics');
const diagnosticsStatus = document.querySelector('#diagnostics-status');
let state = 'settings';

exportDiagnosticsButton.hidden = !/Android/i.test(navigator.userAgent);

function render(nextState, message = '') {
  state = transition(state, { type: nextState });
  const connecting = state === 'connecting';
  heading.textContent = connecting ? 'Connecting to your server' : 'Connect to your server';
  detail.textContent = connecting
    ? 'Opening the server and checking that Open WebUI is ready…'
    : 'Enter the address of your Open WebUI server.';
  connectButton.disabled = connecting;
  connectButton.textContent = connecting ? 'Connecting…' : 'Connect';
  error.hidden = !message;
  error.textContent = message;
}

async function connect(event) {
  event?.preventDefault();
  let service;
  try {
    service = validateServiceUrl(address.value);
  } catch (cause) {
    render('failed', cause.message);
    return;
  }
  address.value = service.origin;
  render('connect');
  try {
    await invoke('connect-service', { address: service.origin });
  } catch (cause) {
    render('failed', String(cause));
  }
}

form.addEventListener('submit', connect);

exportDiagnosticsButton.addEventListener('click', async () => {
  exportDiagnosticsButton.disabled = true;
  diagnosticsStatus.hidden = false;
  diagnosticsStatus.textContent = 'Choose a location to save the local diagnostic report. It will not be sent automatically.';
  try {
    const result = await invoke('export-android-diagnostics');
    diagnosticsStatus.textContent = result.status === 'exported'
      ? 'Diagnostic report saved locally. It was not sent.'
      : 'Export cancelled. No report was sent.';
  } catch {
    diagnosticsStatus.textContent = 'Could not export Android diagnostics. No report was sent.';
  } finally {
    exportDiagnosticsButton.disabled = false;
  }
});

async function initialize() {
  address.value = clientConfig.defaultServiceUrl;
  try {
    const state = await invoke('get-connection-state');
    address.value = state.candidateUrl || state.lastSuccessUrl || clientConfig.defaultServiceUrl;
    if (state.error) render('failed', state.error);
    if (state.startupUrl) {
      address.value = state.startupUrl;
      await invoke('connect-service', { address: state.startupUrl });
      render('connect');
    }
  } catch (cause) {
    render('failed', `Could not load connection settings: ${String(cause)}`);
  }
}

initialize();
