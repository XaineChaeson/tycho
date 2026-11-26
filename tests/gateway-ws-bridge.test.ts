import './guard.ts';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { proxyCommandOf, sshArgs } from '../service/gateway.ts';
import { connectWssBridge, resolveHttpProxy, startLoopbackWsToTcpServer } from '../service/gateway-ws-bridge.ts';

test('sshArgs omits ProxyCommand by default and injects gateway-ws-bridge ProxyCommand when gateway.wss is set', () => {
  const base = { ssh: 'tycho-gw@gw.example.com', keyFile: '/keys/gw', remotePort: 18787, localPort: 8788 };
  const plain = sshArgs(base, 'TYCHO_GW_MARK')!;
  assert.ok(plain.every((arg) => !arg.startsWith('ProxyCommand=')));

  const withWss = sshArgs({ ...base, wss: 'wss://gw.example.com/_gateway' }, 'TYCHO_GW_MARK')!;
  const proxyOpt = withWss.find((arg) => arg.startsWith('ProxyCommand='));
  assert.ok(proxyOpt);
  assert.match(proxyOpt, /gateway-ws-bridge\.ts" --connect "wss:\/\/gw\.example\.com\/_gateway" --marker "TYCHO_GW_MARK"/);

  // Rejects unsafe characters or non-ws schemes.
  assert.equal(proxyCommandOf('https://gw.example.com/_gateway', 'M'), undefined);
  assert.equal(proxyCommandOf('wss://gw.example.com/"bad', 'M'), undefined);
});

test('proxyCommandOf blocks shell/OpenSSH command injection vectors and escapes % in paths', () => {
  const base = { ssh: 'tycho-gw@gw.example.com', keyFile: '/keys/gw', remotePort: 18787, localPort: 8788 };
  const maliciousUrls = [
    'wss://gw.example.com/$(id)',
    'wss://gw.example.com/`id`',
    'wss://gw.example.com/$HOME',
    'wss://gw.example.com/${IFS}id',
    'wss://gw.example.com/%h',
    'wss://gw.example.com/%p',
    'wss://gw.example.com/\\";id',
    'wss://gw.example.com/a;id',
    'wss://gw.example.com/a|id',
    'wss://gw.example.com/a&id',
    'wss://gw.example.com/a(b)',
    'wss://gw.example.com/a<b',
    'wss://gw.example.com/a>b',
    'wss://gw.example.com/a*',
    'wss://gw.example.com/a?b=1',
    'wss://gw.example.com/a[0]',
    'wss://gw.example.com/{a,b}',
    'wss://gw.example.com/!foo',
    'wss://gw.example.com/~root',
    "wss://gw.example.com/'bad'",
    'wss://gw.example.com/bad space',
    'wss://user:pass@gw.example.com/_gateway',
  ];
  for (const url of maliciousUrls) {
    assert.equal(proxyCommandOf(url, 'TYCHO_GW_MARK'), undefined, `should reject ${url}`);
    assert.equal(sshArgs({ ...base, wss: url }, 'TYCHO_GW_MARK'), undefined, `sshArgs should refuse ${url}`);
  }
  // Rejects unsafe marker or nodePath with shell quote/substitution characters.
  assert.equal(proxyCommandOf('wss://gw.example.com/_gateway', 'M$(id)'), undefined);
  assert.equal(proxyCommandOf('wss://gw.example.com/_gateway', 'M%h'), undefined);
  assert.equal(proxyCommandOf('wss://gw.example.com/_gateway', 'TYCHO_GW_MARK', '/tmp/$(id)/node'), undefined);
  assert.equal(proxyCommandOf('wss://gw.example.com/_gateway', 'TYCHO_GW_MARK', '/tmp/`id`/node'), undefined);
  assert.equal(proxyCommandOf('wss://gw.example.com/_gateway', 'TYCHO_GW_MARK', '/tmp/"bad"/node'), undefined);

  // Escapes % in executable path as %% for OpenSSH ProxyCommand token expansion.
  const withPercent = proxyCommandOf('wss://gw.example.com:8443/_gateway/v1', 'TYCHO_GW_MARK', '/opt/100%/node');
  assert.ok(withPercent);
  assert.match(withPercent, /^"\/opt\/100%%\/node" /);

  // Supports IPv6 host literals and percent-encoded paths while escaping % for OpenSSH.
  const withIpv6 = proxyCommandOf('wss://[2001:db8::1]:8443/_gateway%20v1', 'TYCHO_GW_MARK', '/usr/bin/node');
  assert.ok(withIpv6);
  assert.match(withIpv6, /--connect "wss:\/\/\[2001:db8::1\]:8443\/_gateway%%20v1"/);
});

test('resolveHttpProxy respects HTTPS_PROXY and NO_PROXY domain rules', () => {
  const target = new URL('wss://gw.example.com/_gateway');
  assert.equal(
    resolveHttpProxy(target, { HTTPS_PROXY: 'http://127.0.0.1:7897' })?.href,
    'http://127.0.0.1:7897/',
  );
  assert.equal(
    resolveHttpProxy(target, { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,.example.com' }),
    undefined,
  );
});

test('WS <-> TCP bridge tunnels bidirectional SSH stream directly and via HTTP CONNECT proxy, surfacing 403/404 diagnostics', async (t) => {
  // 1. Raw TCP server standing in for sshd (sends banner and echoes client payload).
  const tcpServer = createNetServer((sock) => {
    sock.write('SSH-2.0-OpenSSH_Test\r\n');
    sock.on('data', (chunk: Buffer) => sock.write(Buffer.concat([Buffer.from('ECHO:'), chunk])));
  });
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => tcpServer.close());
  const tcpPort = (tcpServer.address() as { port: number }).port;

  // 2. Gateway loopback WS -> TCP unframing bridge.
  const wsBridge = await startLoopbackWsToTcpServer({
    listenHost: '127.0.0.1',
    listenPort: 0,
    targetHost: '127.0.0.1',
    targetPort: tcpPort,
    path: '/_gateway',
  });
  t.after(() => wsBridge.close());

  // Wrong path surfaces HTTP 404 cleanly.
  await assert.rejects(
    connectWssBridge({
      url: `ws://127.0.0.1:${wsBridge.port}/wrong`,
      input: new PassThrough(),
      output: new PassThrough(),
      env: {},
    }),
    /HTTP 404/,
  );

  // 3. HTTP CONNECT proxy server (rejects port 22 with 403, allows wsBridge.port with 200).
  const proxyServer = createNetServer((clientSock) => {
    clientSock.once('data', (head) => {
      const line = head.toString('latin1').split('\r\n')[0] ?? '';
      const match = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(line);
      if (!match) {
        clientSock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const [, host, portStr] = match;
      const port = Number(portStr);
      if (port === 22) {
        clientSock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = createNetServer().listen;
      void upstream;
      import('node:net').then(({ connect }) => {
        const remote = connect({ host: host!, port }, () => {
          clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          remote.pipe(clientSock);
          clientSock.pipe(remote);
        });
        remote.on('error', () => clientSock.destroy());
        clientSock.on('error', () => remote.destroy());
      });
    });
  });
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => proxyServer.close());
  const proxyPort = (proxyServer.address() as { port: number }).port;

  // Proxy blocking port 22 surfaces clear HTTP 403 diagnostic.
  await assert.rejects(
    connectWssBridge({
      url: 'ws://127.0.0.1:22/_gateway',
      input: new PassThrough(),
      output: new PassThrough(),
      env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
    }),
    /代理拒绝 CONNECT 127\.0\.0\.1:22（HTTP 403）/,
  );

  // Full end-to-end stream via HTTP CONNECT proxy -> WS bridge -> raw TCP server!
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const received: Buffer[] = [];
  clientOut.on('data', (chunk: Buffer) => received.push(chunk));

  const sessionPromise = connectWssBridge({
    url: `ws://127.0.0.1:${wsBridge.port}/_gateway`,
    input: clientIn,
    output: clientOut,
    env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
  });

  // Wait for SSH banner + send binary payload.
  const payload = Buffer.from('SSH-2.0-Client_Hello_Payload_0123456789');
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('timeout waiting for echo')), 5000);
    let sent = false;
    clientOut.on('data', () => {
      const combined = Buffer.concat(received).toString('utf8');
      if (!sent && combined.includes('SSH-2.0-OpenSSH_Test')) {
        sent = true;
        clientIn.write(payload);
      }
      if (combined.includes(`ECHO:${payload.toString('utf8')}`)) {
        clearTimeout(deadline);
        clientIn.end();
        resolve();
      }
    });
  });

  await sessionPromise;
});
