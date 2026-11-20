// The HTTP surface: one server that routes to the four protocols this contest scores — REST v3,
// GraphQL v4, MCP over streamable HTTP, and git smart HTTP — and answers a JSON 404 for everything
// else. The routing lives here so main.ts stays the pure entry<->env lifecycle the kit ships.
//
// Every reply carries a non-empty X-GitHub-Request-Id (the protocol group checks that on every
// surface), REST and MCP replies are JSON, and a malformed JSON body is a 400 rather than a crash.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bearerOf, handleRest, requestId, segmentsOf } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { seedFromEnvironment, store } from './store.ts';

// The trial's scenario (the viewer's token, login and 30 repositories) is fixed, so seed it at
// import time: every handler below reads a store that already holds what the suite expects.
seedFromEnvironment();

/** The largest request body the server accepts; a push of 100 files stays far under this. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request's body into a Buffer, refusing anything over the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Send a JSON reply with the shared headers every API reply needs. */
function sendJson(res: ServerResponse, status: number, body: unknown, id: string, extra: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': id,
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(text);
}

/** Send a raw byte reply (git's own content types). */
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, id: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': id,
  });
  res.end(body);
}

/** Build the server. It binds nothing until main.ts listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      const id = requestId(`${Date.now()}-${Math.random()}`);
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${message}` }, id);
      else res.end();
    });
  });
}

/** Route one request. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = requestId(`${req.method ?? 'GET'} ${req.url ?? '/'} ${Date.now()} ${Math.random()}`);
  const rawUrl = req.url ?? '/';
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const parsed = new URL(rawUrl, 'http://entry');
    pathname = parsed.pathname;
    query = parsed.searchParams;
  } catch {
    pathname = '/';
  }
  const method = (req.method ?? 'GET').toUpperCase();

  // GET /healthz: the env's boot probe; no token, no JSON envelope beyond {"ok":true}.
  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, id);
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const viewer = store.userForToken(bearerOf(req.headers));

  // /api/v3/...: the REST surface. Its own handler answers 401 for a missing token.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    let parsedBody: unknown = undefined;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, id);
        return;
      }
    }
    const segments = segmentsOf(pathname);
    const host = req.headers.host ?? 'entry';
    const reply = await handleRest(
      { method, segments, query, headers: req.headers, raw: body, origin: `http://${host}` },
      parsedBody,
    );
    if (reply === null) {
      sendJson(res, 404, { message: 'Not Found' }, id);
      return;
    }
    // 204 has no body at all.
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': id });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, id, reply.headers ?? {});
    return;
  }

  // POST /api/graphql: the v4 surface.
  if (pathname === '/api/graphql' && method === 'POST') {
    let parsedBody: unknown = undefined;
    try {
      parsedBody = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, id);
      return;
    }
    const reply = handleGraphQL(parsedBody, viewer);
    sendJson(res, reply.status, reply.body, id);
    return;
  }

  // POST /mcp: Model Context Protocol over streamable HTTP.
  if (pathname === '/mcp') {
    if (method !== 'POST') {
      // The streamable transport's GET opens an event stream; a plain 405 keeps it honest.
      res.writeHead(405, { 'content-type': 'application/json', 'x-github-request-id': id });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    const reply = handleMcp(req.headers, body);
    if (reply === null) {
      sendJson(res, 404, { message: 'Not Found' }, id);
      return;
    }
    sendJson(res, reply.status, reply.body, id, reply.headers ?? {});
    return;
  }

  // /<owner>/<repo>.git/...: git smart HTTP.
  const gitSegments = pathname.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const gitReply = handleGit(method, gitSegments, query, req.headers as Record<string, string | string[] | undefined>, body, viewer);
  if (gitReply !== null) {
    sendRaw(res, gitReply.status, gitReply.contentType, gitReply.body, id);
    return;
  }

  // Anything else: a JSON 404 with the message the suite expects.
  sendJson(res, 404, { message: 'Not Found' }, id);
}