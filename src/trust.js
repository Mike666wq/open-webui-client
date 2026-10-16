export function validateServiceUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new TypeError('Enter a valid HTTP or HTTPS address.');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.hostname === 'tauri.localhost' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Use an HTTP or HTTPS address without a path, query, credentials, or fragment.');
  }

  return new URL(url.origin);
}

export function classifyNavigation(value, serviceUrl, localOrigins, devOrigin = null) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return 'deny';
  }

  if (target.origin === serviceUrl.origin || [...localOrigins].some((value) => sameAuthority(target, new URL(value)))) {
    return 'allow-app';
  }
  if (devOrigin && sameAuthority(target, new URL(devOrigin))) {
    return 'allow-app';
  }
  if ((target.protocol === 'http:' || target.protocol === 'https:') && !target.username && !target.password) {
    return 'open-external';
  }
  return 'deny';
}

function sameAuthority(left, right) {
  return left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.port === right.port &&
    !left.username &&
    !left.password;
}
