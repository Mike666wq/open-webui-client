export function validateServiceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('serviceUrl must be an absolute URL');
  }

  if (
    url.protocol !== 'http:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('serviceUrl must be a plain HTTP origin without credentials or path');
  }

  return url;
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
