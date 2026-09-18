import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { outputDir, readJson, rootDir, writeJson } from '../scripts/lib.mjs';
import { ensureSingBox } from '../scripts/sing-box.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// Each local HTTP proxy returns its outbound tag, without contacting the destination.
async function markerProxy(t, tag) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let connected = false;
    let buffered = '';
    socket.on('data', (data) => {
      buffered += data.toString();
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!connected) {
        connected = true;
        buffered = buffered.slice(end + 4);
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      }
      if (buffered.includes('\r\n\r\n')) {
        socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(tag)}\r\n\r\n${tag}`);
      }
    });
  });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  });
  return { type: 'http', tag, server: '127.0.0.1', server_port: port };
}

function throughProxy(port, host) {
  return new Promise((done, fail) => {
    const req = request({
      host: '127.0.0.1', port, path: `http://${host}/`,
      headers: { Host: host }, agent: false
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (data) => { body += data; });
      res.on('end', () => done({ status: res.statusCode, body }));
      res.on('error', fail);
    });
    req.setTimeout(3000, () => req.destroy(new Error('local routing probe timed out')));
    req.on('error', (error) => {
      if (error.code === 'ECONNRESET') done({ status: 502, body: '' });
      else fail(error);
    });
    req.end();
  });
}

async function start(t, binary, configPath) {
  const child = spawn(binary, ['run', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  });
  await new Promise((done, fail) => {
    let logs = '';
    const timer = setTimeout(() => fail(new Error(`sing-box startup timed out: ${logs}`)), 5000);
    const onError = (error) => { clearTimeout(timer); fail(error); };
    child.once('error', onError);
    child.once('exit', (code) => onError(new Error(`sing-box exited (${code}): ${logs}`)));
    const onData = (data) => {
      logs += data.toString();
      if (logs.includes('sing-box started')) { clearTimeout(timer); done(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

test('native sing-box distinguishes safe defaults from optional DNS resolution', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'network-rules-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = await ensureSingBox();
  const { sing_box: targets } = await readJson(resolve(rootDir, 'src/targets.json'));
  const direct = targets.direct_outbound;
  const proxy = targets.proxy_outbound;
  const outbounds = [await markerProxy(t, direct), await markerProxy(t, proxy)];

  for (const resolveIp of [false, true]) {
    await t.test(resolveIp ? 'optional resolve' : 'default', async (mode) => {
      const file = resolveIp ? 'route.resolve.local.fragment.json' : 'route.local.fragment.json';
      const { route } = await readJson(resolve(outputDir, 'sing-box', file));
      for (const ruleSet of route.rule_set) ruleSet.path = resolve(outputDir, 'sing-box', ruleSet.path);
      route.final = proxy;
      const reservation = createServer();
      const port = await listen(reservation);
      await new Promise((done) => reservation.close(done));
      const configPath = join(directory, file);
      await writeJson(configPath, {
        log: { level: 'info' },
        dns: {
          servers: [{ type: 'hosts', tag: targets.direct_dns_server, predefined: {
            'unlisted-route-audit.invalid': '110.43.121.3',
            'ipv6-route-audit.invalid': '240e:978:a05:5::47',
            'foreign-route-audit.invalid': '1.1.1.1'
          } }],
          final: targets.direct_dns_server
        },
        inbounds: [{ type: 'http', listen: '127.0.0.1', listen_port: port }],
        outbounds, route
      });
      await start(mode, binary, configPath);
      for (const [host, expected] of [
        ['unlisted-route-audit.invalid', resolveIp ? direct : proxy],
        ['ipv6-route-audit.invalid', resolveIp ? direct : proxy],
        ['foreign-route-audit.invalid', proxy],
        ['www.baidu.com', direct],
        ['110.43.121.3', direct],
        ['[240e:978:a05:5::47]', direct],
        ['dns-miss-route-audit.invalid', resolveIp ? null : proxy],
        ['p3-ad-sign.byteimg.com', null]
      ]) {
        await mode.test(host, async () => {
          const response = await throughProxy(port, host);
          if (expected === null) assert.ok(response.status >= 400, JSON.stringify(response));
          else assert.deepEqual(response, { status: 200, body: expected });
        });
      }
    });
  }
});
