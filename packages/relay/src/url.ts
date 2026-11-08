export type BaseUrlVerdict = { status: 'ok'; url: string } | { status: 'refused'; message: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The relay talks HTTPS only. Plain http is allowed to this machine alone (localhost,
 * 127.0.0.1, ::1), for development against a local platform.
 */
export function checkBaseUrl(raw: string): BaseUrlVerdict {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { status: 'refused', message: `platformUrl "${raw}" is not a URL` };
  }
  if (u.username || u.password) {
    return { status: 'refused', message: 'platformUrl must not contain a user name or password' };
  }
  if (u.search || u.hash) {
    return { status: 'refused', message: 'platformUrl must not contain a query or a fragment' };
  }
  if (u.protocol === 'http:') {
    if (!LOCAL_HOSTS.has(u.hostname)) {
      return {
        status: 'refused',
        message: `platformUrl must use https (plain http is allowed only for localhost); got ${u.protocol}//${u.host}`,
      };
    }
  } else if (u.protocol !== 'https:') {
    return { status: 'refused', message: `platformUrl must use https; got ${u.protocol}` };
  }
  const base = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  return { status: 'ok', url: base };
}
