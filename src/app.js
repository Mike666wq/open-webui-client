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
let state = 'settings';

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
