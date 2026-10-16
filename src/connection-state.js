export function transition(state, event) {
  if (event.type === 'retry' && (state === 'idle' || state === 'unavailable')) return 'checking';
  if (event.type === 'available' && state === 'checking') return 'opening';
  if (event.type === 'unavailable' && state === 'checking') return 'unavailable';
  return state;
}
