export function transition(state, event) {
  if (event.type === 'connect' && state !== 'connecting') return 'connecting';
  if (event.type === 'ready' && state === 'connecting') return 'connected';
  if (event.type === 'failed' && state === 'connecting') return 'failed';
  if (event.type === 'settings') return 'settings';
  return state;
}
