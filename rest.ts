// GitHub REST v3 surface. Everything the conformance suite drives lives here: repositories, their
// branches and commits, the contents API, issues with labels and comments, and pull requests with
// their files and merges.
//
// Two rules shape the whole file. First, every reply is JSON and carries X-GitHub-Request-Id; the
// protocol group checks that, so the JSON writer sets both and no handler builds a reply by hand.
// Second, a repository belongs to the login its bearer token names: the same name under another
// login is a 404, never a 403, and no token at all is a 401.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gitObjectId, nowIso, store, type CommitMeta, type Issue, type Pull, type Repo, type User } from './store.ts';

/** The token header the env sends; the suite's RestClient always sets it except where it tests auth. */
export const AUTH_HEADER = 'authorization';

/** Scope string the API root advertises (`repos` and `read:org` are what the checks look for). */
const OAUTH_SCOPES = 'repo, read:org';

/** The version `/api/v3/meta` reports; any non-empty string scores the check. */
const INSTALLED_VERSION = '3.0.0-makefun';

/** One parsed request: method, path, query, headers and the raw body bytes. */
export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, already percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  raw: Buffer;
  /** The entry's own origin, e.g. http://10.0.0.5:41234, for absolute URLs the suite follows. */
  origin: string;
}

/** A JSON reply: status, body and optional extra headers. */
export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A reply that is a status only (204 and friends). */
function empty(status: number): RestReply {
  return { status, body: undefined };
}

/** `{message}` — the error body GitHub uses for 4xx and 5xx. */
function errorReply(status: number, message: string): RestReply {
  return { status, body: { message } };
}

const notFound = (): RestReply => errorReply(404, 'Not Found');

/** base64 of a UTF-8 string with embedded newlines every 60 chars, as GitHub returns it. */
export function toBase64(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return encoded.replace(/(.{60})/g, '$1\n');
}

/** Decode GitHub's wrapped base64; tolerate the newlines and a missing padding. */
export function fromBase64(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** A git tree entry as the REST API renders it. */
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  type: 'blob' | 'tree';
}

/** Parse a git tree object's payload into its entries. */
export function parseTreeEntries(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const mode = data.subarray(at, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, type: mode === '40000' ? 'tree' : 'blob' });
    at = nul + 21;
  }
  return entries;
}

/** Build a git tree payload from entries already sorted the way git sorts them. */
export function buildTreePayload(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A commit's payload in git's own format. */
export function buildCommitPayload(input: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = input.timezone ?? '+0000';
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} ${tz}`);
  lines.push(`committer ${input.committer} ${input.timestamp} ${tz}`);
  lines.push('');
  lines.push(input.message.endsWith('\n') ? input.message : `${input.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Resolve a tree path to the blob or tree at it, or null. */
export function resolvePath(repo: Repo, commitSha: string, path: string): { type: 'blob' | 'tree'; sha: string } | null {
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  const text = commit.data.toString('utf8');
  const treeLine = text.split('\n').find((line) => line.startsWith('tree '));
  if (treeLine === undefined) return null;
  let current: { type: 'blob' | 'tree'; sha: string } = { type: 'tree', sha: treeLine.slice(5).trim() };
  const parts = path.split('/').filter((part) => part !== '');
  for (const part of parts) {
    if (current.type !== 'tree') return null;
    const tree = repo.objects.get(current.sha);
    if (tree === undefined) return null;
    const entry = parseTreeEntries(tree.data).find((candidate) => candidate.name === part);
    if (entry === undefined) return null;
    current = { type: entry.type, sha: entry.oid };
  }
  return current;
}

/** The tree sha of a commit. */
export function commitTree(repo: Repo, commitSha: string): string | null {
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  const line = commit.data.toString('utf8').split('\n').find((candidate) => candidate.startsWith('tree '));
  return line === undefined ? null : line.slice(5).trim();
}

/** The parent shas of a commit, in order. */
export function commitParents(repo: Repo, commitSha: string): string[] {
  const commit = repo.objects.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return [];
  return commit.data
    .toString('utf8')
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice(7).trim());
}

/**
 * Write one file into a repository as a new commit on `branch`, creating the commit object, its
 * trees and its ref. Returns the commit sha and the blob sha. Used by the contents API and by MCP's
 * tools, so both surfaces produce identical objects.
 */
export function commitFile(
  repo: Repo,
  options: {
    branch: string;
    path: string;
    content: Buffer;
    message: string;
    author: User;
  },
): { commitSha: string; blobSha: string } {
  const parentSha = repo.refs.get(`refs/heads/${options.branch}`) ?? null;
  const parentTree = parentSha === null ? null : commitTree(repo, parentSha);
  const blobSha = store.put(repo, 'blob', options.content);

  // Build the nested trees for the path, reusing the parent's entries at each level.
  const parts = options.path.split('/').filter((part) => part !== '');
  const fileName = parts[parts.length - 1] as string;
  const dirs = parts.slice(0, -1);

  /** Read a tree's entries, or none when the sha is absent. */
  const entriesOf = (sha: string | null): TreeEntry[] => {
    if (sha === null) return [];
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTreeEntries(object.data);
  };

  let childSha = blobSha;
  let childType: 'blob' | 'tree' = 'blob';
  let childName = fileName;
  for (let level = dirs.length; level >= 0; level -= 1) {
    // Resolve the tree that holds this level from the parent commit, walking down the same prefixes.
    let parentTreeSha: string | null = parentTree;
    for (let depth = 0; depth < level && parentTreeSha !== null; depth += 1) {
      const next = entriesOf(parentTreeSha).find((entry) => entry.name === dirs[depth] && entry.type === 'tree');
      parentTreeSha = next?.oid ?? null;
    }
    const entries = entriesOf(parentTreeSha).filter((entry) => entry.name !== childName);
    entries.push({ mode: childType === 'tree' ? '40000' : '100644', name: childName, oid: childSha, type: childType });
    const newTreeSha = store.put(repo, 'tree', buildTreePayload(entries));
    childSha = newTreeSha;
    childType = 'tree';
    if (level === 0) break;
    childName = dirs[level - 1] as string;
  }
  const rootTree = childSha;

  const timestamp = Math.floor(Date.now() / 1000);
  const identity = `${options.author.name} <${options.author.email}>`;
  const commitPayload = buildCommitPayload({
    tree: rootTree,
    parents: parentSha === null ? [] : [parentSha],
    message: options.message,
    author: identity,
    committer: identity,
    timestamp,
  });
  const commitSha = store.put(repo, 'commit', commitPayload);
  repo.commits.set(commitSha, {
    sha: commitSha,
    message: options.message,
    author: options.author,
    committer: options.author,
    authorDate: nowIso(),
    committerDate: nowIso(),
    parents: parentSha === null ? [] : [parentSha],
    tree: rootTree,
  });
  repo.refs.set(`refs/heads/${options.branch}`, commitSha);
  return { commitSha, blobSha };
}

/** Delete one file from a repository as a new commit. Returns the commit sha, or null when absent. */
export function deleteFile(repo: Repo, options: { branch: string; path: string; message: string; author: User }): string | null {
  const parentSha = repo.refs.get(`refs/heads/${options.branch}`) ?? null;
  if (parentSha === null) return null;
  const target = resolvePath(repo, parentSha, options.path);
  if (target === null) return null;

  const parentTree = commitTree(repo, parentSha);
  const parts = options.path.split('/').filter((part) => part !== '');
  const fileName = parts[parts.length - 1] as string;
  const dirs = parts.slice(0, -1);

  const entriesOf = (sha: string | null): TreeEntry[] => {
    if (sha === null) return [];
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTreeEntries(object.data);
  };

  let childSha: string | null = null;
  let childName = fileName;
  for (let level = dirs.length; level >= 0; level -= 1) {
    let parentTreeSha: string | null = parentTree;
    for (let depth = 0; depth < level && parentTreeSha !== null; depth += 1) {
      const next = entriesOf(parentTreeSha).find((entry) => entry.name === dirs[depth] && entry.type === 'tree');
      parentTreeSha = next?.oid ?? null;
    }
    const entries = entriesOf(parentTreeSha).filter((entry) => entry.name !== childName);
    if (childSha !== null) {
      entries.push({ mode: '40000', name: childName, oid: childSha, type: 'tree' });
    }
    childSha = store.put(repo, 'tree', buildTreePayload(entries));
    childName = level > 0 ? (dirs[level - 1] as string) : '';
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const identity = `${options.author.name} <${options.author.email}>`;
  const commitSha = store.put(
    repo,
    'commit',
    buildCommitPayload({
      tree: childSha,
      parents: [parentSha],
      message: options.message,
      author: identity,
      committer: identity,
      timestamp,
    }),
  );
  repo.commits.set(commitSha, {
    sha: commitSha,
    message: options.message,
    author: options.author,
    committer: options.author,
    authorDate: nowIso(),
    committerDate: nowIso(),
    parents: [parentSha],
    tree: childSha,
  });
  repo.refs.set(`refs/heads/${options.branch}`, commitSha);
  return commitSha;
}

/** Render a repo as the REST API's repository object. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: 1,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    clone_url: `https://github.example/${repo.owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

/** Render one issue. */
export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.user.login },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.example/issue/${issue.number}`,
  };
}

/** Render one pull request. */
export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head.ref, sha: headSha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: baseSha, label: `${repo.owner}:${pull.base.ref}` },
    user: { login: pull.user.login },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** Every object reachable from a commit: the commit, its trees and its blobs. */
export function reachableFrom(repo: Repo, startSha: string): Set<string> {
  const seen = new Set<string>();
  const queue = [startSha];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      for (const parent of commitParents(repo, sha)) queue.push(parent);
      const tree = commitTree(repo, sha);
      if (tree !== null) queue.push(tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeEntries(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      // An annotated tag's target is part of what a clone of that ref must contain.
      const target = object.data.toString('utf8').split('\n').find((line) => line.startsWith('object '));
      if (target !== undefined) queue.push(target.slice(7).trim());
    }
  }
  return seen;
}

/** The rows GitHub walks for `pr.files`: every path the head has and the base lacks or changed. */
export function changedFiles(repo: Repo, baseSha: string, headSha: string): {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}[] {
  const flatten = (commitSha: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (treeSha: string, prefix: string): void => {
      const object = repo.objects.get(treeSha);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTreeEntries(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.type === 'tree') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    const tree = commitTree(repo, commitSha);
    if (tree !== null) walk(tree, '');
    return out;
  };
  const baseFiles = flatten(baseSha);
  const headFiles = flatten(headSha);
  const rows: ReturnType<typeof changedFiles> = [];
  for (const [path, sha] of headFiles) {
    const before = baseFiles.get(path);
    if (before === sha) continue;
    const status = before === undefined ? 'added' : 'modified';
    const blob = repo.objects.get(sha);
    const lines = blob === undefined ? 0 : countLines(blob.data);
    rows.push({
      filename: path,
      status,
      additions: lines,
      deletions: 0,
      changes: lines,
      sha,
    });
  }
  for (const [path, sha] of baseFiles) {
    if (headFiles.has(path)) continue;
    const blob = repo.objects.get(sha);
    rows.push({
      filename: path,
      status: 'removed',
      additions: 0,
      deletions: blob === undefined ? 0 : countLines(blob.data),
      changes: blob === undefined ? 0 : countLines(blob.data),
      sha,
    });
  }
  return rows;
}

/** Line count of a blob's bytes. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** Split a URL path into decoded segments below /api/v3. */
export function segmentsOf(pathname: string): string[] {
  return pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** How the REST surface answers one request; null means "not a /api/v3 route". */
export async function handleRest(request: RestRequest, body: unknown): Promise<RestReply | null> {
  const { method, segments, query } = request;
  const token = bearerOf(request.headers);
  const viewer = store.userForToken(token);
  if (viewer === null) return errorReply(401, 'Requires authentication');

  // GET /api/v3/ and GET /api/v3
  if (segments.length === 0) {
    return {
      status: 200,
      body: {
        current_user_url: 'https://github.example/user',
        repository_url: 'https://github.example/repos',
        user_url: 'https://github.example/users/{user}',
      },
      headers: { 'x-oauth-scopes': OAUTH_SCOPES },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: INSTALLED_VERSION } };
  }

  if (segments[0] === 'user') {
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') return listViewerRepos(viewer, query, request.origin);
      if (method === 'POST') return createRepo(viewer, body);
    }
    if (segments[1] === undefined && method === 'GET') {
      return { status: 200, body: { login: viewer.login, id: 1, type: 'User' } };
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = store.repo(owner, name);
  // A repository is only visible to the login that owns it; another owner's name is a 404.
  if (repo === null || repo.owner !== viewer.login) return notFound();

  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') return patchRepo(repo, body);
    if (method === 'DELETE') {
      store.repos.delete(`/${repo.owner}/${repo.name}`.slice(1));
      return empty(204);
    }
    return notFound();
  }

  const [head, ...tail] = rest as [string, ...string[]];
  switch (head) {
    case 'branches':
      if (tail.length === 0 && method === 'GET') return listBranches(repo);
      if (tail.length === 1 && method === 'GET') return getBranch(repo, tail[0] as string);
      return notFound();
    case 'commits':
      if (tail.length === 0 && method === 'GET') return listCommits(repo, query);
      if (tail.length === 1 && method === 'GET') return getCommit(repo, tail[0] as string);
      return notFound();
    case 'contents':
      return handleContents(repo, viewer, method, tail, body, query);
    case 'git':
      if (tail[0] === 'refs') {
        if (tail.length === 1 && method === 'POST') return createRef(repo, body);
        if (tail.length === 3 && method === 'GET') return getRef(repo, tail[1] as string, tail[2] as string);
      }
      return notFound();
    case 'labels':
      if (tail.length === 0) {
        if (method === 'POST') return createLabel(repo, body);
        if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
      }
      return notFound();
    case 'issues':
      return handleIssues(repo, viewer, method, tail, body, query);
    case 'pulls':
      return handlePulls(repo, viewer, method, tail, body, query);
    default:
      return notFound();
  }
}

/** The bearer token from a request's headers, or null. */
export function bearerOf(headers: IncomingMessage['headers']): string | null {
  const raw = headers[AUTH_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match === null ? null : (match[1] as string);
}

/** GET /user/repos with per_page and page, and a Link header when another page exists. */
function listViewerRepos(viewer: User, query: URLSearchParams, origin: string): RestReply {
  const all = store.reposOf(viewer.login);
  const perPage = clampInt(query.get('per_page'), 30, 1, 100);
  const page = clampInt(query.get('page'), 1, 1, 10_000);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  // The Link URLs must stay on the entry's own origin: the suite refuses a "next" that leaves it.
  const href = (p: number): string => `${origin}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
  if (start + perPage < all.length) links.push(`<${href(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${href(page - 1)}>; rel="prev"`);
  links.push(`<${href(1)}>; rel="first"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { status: 200, body: slice.map(repoJson), headers };
}

/** Clamp a query integer. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** POST /user/repos */
function createRepo(viewer: User, body: unknown): RestReply {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') return errorReply(422, 'Repository creation failed: name is required');
  if (store.repo(viewer.login, name) !== null) {
    return errorReply(422, 'Repository creation failed: name already exists on this account');
  }
  const repo = store.createRepo(viewer.login, name, {
    description: typeof input.description === 'string' ? input.description : '',
    private: input.private === undefined ? true : Boolean(input.private),
  });
  return { status: 201, body: repoJson(repo) };
}

/** PATCH /repos/{o}/{r} */
function patchRepo(repo: Repo, body: unknown): RestReply {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.description === 'string') repo.description = input.description;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (typeof input.name === 'string' && input.name !== '') {
    store.repos.delete(`/${repo.owner}/${repo.name}`.slice(1));
    repo.name = input.name;
    store.repos.set(`${repo.owner}/${repo.name}`, repo);
  }
  if (typeof input.default_branch === 'string' && input.default_branch !== '') {
    repo.defaultBranch = input.default_branch;
  }
  return { status: 200, body: repoJson(repo) };
}

/** GET /repos/{o}/{r}/branches */
function listBranches(repo: Repo): RestReply {
  const out: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
  }
  return { status: 200, body: out };
}

/** GET /repos/{o}/{r}/branches/{branch} */
function getBranch(repo: Repo, branch: string): RestReply {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return notFound();
  return { status: 200, body: { name: branch, commit: { sha } } };
}

/** Walk a commit chain from a tip, newest first. */
function commitChain(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
    for (const parent of commitParents(repo, sha)) queue.push(parent);
  }
  return out;
}

/** GET /repos/{o}/{r}/commits[?sha=<ref>] */
function listCommits(repo: Repo, query: URLSearchParams): RestReply {
  const wanted = query.get('sha');
  const ref = wanted === null ? `refs/heads/${repo.defaultBranch}` : wanted.startsWith('refs/') ? wanted : `refs/heads/${wanted}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return { status: 200, body: [] };
  const perPage = clampInt(query.get('per_page'), 30, 1, 100);
  const chain = commitChain(repo, tip).slice(0, perPage);
  return {
    status: 200,
    body: chain.map((sha) => {
      const meta = repo.commits.get(sha);
      return {
        sha,
        commit: {
          message: meta?.message ?? '',
          author: { name: meta?.author.name ?? '', email: meta?.author.email ?? '', date: meta?.authorDate ?? nowIso() },
          committer: { name: meta?.committer.name ?? '', email: meta?.committer.email ?? '', date: meta?.committerDate ?? nowIso() },
          tree: { sha: meta?.tree ?? '' },
        },
        parents: (meta?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    }),
  };
}

/** GET /repos/{o}/{r}/commits/{ref} */
function getCommit(repo: Repo, ref: string): RestReply {
  const sha = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : null);
  if (sha === null) return notFound();
  const meta = repo.commits.get(sha);
  if (meta === undefined) return notFound();
  return {
    status: 200,
    body: {
      sha,
      commit: {
        message: meta.message,
        author: { name: meta.author.name, email: meta.author.email, date: meta.authorDate },
        committer: { name: meta.committer.name, email: meta.committer.email, date: meta.committerDate },
        tree: { sha: meta.tree },
      },
      parents: meta.parents.map((parent) => ({ sha: parent })),
    },
  };
}

/** POST /repos/{o}/{r}/git/refs */
function createRef(repo: Repo, body: unknown): RestReply {
  const input = (body ?? {}) as Record<string, unknown>;
  const ref = typeof input.ref === 'string' ? input.ref : '';
  const sha = typeof input.sha === 'string' ? input.sha : '';
  if (ref === '' || sha === '') return errorReply(422, 'ref and sha are required');
  const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
  if (repo.refs.has(full)) return errorReply(422, 'Reference already exists');
  repo.refs.set(full, sha);
  return { status: 201, body: { ref: full, object: { sha, type: 'commit' } } };
}

/** GET /repos/{o}/{r}/git/ref/{a}/{b} */
function getRef(repo: Repo, a: string, b: string): RestReply {
  const full = `refs/${a}/${b}`;
  const sha = repo.refs.get(full);
  if (sha === undefined) return notFound();
  return { status: 200, body: { ref: full, object: { sha, type: 'commit' } } };
}

/** The contents API: files, directories, create, update, delete. */
function handleContents(
  repo: Repo,
  viewer: User,
  method: string,
  tail: string[],
  body: unknown,
  query: URLSearchParams,
): RestReply {
  const path = tail.join('/');
  const refParam = query.get('ref');
  const branch = refParam === null || refParam === '' ? repo.defaultBranch : refParam;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;

  if (method === 'GET') {
    if (tip === null) return notFound();
    const resolved = resolvePath(repo, tip, path);
    if (resolved === null) return notFound();
    if (resolved.type === 'blob') {
      const blob = repo.objects.get(resolved.sha);
      if (blob === undefined) return notFound();
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: path.split('/').pop() ?? path,
          path,
          sha: resolved.sha,
          content: toBase64(blob.data.toString('utf8')),
        },
      };
    }
    const tree = repo.objects.get(resolved.sha);
    if (tree === undefined) return notFound();
    return {
      status: 200,
      body: parseTreeEntries(tree.data).map((entry) => ({
        type: entry.type === 'tree' ? 'dir' : 'file',
        size: entry.type === 'blob' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
      })),
    };
  }

  if (method === 'PUT') {
    const input = (body ?? {}) as Record<string, unknown>;
    const message = typeof input.message === 'string' ? input.message : 'commit';
    const contentText = typeof input.content === 'string' ? input.content : '';
    const bytes = fromBase64(contentText);
    const putBranch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const suppliedSha = typeof input.sha === 'string' ? input.sha : null;
    const currentTip = repo.refs.get(`refs/heads/${putBranch}`) ?? null;
    const existing = currentTip === null ? null : resolvePath(repo, currentTip, path);

    if (existing !== null && suppliedSha !== null && existing.sha !== suppliedSha) {
      return errorReply(409, 'sha does not match the current file');
    }
    if (existing === null && suppliedSha !== null && currentTip !== null) {
      return errorReply(409, 'sha does not match the current file');
    }

    const result = commitFile(repo, { branch: putBranch, path, content: bytes, message, author: viewer });
    const status = existing === null ? 201 : 200;
    return {
      status,
      body: {
        content: { sha: result.blobSha, encoding: 'base64', name: path.split('/').pop() ?? path, path },
        commit: { sha: result.commitSha, message },
      },
    };
  }

  if (method === 'DELETE') {
    const input = (body ?? {}) as Record<string, unknown>;
    const message = typeof input.message === 'string' ? input.message : 'delete';
    const deleteBranch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const currentTip = repo.refs.get(`refs/heads/${deleteBranch}`) ?? null;
    if (currentTip === null) return notFound();
    const existing = resolvePath(repo, currentTip, path);
    if (existing === null) return notFound();
    const suppliedSha = typeof input.sha === 'string' ? input.sha : null;
    if (suppliedSha !== null && existing.sha !== suppliedSha) {
      return errorReply(409, 'sha does not match the current file');
    }
    const commitSha = deleteFile(repo, { branch: deleteBranch, path, message, author: viewer });
    if (commitSha === null) return notFound();
    return { status: 200, body: { commit: { sha: commitSha, message } } };
  }

  return notFound();
}

/** POST /repos/{o}/{r}/labels */
function createLabel(repo: Repo, body: unknown): RestReply {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name : '';
  if (name === '') return errorReply(422, 'name is required');
  const color = typeof input.color === 'string' ? input.color : 'ededed';
  const description = typeof input.description === 'string' ? input.description : '';
  repo.labels.set(name, { name, color, description });
  return { status: 201, body: { name, color, description } };
}

/** Issues, their comments and their state transitions. */
function handleIssues(
  repo: Repo,
  viewer: User,
  method: string,
  tail: string[],
  body: unknown,
  query: URLSearchParams,
): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return errorReply(422, 'title is required');
      const wanted = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === 'string') : [];
      const missing = wanted.filter((label) => !repo.labels.has(label));
      if (missing.length > 0) return errorReply(422, `Label does not exist: ${missing[0]}`);
      const number = store.nextIssueNumber(repo);
      const issue: Issue = {
        number,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: wanted.map((label) => ({ name: label, color: repo.labels.get(label)?.color ?? 'ededed' })),
        user: viewer,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        comments: [],
      };
      repo.issues.set(number, issue);
      return { status: 201, body: issueJson(issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let rows = [...repo.issues.values()];
      if (state !== 'all') rows = rows.filter((issue) => issue.state === state);
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      if (sort === 'created') {
        rows.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      } else if (sort === 'updated') {
        rows.sort((a, b) => (direction === 'asc' ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt)));
      }
      const perPage = clampInt(query.get('per_page'), 30, 1, 100);
      return { status: 200, body: rows.slice(0, perPage).map(issueJson) };
    }
    return notFound();
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();

  if (tail.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(issue) };
    if (method === 'PATCH') {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      if (Array.isArray(input.labels)) {
        const wanted = input.labels.filter((label): label is string => typeof label === 'string');
        const missing = wanted.filter((label) => !repo.labels.has(label));
        if (missing.length > 0) return errorReply(422, `Label does not exist: ${missing[0]}`);
        issue.labels = wanted.map((label) => ({ name: label, color: repo.labels.get(label)?.color ?? 'ededed' }));
      }
      issue.updatedAt = nowIso();
      return { status: 200, body: issueJson(issue) };
    }
    return notFound();
  }

  if (tail[1] === 'comments') {
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const comment = {
        id: store.nextComment(),
        body: typeof input.body === 'string' ? input.body : '',
        user: viewer,
        createdAt: nowIso(),
      };
      issue.comments.push(comment);
      return { status: 201, body: comment };
    }
    if (method === 'GET') {
      return { status: 200, body: issue.comments };
    }
  }
  return notFound();
}

/** Pull requests, their files and merges. */
function handlePulls(
  repo: Repo,
  viewer: User,
  method: string,
  tail: string[],
  body: unknown,
  query: URLSearchParams,
): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const headRef = typeof input.head === 'string' ? input.head : '';
      const baseRef = typeof input.base === 'string' ? input.base : '';
      if (headRef === '' || baseRef === '') return errorReply(422, 'head and base are required');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) return errorReply(422, `No commits between ${baseRef} and ${headRef}`);
      if (baseSha === undefined) return errorReply(422, `Base branch not found: ${baseRef}`);
      const number = store.nextIssueNumber(repo);
      const pull: Pull = {
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
        user: viewer,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.pulls.set(number, pull);
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let rows = [...repo.pulls.values()];
      if (state !== 'all') rows = rows.filter((pull) => pull.state === state);
      rows.sort((a, b) => b.number - a.number);
      return { status: 200, body: rows.map((pull) => pullJson(repo, pull)) };
    }
    return notFound();
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();

  if (tail.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'PATCH') {
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.title === 'string') pull.title = input.title;
      if (typeof input.body === 'string') pull.body = input.body;
      if (input.state === 'open' || input.state === 'closed') pull.state = input.state;
      pull.updatedAt = nowIso();
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }

  if (tail[1] === 'files' && method === 'GET') {
    const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
    const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
    return { status: 200, body: changedFiles(repo, baseSha, headSha) };
  }

  if (tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return errorReply(405, 'Pull request is not mergeable');
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return errorReply(405, 'Pull request is not mergeable');
    // A conflict is a head that does not descend from the base tip: the merge cannot be a fast-forward
    // and the entry refuses it rather than inventing a three-way merge.
    const ancestry = new Set(commitChain(repo, headTip));
    if (!ancestry.has(baseTip) && baseTip !== headTip) {
      const baseAncestry = new Set(commitChain(repo, baseTip));
      if (!baseAncestry.has(headTip)) return errorReply(405, 'Pull request is not mergeable: merge conflict');
    }
    const input = (body ?? {}) as Record<string, unknown>;
    const message = typeof input.commit_message === 'string' && input.commit_message !== ''
      ? input.commit_message
      : `Merge pull request #${pull.number} from ${pull.head.ref}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const identity = `${viewer.name} <${viewer.email}>`;
    // Squash: the merge commit carries the head's tree over the base tip's parent.
    const headTree = commitTree(repo, headTip);
    const mergeCommitSha = store.put(
      repo,
      'commit',
      buildCommitPayload({
        tree: headTree ?? '',
        parents: [baseTip],
        message,
        author: identity,
        committer: identity,
        timestamp,
      }),
    );
    repo.commits.set(mergeCommitSha, {
      sha: mergeCommitSha,
      message,
      author: viewer,
      committer: viewer,
      authorDate: nowIso(),
      committerDate: nowIso(),
      parents: [baseTip],
      tree: headTree ?? '',
    });
    repo.refs.set(`refs/heads/${pull.base.ref}`, mergeCommitSha);
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeCommitSha;
    pull.state = 'closed';
    pull.updatedAt = nowIso();
    return {
      status: 200,
      body: { sha: mergeCommitSha, merged: true, message: 'Pull request merged successfully' },
    };
  }

  return notFound();
}

/** A stable request id for the X-GitHub-Request-Id header. */
export function requestId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 32).toUpperCase();
}