import { invoke } from '@tauri-apps/api/core';
import clientConfig from './client-config.generated.js';
import { transition } from './connection-state.js';
import './styles.css';

const heading = document.querySelector('#heading');
const detail = document.querySelector('#detail');
const address = document.querySelector('#service-address');
const retry = document.querySelector('#retry');
const error = document.querySelector('#error');
let state = 'idle';

address.textContent = clientConfig.serviceUrl;

function render(nextState, message = '') {
  state = nextState;
  const checking = state === 'checking';
  heading.textContent = checking
    ? 'Connecting to your server'
    : state === 'opening'
      ? 'Opening Open WebUI'
      : 'Server is unavailable';
  detail.textContent = checking
    ? 'Checking the configured service address…'
    : state === 'opening'
      ? 'The service responded. Loading it in this window…'
      : 'Check that the server is running and reachable, then try again.';
  retry.hidden = checking || state === 'opening';
  retry.disabled = checking;
  error.hidden = !message;
  error.textContent = message;
}

async function connect() {
  state = transition(state, { type: 'retry' });
  render(state);
  try {
    await invoke('check_service');
    render(transition(state, { type: 'available' }));
  } catch (cause) {
    render(transition(state, { type: 'unavailable' }), String(cause));
  }
}

retry.addEventListener('click', connect);
connect();
