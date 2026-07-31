import { createServer } from 'node:http';

const port = Number.parseInt(process.argv[2] ?? '', 10);
const upstreamValue = process.argv[3] ?? '';
const upstream = new URL(upstreamValue);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Supply one valid local proxy port.');
}
if (
  upstream.origin !== upstreamValue ||
  upstream.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(upstream.hostname)
) {
  throw new Error('Supply one canonical loopback HTTP PostgREST origin.');
}

const MAX_REQUEST_BYTES = 1_048_576;

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function proxyRequest(request, response) {
  if (request.url === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end('{"status":"ok"}');
    return;
  }
  if (!request.url?.startsWith('/rest/v1/')) {
    response.statusCode = 404;
    response.end();
    return;
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Unexpected request body chunk.');
    const bytes = Buffer.from(chunk);
    byteCount += bytes.length;
    if (byteCount > MAX_REQUEST_BYTES) {
      response.statusCode = 413;
      response.end();
      return;
    }
    chunks.push(bytes);
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['connection', 'content-length', 'host'].includes(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(',') : value);
  }
  const method = request.method ?? 'GET';
  const body = ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks);
  const target = new URL(request.url.slice('/rest/v1'.length), upstream);
  if (target.origin !== upstream.origin) {
    response.statusCode = 400;
    response.end();
    return;
  }
  const upstreamResponse = await fetch(target, { method, headers, body });

  response.statusCode = upstreamResponse.status;
  for (const [name, value] of upstreamResponse.headers) {
    if (!['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name)) {
      response.setHeader(name, value);
    }
  }
  response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
}

const server = createServer((request, response) => {
  proxyRequest(request, response).catch(() => {
    response.statusCode = 502;
    response.end();
  });
});

server.listen(port, '127.0.0.1');
