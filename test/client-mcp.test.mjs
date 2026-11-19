import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, negotiateProtocolVersion, LATEST_PROTOCOL_VERSION, RPC_ERRORS } from '../lib/mcp.mjs';
import { ValidationError } from '../lib/contracts.mjs';

function makeServer() {
  return createServer({
    name: 'test',
    version: '1.2.3',
    instructions: 'hello',
    tools: [
      {
        definition: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
        handler: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
      },
      {
        definition: { name: 'boom', description: 'fails', inputSchema: { type: 'object' } },
        handler: async () => {
          throw new ValidationError('bad input');
        },
      },
      {
        definition: { name: 'slow', description: 'waits for cancel', inputSchema: { type: 'object' } },
        handler: (_args, { signal }) =>
          new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'aborted' }] }))),
      },
    ],
  });
}

test('protocol version negotiation', () => {
  assert.equal(negotiateProtocolVersion('2025-03-26'), '2025-03-26');
  assert.equal(negotiateProtocolVersion('1999-01-01'), LATEST_PROTOCOL_VERSION);
});

test('initialize, tools/list, ping', async () => {
  const s = makeServer();
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.version, '1.2.3');
  assert.equal(init.result.instructions, 'hello');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  const list = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'boom', 'slow']);
  assert.deepEqual((await s.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
});

test('tools/call success, in-band tool errors, unknown tool and method', async () => {
  const s = makeServer();
  const ok = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.equal(ok.result.content[0].text, '{"a":1}');
  const bad = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /^invalid_params: bad input/);
  const unknownTool = await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknownTool.error.code, RPC_ERRORS.INVALID_PARAMS);
  const unknownMethod = await s.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(unknownMethod.error.code, RPC_ERRORS.METHOD_NOT_FOUND);
});

test('notifications get no response; cancellation aborts the in-flight call', async () => {
  const s = makeServer();
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const pending = s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slow', arguments: {} } });
  await new Promise((r) => setImmediate(r));
  await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
  assert.equal((await pending).result.content[0].text, 'aborted');
});

test('serveStdio frames: parse errors, batches, split chunks, CRLF', async () => {
  const s = makeServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c) => (out += c));
  const closed = new Promise((resolve) => s.serveStdio({ stdin, stdout, onClose: resolve }));

  stdin.write('{"jsonrpc":"2.0","id":1,"method":"pi');
  stdin.write('ng"}\r\n');
  stdin.write('not json\n');
  stdin.write('[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]\n');
  // A multi-byte character split across two chunks must survive decoding.
  const msg = Buffer.from('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"s":"✓é"}}}\n');
  stdin.write(msg.subarray(0, 80));
  stdin.write(msg.subarray(80));
  stdin.end();
  await closed;

  const frames = out.trim().split('\n').map((l) => JSON.parse(l));
  const byId = (id) => frames.find((f) => !Array.isArray(f) && f.id === id);
  assert.deepEqual(byId(1).result, {});
  assert.ok(frames.some((f) => f.error?.code === RPC_ERRORS.PARSE));
  const batch = frames.find(Array.isArray);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].id, 2);
  assert.equal(byId(3).result.content[0].text, '{"s":"✓é"}');
});
