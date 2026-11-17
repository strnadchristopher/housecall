import { parseServerInput } from '../data/serverInput';
/** Browser-only capability. Never infer hosted permission from a supplied URL. */
export function hostedTarget(input: string): { origin: string; token: string } {
  const parsed = parseServerInput(input);
  const url = new URL(parsed.origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('This web app needs an https:// address.');
  if (parsed.origin === location.origin) throw new Error('Enter your community server address.');
  if (!input.trim().startsWith('hc1.')) {
    const original = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : 'https://' + input.trim());
    if (original.username || original.password || original.search || (original.hash && !parsed.token)) throw new Error('Enter a server address or invite without account credentials.');
  }
  return parsed;
}
