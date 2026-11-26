// The address of a project's remote as it may leave the host for a machine: the rule the
// ledger applies when it stores a repository source (docs/design/code-sources.md §1, A holds
// it), and what a round's source may name. The machine clones it with its own git login.
// Nothing outside the host applies it again: the address is already the form that leaves.
//
// What passes is something a machine reaches over the network, with no secret in it: an https,
// http or git:// address loses its whole user part (a token is often put there), and every
// address any query or fragment; an ssh one keeps its login name, which is who the machine's
// key is registered as, and loses any password. A local path, file:// or any other transport means nothing on another machine, and
// an address git or ssh would read as an option, or as a transport helper, never passes.

// Git's own transport names: written with a single colon they are a URL to git, not an
// scp-like host:path.
const TRANSPORTS = new Set(['file', 'git', 'ssh', 'http', 'https', 'ftp', 'ftps', 'ext', 'fd', 'git+ssh', 'ssh+git']);
const NETWORK = new Set(['https', 'http', 'ssh', 'git']);

// The address as a machine may be handed it, or null when it may not be handed one at all.
export function machineRemote(url: string): string | null {
  if (url === '' || url.startsWith('-') || /[\s\p{Cc}]/u.test(url)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    const scheme = parsed.protocol.slice(0, -1).toLowerCase();
    if (!NETWORK.has(scheme) || parsed.hostname === '') return null;
    if (parsed.hostname.startsWith('-') || parsed.username.startsWith('-')) return null;
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    if (scheme !== 'ssh') parsed.username = '';
    return parsed.href;
  }
  // scp-like: [user@]host:path. A one-letter host is a Windows drive, a transport name is a URL
  // written with one colon, and a path that starts with a colon is a transport helper (ext::).
  const scp = /^(?:([^@/\\:]+)@)?([^@/\\:]+):([^:].*)$/.exec(url);
  if (!scp) return null;
  const [, user, host] = scp;
  if (host!.length < 2 || TRANSPORTS.has(host!.toLowerCase()) || host!.startsWith('-') || user?.startsWith('-')) return null;
  return url;
}

// Whether an address the owner typed carries something a machine must not be handed and that
// must not be quietly dropped either: a login or password in it, or a query string, which is
// where a token is often put. `machineRemote` takes exactly those parts out, so an entry that
// takes an address from the owner (shared/sources.ts parseSources) refuses it here and says so
// instead of storing what is left. This is not a second normalization: machineRemote still says
// what a machine may be given.
export function remoteHasSecret(url: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // An ssh address's login name is who the machine's key is registered as, not a secret.
  const user = parsed.protocol.slice(0, -1).toLowerCase() === 'ssh' ? '' : parsed.username;
  return user !== '' || parsed.password !== '' || parsed.search !== '';
}
