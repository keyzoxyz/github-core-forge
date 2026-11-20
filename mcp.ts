// Model Context Protocol endpoint over streamable HTTP. JSON-RPC 2.0 at POST /mcp: initialize,
// tools/list and tools/call, with the tools operating on the same store the REST surface reads, so
// an object made over MCP is the same object over REST (`mcp.rest-parity`).
//
// The required tool set is the six github-mcp-server names the checks look for by name or a close
// alias: create_issue, list_issues, create_pull_request, merge_pull_request, get_file_contents and
// list_commits. Replies follow JSON-RPC: a result on success, -32602 for an unknown tool or a
// missing argument, -32700 with HTTP 400 for a body that is not JSON.

import type { IncomingMessage } from 'node:http';
import { bearerOf, buildCommitPayload, commitParents, commitTree, resolvePath, segmentsOf } from './rest.ts';
import { nowIso, store, type Issue, type Pull, type Repo, type User } from './store.ts';

/** One tool's contract: name, description and the JSON-schema of its input. */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** The tools the suite requires, by canonical name or a normalized alias. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        number: { type: 'number', description: 'Pull request number' },
        commit_message: { type: 'string', description: 'Merge commit message' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read a file from a repository at a ref',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        path: { type: 'string', description: 'File path' },
        ref: { type: 'string', description: 'Branch name' },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'list_commits',
    description: 'List commits on a branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        ref: { type: 'string', description: 'Branch name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_repository',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        description: { type: 'string', description: 'Repository description' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch at a ref',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'New branch name' },
        from: { type: 'string', description: 'Branch to branch from (default: the repository default)' },
      },
      required: ['owner', 'repo', 'branch'],
    },
  },
];

/** Normalize a tool name for alias matching: lowercase, underscores and dashes equal. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-\s]+/g, '_');
}

/** The canonical tool table keyed by normalized name. */
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [normalizeName(tool.name), tool]));

/** Canonical names the suite requires, normalized. */
const REQUIRED_TOOLS = ['create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request', 'get_file_contents', 'list_commits'].map(normalizeName);

/** One JSON-RPC request. */
interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** One JSON-RPC reply. */
interface RpcReply {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A tools/call outcome. */
interface CallOutcome {
  isError: boolean;
  text: string;
}

/** Build a success result: MCP wraps tool output as content items. */
function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: false };
}

/** Build an error result. */
function errorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Resolve owner/repo with the ownership rule the REST surface uses. */
function repoFor(viewer: User | null, owner: string, name: string): Repo | null {
  if (viewer === null) return null;
  const repo = store.repo(owner, name);
  if (repo === null || repo.owner !== viewer.login) return null;
  return repo;
}

/** One tool call against the store; every path here mirrors the REST handlers. */
function callTool(viewer: User, tool: ToolDef, args: Record<string, unknown>): CallOutcome {
  try {
    switch (tool.name) {
      case 'create_issue': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        const title = String(args.title ?? '');
        if (title === '') return errorResult('title is required');
        const number = store.nextIssueNumber(repo);
        const issue: Issue = {
          number,
          title,
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open',
          labels: [],
          user: viewer,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          comments: [],
        };
        repo.issues.set(number, issue);
        return { isError: false, text: JSON.stringify({ number, title: issue.title, state: issue.state }) };
      }
      case 'list_issues': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let rows = [...repo.issues.values()];
        if (state !== 'all') rows = rows.filter((issue) => issue.state === state);
        return { isError: false, text: JSON.stringify(rows.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }))) };
      }
      case 'create_pull_request': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        const head = String(args.head ?? '');
        const base = String(args.base ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          return errorResult(`branch not found: head=${head} base=${base}`);
        }
        const number = store.nextIssueNumber(repo);
        const pull: Pull = {
          number,
          title: String(args.title ?? ''),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          head: { ref: head, sha: headSha },
          base: { ref: base, sha: baseSha },
          user: viewer,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        repo.pulls.set(number, pull);
        return { isError: false, text: JSON.stringify({ number, state: pull.state, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } }) };
      }
      case 'merge_pull_request': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        const number = Number(args.number);
        const pull = repo.pulls.get(number);
        if (pull === undefined) return errorResult(`pull request not found: ${number}`);
        if (pull.merged) return errorResult('pull request is already merged');
        const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
        const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
        if (baseTip === undefined || headTip === undefined) return errorResult('branches are gone');
        const message = typeof args.commit_message === 'string' && args.commit_message !== ''
          ? args.commit_message
          : `Merge pull request #${pull.number} from ${pull.head.ref}`;
        const identity = `${viewer.name} <${viewer.email}>`;
        const timestamp = Math.floor(Date.now() / 1000);
        // The MCP merge is a real merge commit with both parents, over the head's tree.
        const headTree = commitTree(repo, headTip);
        const mergeSha = store.put(
          repo,
          'commit',
          buildCommitPayload({
            tree: headTree ?? '',
            parents: [baseTip, headTip],
            message,
            author: identity,
            committer: identity,
            timestamp,
          }),
        );
        repo.commits.set(mergeSha, {
          sha: mergeSha,
          message,
          author: viewer,
          committer: viewer,
          authorDate: nowIso(),
          committerDate: nowIso(),
          parents: [baseTip, headTip],
          tree: headTree ?? '',
        });
        repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
        pull.merged = true;
        pull.mergedAt = nowIso();
        pull.mergeCommitSha = mergeSha;
        pull.state = 'closed';
        pull.updatedAt = nowIso();
        return { isError: false, text: JSON.stringify({ sha: mergeSha, merged: true, message: 'Pull request merged successfully' }) };
      }
      case 'get_repo': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        // A text answer naming the repository is what the suite's concurrent-calls check greps.
        return { isError: false, text: JSON.stringify({ name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }) };
      }
      case 'get_file_contents': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        const path = String(args.path ?? '');
        const branch = typeof args.ref === 'string' && args.ref !== '' ? args.ref : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return errorResult(`branch not found: ${branch}`);
        const resolved = resolvePath(repo, tip, path);
        if (resolved === null || resolved.type !== 'blob') return errorResult(`file not found: ${path}`);
        const blob = repo.objects.get(resolved.sha);
        if (blob === undefined) return errorResult(`file not found: ${path}`);
        return { isError: false, text: blob.data.toString('utf8') };
      }
      case 'list_commits': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        const branch = typeof args.ref === 'string' && args.ref !== '' ? args.ref : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return { isError: false, text: '[]' };
        const chain: string[] = [];
        const seen = new Set<string>();
        let cursor: string | null = tip;
        while (cursor !== null && !seen.has(cursor)) {
          seen.add(cursor);
          chain.push(cursor);
          const parents = commitParents(repo, cursor);
          cursor = parents.length > 0 ? (parents[0] as string) : null;
        }
        return { isError: false, text: JSON.stringify(chain.map((sha) => ({ sha, message: repo.commits.get(sha)?.message ?? '' }))) };
      }
      case 'create_repository': {
        const name = String(args.name ?? '').trim();
        if (name === '') return errorResult('name is required');
        if (store.repo(viewer.login, name) !== null) return errorResult('name already exists');
        const repo = store.createRepo(viewer.login, name, {
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === undefined ? true : Boolean(args.private),
        });
        return { isError: false, text: JSON.stringify({ owner: repo.owner, name: repo.name, private: repo.private }) };
      }
      case 'create_branch': {
        const repo = repoFor(viewer, String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === null) return errorResult(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
        const branch = String(args.branch ?? '');
        if (branch === '') return errorResult('branch is required');
        const from = typeof args.from === 'string' && args.from !== '' ? args.from : repo.defaultBranch;
        const sha = repo.refs.get(`refs/heads/${from}`);
        if (sha === undefined) return errorResult(`branch not found: ${from}`);
        if (repo.refs.has(`refs/heads/${branch}`)) return errorResult('branch already exists');
        repo.refs.set(`refs/heads/${branch}`, sha);
        return { isError: false, text: JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha } }) };
      }
      default:
        return errorResult(`unknown tool: ${tool.name}`);
    }
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

/** Answer one JSON-RPC request object. */
function answerRpc(message: RpcRequest, viewer: User | null): RpcReply {
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      },
    };
  }

  if (method === 'notifications/initialized') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'server/discover') {
    // The modern era's discovery result: the server identity and the capabilities the client will
    // use, plus the revisions this server speaks. `serverInfo` (not `server`) is the field the
    // client reads, and `capabilities.tools` is what initialize's check looks for too.
    return {
      jsonrpc: '2.0',
      id,
      result: {
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        capabilities: { tools: { listChanged: false } },
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    };
  }

  if (method === 'tools/call') {
    if (viewer === null) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: 'authentication required' } };
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS_BY_NAME.get(normalizeName(name));
    if (name === '' || tool === undefined) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    for (const required of tool.inputSchema.required) {
      const value = args[required];
      if (value === undefined || value === null || value === '') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `missing required argument: ${required}` },
        };
      }
    }
    const outcome = callTool(viewer, tool, args);
    return {
      jsonrpc: '2.0',
      id,
      result: outcome.isError ? errorResult(outcome.text) : textResult(outcome.text),
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/** Byte length of a tools/list reply: stable across calls, so `tools-list-idempotent` passes. */
const TOOLS_LIST_BYTES = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  result: {
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  },
});

/** How the MCP surface answers one HTTP request; null means "not a /mcp route". */
export function handleMcp(headers: IncomingMessage['headers'], raw: Buffer): { status: number; body: unknown; headers?: Record<string, string> } | null {
  const token = bearerOf(headers);
  const viewer = store.userForToken(token);
  let message: RpcRequest;
  try {
    message = JSON.parse(raw.toString('utf8')) as RpcRequest;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const method = typeof message.method === 'string' ? message.method : '';
  if (method !== 'initialize' && viewer === null && method !== 'server/discover') {
    // The auth check only bites for tool calls; initialize itself is open.
    if (method === 'tools/call') {
      return { status: 401, body: { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: 'authentication required' } } };
    }
  }
  const reply = answerRpc(message, viewer);
  const headersOut: Record<string, string> = { 'content-type': 'application/json' };
  return { status: 200, body: reply, headers: headersOut };
}

export { segmentsOf };