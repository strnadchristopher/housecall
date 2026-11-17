/** Pure parsing only. Never fetch/probe the destination. */
export function serverAddress(input) {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(input)) throw new Error('Enter a complete HTTPS server address without spaces.');
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a complete HTTPS server address.'); }
  const authority = input.split('://')[1]?.split('/')[0];
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(authority || '');
  // Reject even empty ?/# and empty credentials; URL normalizes some away.
  if (/[?#]/u.test(input) || url.username || url.password || input.split('://')[1]?.split('/')[0].includes('@') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Use HTTPS, with no username, password, query or fragment. HTTP is allowed only for explicit loopback fixtures.');
  }
  if (!url.hostname || url.origin === 'null') throw new Error('Invalid server address.');
  return url.href;
}

export function serverList(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'format,servers' || value.format !== 1 || !Array.isArray(value.servers) || value.servers.length > 100) throw new Error('Invalid encrypted server list.');
  const servers = value.servers.map(serverAddress);
  if (new Set(servers).size !== servers.length) throw new Error('Duplicate server address.');
  return { format: 1, servers };
}
