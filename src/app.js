import { invoke } from '@tauri-apps/api/core';
import clientConfig from './client-config.generated.js';
import { transition } from './connection-state.js';
import { validateServiceUrl } from './trust.js';
import { androidStrings } from './android-strings.js';
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
const isAndroid = /Android/i.test(navigator.userAgent);
const strings = androidStrings(isAndroid, navigator.language);
if (isAndroid) document.body.classList.add('android-client');
if (strings) {
  document.documentElement.lang = 'zh-CN';
  document.querySelector('label[for="service-address"]').textContent = strings.label;
  exportDiagnosticsButton.textContent = strings.diagnostics;
}

exportDiagnosticsButton.hidden = !isAndroid;
render('settings');

function render(nextState, message = '') {
  state = transition(state, { type: nextState });
  const connecting = state === 'connecting';
  heading.textContent = connecting ? (strings?.connectingHeading ?? 'Connecting to your server') : (strings?.heading ?? 'Connect to your server');
  detail.textContent = connecting
    ? (strings?.connectingDetail ?? 'Opening the server and checking that Open WebUI is ready…')
    : (strings?.detail ?? 'Enter the address of your Open WebUI server.');
  connectButton.disabled = connecting;
  connectButton.textContent = connecting ? (strings?.connecting ?? 'Connecting…') : (strings?.connect ?? 'Connect');
  error.hidden = !message;
  error.textContent = message;
}

async function connect(event) {
  event?.preventDefault();
  let service;
  try {
    service = validateServiceUrl(address.value);
  } catch (cause) {
    render('failed', strings?.invalidAddress ?? cause.message);
    return;
  }
  address.value = service.origin;
  render('connect');
  try {
    await invoke('connect-service', { address: service.origin });
  } catch (cause) {
    render('failed', strings?.failure ?? String(cause));
  }
}

form.addEventListener('submit', connect);

exportDiagnosticsButton.addEventListener('click', async () => {
  exportDiagnosticsButton.disabled = true;
  diagnosticsStatus.hidden = false;
  diagnosticsStatus.textContent = strings?.choose ?? 'Choose a location to save the local diagnostic report. It will not be sent automatically.';
  try {
    const result = await invoke('export-android-diagnostics');
    diagnosticsStatus.textContent = result.status === 'exported'
      ? (strings?.exported ?? 'Diagnostic report saved locally. It was not sent.')
      : (strings?.cancelled ?? 'Export cancelled. No report was sent.');
  } catch {
    diagnosticsStatus.textContent = strings?.exportFailure ?? 'Could not export Android diagnostics. No report was sent.';
  } finally {
    exportDiagnosticsButton.disabled = false;
  }
});

async function initialize() {
  address.value = clientConfig.defaultServiceUrl;
  try {
    const state = await invoke('get-connection-state');
    address.value = state.candidateUrl || state.lastSuccessUrl || clientConfig.defaultServiceUrl;
    if (state.error) render('failed', strings?.failure ?? state.error);
    if (state.startupUrl) {
      address.value = state.startupUrl;
      await invoke('connect-service', { address: state.startupUrl });
      render('connect');
    }
  } catch (cause) {
    render('failed', strings?.settingsFailure ?? `Could not load connection settings: ${String(cause)}`);
  }
}

initialize();
