// GraphQL v4 surface: a real document parser plus a resolver over the same store REST reads, so a
// repository made over REST resolves over GraphQL and a mutation's effect shows up over REST.
//
// The suite sends gh's own documents (see checks-graphql.ts's GRAPHQL_DOCUMENTS), which means the
// server has to cope with: variable definitions and defaults, aliases (`Issue: __type(name:)`),
// inline fragments (`... on Repository`), introspection on __type (fields, enumValues), arguments
// that carry object literals (`orderBy: {field: CREATED_AT, direction: DESC}`), null arguments,
// cursor pagination (first/after + pageInfo), Relay global ids that are opaque and stable, and
// operation batching (a JSON array body answering an array in order).
//
// Scope kept deliberately concrete: the schema below describes exactly the types and fields the
// suite can ask for. An unknown field is not a 400 — it becomes an `errors` entry with a null data
// slot, which is what `graphql.invalid-field` checks. A missing token is a 401 before parsing.

import { store, type Issue, type Pull, type Repo, type User } from './store.ts';
import { changedFiles, commitParents, commitTree, parseTreeEntries } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Lexer

/** One lexical token of a GraphQL document. */
interface Token {
  kind: 'name' | 'punct' | 'string' | 'number' | 'eof';
  value: string;
}

/** Tokenize a GraphQL document; throws on an unterminated string. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/[\s,]/.test(char)) {
      at += 1;
      continue;
    }
    if (char === '"') {
      // A block string ("""...""") or a plain one; block strings are flattened.
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        const body = end === -1 ? source.slice(at + 3) : source.slice(at + 3, end);
        tokens.push({ kind: 'string', value: body.trim() });
        at = end === -1 ? source.length : end + 3;
        continue;
      }
      let text = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        const current = source[at] as string;
        if (current === '\\') {
          const next = source[at + 1] as string;
          text += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          at += 2;
          continue;
        }
        text += current;
        at += 1;
      }
      at += 1;
      tokens.push({ kind: 'string', value: text });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let name = '';
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at] as string)) {
        name += source[at];
        at += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    if (/[-0-9]/.test(char)) {
      let number = '';
      while (at < source.length && /[-0-9.eE+]/.test(source[at] as string)) {
        number += source[at];
        at += 1;
      }
      tokens.push({ kind: 'number', value: number });
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'punct', value: '...' });
      at += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: char });
    at += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser (just enough of the language: operations, selections, arguments, fragments, aliases)

/** A parsed value: literal, variable reference, object or list. */
type Value =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'variable'; name: string }
  | { kind: 'object'; fields: Record<string, Value> }
  | { kind: 'list'; items: Value[] };

/** One selection: a field with sub-selections, or an inline fragment. */
interface Selection {
  kind: 'field' | 'inlineFragment';
  alias?: string;
  name: string;
  arguments: Record<string, Value>;
  selections: Selection[];
  typeCondition?: string;
}

/** One operation in a document. */
interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  selections: Selection[];
}

/** A whole parsed document. */
interface Document {
  operations: Operation[];
}

/** Recursive-descent parser over the token list. */
class Parser {
  private at = 0;

  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** The current token. */
  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.at + offset, this.tokens.length - 1)] as Token;
  }

  /** Consume the current token when it matches. */
  private eat(value: string): boolean {
    if (this.peek().value === value && (this.peek().kind === 'punct' || this.peek().kind === 'name')) {
      this.at += 1;
      return true;
    }
    return false;
  }

  /** Consume a name token, or throw. */
  private expectName(): string {
    const token = this.peek();
    if (token.kind !== 'name') throw new Error(`expected a name, saw ${JSON.stringify(token.value)}`);
    this.at += 1;
    return token.value;
  }

  /** Parse one document. */
  parseDocument(): Document {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.eat('fragment')) {
        // Fragment definitions are not used by the suite's documents; skip them safely.
        this.skipFragment();
        continue;
      }
      const token = this.peek();
      let kind: Operation['kind'] = 'query';
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        kind = token.value as Operation['kind'];
        this.at += 1;
      } else if (token.value === '{') {
        kind = 'query';
      } else {
        throw new Error(`unexpected ${JSON.stringify(token.value)} at the start of an operation`);
      }
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.expectName();
      if (this.eat('(')) this.skipBalanced('(', ')');
      const selections = this.parseSelectionSet();
      operations.push({ kind, name, selections });
    }
    return { operations };
  }

  /** Skip a fragment definition. */
  private skipFragment(): void {
    if (this.peek().kind === 'name') this.at += 1;
    if (this.eat('on')) this.expectName();
    this.parseSelectionSet();
  }

  /** Skip a balanced group starting at the current token. */
  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (this.peek().kind !== 'eof' && depth > 0) {
      const value = this.peek().value;
      if (value === open) depth += 1;
      else if (value === close) depth -= 1;
      this.at += 1;
    }
  }

  /** Parse `{ ... }`. */
  private parseSelectionSet(): Selection[] {
    if (!this.eat('{')) throw new Error(`expected {, saw ${JSON.stringify(this.peek().value)}`);
    const selections: Selection[] = [];
    while (!this.eat('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.eat('...')) {
        if (this.eat('on')) {
          const typeCondition = this.expectName();
          const inner = this.parseSelectionSet();
          selections.push({ kind: 'inlineFragment', name: 'on', arguments: {}, selections: inner, typeCondition });
        } else {
          // A named fragment spread: inline it is not supported, but skipping keeps parsing alive.
          if (this.peek().kind === 'name') this.at += 1;
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.eat(':')) {
        alias = name;
        name = this.expectName();
      }
      const args: Record<string, Value> = {};
      if (this.eat('(')) {
        while (!this.eat(')')) {
          if (this.peek().kind === 'eof') throw new Error('unterminated argument list');
          const argName = this.expectName();
          if (!this.eat(':')) throw new Error(`expected : after argument ${argName}`);
          args[argName] = this.parseValue();
        }
      }
      let selectionsOut: Selection[] = [];
      if (this.peek().value === '{') selectionsOut = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, arguments: args, selections: selectionsOut });
    }
    return selections;
  }

  /** Parse one value. */
  private parseValue(): Value {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.at += 1;
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.at += 1;
      const items: Value[] = [];
      while (!this.eat(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.at += 1;
      const fields: Record<string, Value> = {};
      while (!this.eat('}')) {
        const key = this.expectName();
        if (!this.eat(':')) throw new Error(`expected : in object literal after ${key}`);
        fields[key] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') {
      this.at += 1;
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'number') {
      this.at += 1;
      return { kind: 'literal', value: Number(token.value) };
    }
    if (token.kind === 'name') {
      this.at += 1;
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      // An enum literal is carried as its name.
      return { kind: 'literal', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Global ids

/** Encode a Relay global id: base64 of `type:id`. */
function globalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

/** An id with the type prefix stripped, or null when it is not ours. */
function decodeGlobalId(value: string): { type: string; id: string } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), id: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Schema description (drives __type introspection and unknown-field detection)

/** Field names per type, plus enum values where a type is an enum. */
const SCHEMA: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Query: {
    fields: ['viewer', 'repository', 'node', '__type', '__typename'],
  },
  Mutation: {
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  },
  Viewer: { fields: ['login', 'id', 'name', 'databaseId', '__typename'] },
  Repository: {
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
      'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
      'pullRequest', 'pullRequests', '__typename',
    ],
  },
  User: { fields: ['login', 'id', 'name', '__typename'] },
  Ref: { fields: ['name', 'target', '__typename'] },
  Issue: {
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'comments', 'author', 'repository', '__typename'],
  },
  IssueConnection: { fields: ['nodes', 'pageInfo', 'totalCount', '__typename'] },
  IssueEdge: { fields: ['cursor', 'node', '__typename'] },
  PageInfo: { fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'] },
  PullRequest: {
    fields: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', '__typename'],
  },
  PullRequestConnection: { fields: ['nodes', 'pageInfo', 'totalCount', '__typename'] },
  PullRequestFileConnection: { fields: ['nodes', 'pageInfo', 'totalCount', '__typename'] },
  PullRequestFile: { fields: ['path', 'additions', 'deletions', 'changeType', '__typename'] },
  Label: { fields: ['name', 'color', '__typename'] },
  LabelConnection: { fields: ['nodes', 'totalCount', '__typename'] },
  Comment: { fields: ['id', 'body', 'author', '__typename'] },
  CommentConnection: { fields: ['nodes', 'totalCount', '__typename'] },
  CommentEdge: { fields: ['node', '__typename'] },
  IssueState: { enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'PULL_REQUEST', 'DISCUSSION'] },
  IssueOrderField: { enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { enumValues: ['ASC', 'DESC'] },
  RepositoryPermission: { enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

/** Every type name that has a schema entry, for __type(name:). */
const TYPE_NAMES = Object.keys(SCHEMA);

/** The types that expose an `id` field and can come back from node(id:). */
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'Comment']);

// ---------------------------------------------------------------------------------------------
// Resolver

/** What the resolver is answering with, plus any errors collected on the way. */
interface ExecResult {
  data: Record<string, unknown> | null;
  errors: { message: string; path?: string[]; locations?: unknown[] }[];
}

/** Abstract context a resolver needs. */
interface Context {
  viewer: User;
  variables: Record<string, unknown>;
}

/** The owner-scoped repository a request may read, or null (foreign owner is invisible here). */
function repoOf(viewer: User, owner: string, name: string): Repo | null {
  const repo = store.repo(owner, name);
  if (repo === null || repo.owner !== viewer.login) return null;
  return repo;
}

/** Interpolate a Value against the request variables. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'variable':
      return variables[value.name] ?? null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

/** Case a field's result: a list to apply pagination/filtering, anything else unchanged. */
function argValue(selection: Selection, name: string, variables: Record<string, unknown>): unknown {
  const value = selection.arguments[name];
  return value === undefined ? undefined : resolveValue(value, variables);
}

/** Apply a selection set to a resolved object. Unknown fields collect an error and resolve to null. */
function project(
  selections: Selection[],
  object: Record<string, unknown>,
  typeName: string,
  context: Context,
  errors: ExecResult['errors'],
  path: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== typeName) continue;
      Object.assign(out, project(selection.selections, object, typeName, context, errors, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!(selection.name in object)) {
      const known = SCHEMA[typeName]?.fields ?? [];
      if (!known.includes(selection.name)) {
        errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = null;
      continue;
    }
    const value = object[selection.name];
    if (selection.selections.length === 0 || value === null || value === undefined) {
      out[key] = value ?? null;
      continue;
    }
    // A nested object (or list of objects) of a known type name.
    const childType = childTypeOf(typeName, selection.name);
    if (Array.isArray(value)) {
      out[key] = value.map((entry, index) =>
        entry === null || typeof entry !== 'object'
          ? entry
          : project(selection.selections, entry as Record<string, unknown>, childType, context, errors, [...path, key, String(index)]),
      );
      continue;
    }
    if (typeof value === 'object') {
      out[key] = project(selection.selections, value as Record<string, unknown>, childType, context, errors, [...path, key]);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The type name a field resolves to, so nested projections know their schema. */
function childTypeOf(parent: string, field: string): string {
  const table: Record<string, Record<string, string>> = {
    Query: { viewer: 'Viewer', repository: 'Repository', node: 'Node' },
    Viewer: {},
    Repository: {
      owner: 'User',
      defaultBranchRef: 'Ref',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequest: 'PullRequest',
      pullRequests: 'PullRequestConnection',
    },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequest: { files: 'PullRequestFileConnection' },
    PullRequestFileConnection: { nodes: 'PullRequestFile', pageInfo: 'PageInfo' },
    Issue: { labels: 'LabelConnection', comments: 'CommentConnection', author: 'User' },
    LabelConnection: { nodes: 'Label' },
    CommentConnection: { nodes: 'Comment' },
    Comment: { author: 'User' },
    Mutation: {},
  };
  return table[parent]?.[field] ?? 'Unknown';
}

/** The repository object in GraphQL's shape. */
function repositoryNode(repo: Repo): Record<string, unknown> {
  return {
    id: globalId('Repository', repo.owner + '/' + repo.name),
    databaseId: 1,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: globalId('User', repo.owner), name: repo.owner },
    description: repo.description,
    isPrivate: repo.private,
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

/** The issue object in GraphQL's shape. */
function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    labels: { nodes: issue.labels.map((label) => ({ name: label.name, color: label.color })), totalCount: issue.labels.length },
    comments: { nodes: issue.comments.map((comment) => ({ id: globalId('Comment', comment.id), body: comment.body, author: { login: comment.user.login } })), totalCount: issue.comments.length },
    author: { login: issue.user.login, id: globalId('User', issue.user.login) },
    repository: { id: globalId('Repository', `${repo.owner}/${repo.name}`) },
  };
}

/** The pull request object in GraphQL's shape. */
function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const files = changedFiles(repo, baseSha, headSha);
  return {
    id: globalId('PullRequest', pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergeable: 'MERGEABLE',
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    files: {
      nodes: files.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      })),
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: files.length,
    },
  };
}

/** Connection helper: page a list of nodes by `first`/`after` with base64 cursors. */
function paginate<T>(
  items: T[],
  first: number | null,
  after: string | null,
): { slice: T[]; pageInfo: Record<string, unknown> } {
  let start = 0;
  if (after !== null && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const index = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
      if (Number.isFinite(index)) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const limit = first === null || !Number.isFinite(first) || first <= 0 ? items.length : first;
  const slice = items.slice(start, start + limit);
  const endIndex = start + slice.length - 1;
  return {
    slice,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length === 0 ? null : Buffer.from(`cursor:${start}`, 'utf8').toString('base64'),
      endCursor: slice.length === 0 ? null : Buffer.from(`cursor:${endIndex}`, 'utf8').toString('base64'),
    },
  };
}

/** Execute one operation against the store. */
function execute(operation: Operation, viewer: User, variables: Record<string, unknown>): ExecResult {
  const errors: ExecResult['errors'] = [];
  const context: Context = { viewer, variables };

  if (operation.kind === 'mutation') {
    return executeMutation(operation, context, errors);
  }

  /** Resolve one root field. */
  const resolveRoot = (selection: Selection): unknown => {
    switch (selection.name) {
      case 'viewer':
        return { login: viewer.login, id: globalId('User', viewer.login), name: viewer.name, databaseId: 1 };
      case 'repository': {
        const owner = String(argValue(selection, 'owner', variables) ?? '');
        const name = String(argValue(selection, 'name', variables) ?? '');
        const repo = repoOf(viewer, owner, name);
        return repo === null ? null : repositoryNode(repo);
      }
      case 'node': {
        const id = String(argValue(selection, 'id', variables) ?? '');
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const [owner, name] = decoded.id.split('/') as [string, string];
          const repo = repoOf(viewer, owner, name ?? '');
          return repo === null ? null : { __typeName: 'Repository', ...repositoryNode(repo) };
        }
        if (decoded.type === 'Issue') {
          for (const repo of store.reposOf(viewer.login)) {
            const issue = repo.issues.get(Number(decoded.id));
            if (issue !== undefined) return { __typeName: 'Issue', ...issueNode(repo, issue) };
          }
          return null;
        }
        if (decoded.type === 'PullRequest') {
          for (const repo of store.reposOf(viewer.login)) {
            const pull = repo.pulls.get(Number(decoded.id));
            if (pull !== undefined) return { __typeName: 'PullRequest', ...pullNode(repo, pull) };
          }
          return null;
        }
        return null;
      }
      case '__type': {
        const name = String(argValue(selection, 'name', variables) ?? '');
        const entry = SCHEMA[name];
        if (entry === undefined) return null;
        const fields = entry.fields ?? [];
        return {
          kind: entry.enumValues === undefined ? 'OBJECT' : 'ENUM',
          name,
          fields: fields.map((field) => ({ name: field, isDeprecated: false, deprecationReason: null })),
          enumValues: (entry.enumValues ?? []).map((value) => ({ name: value, isDeprecated: false, deprecationReason: null })),
        };
      }
      default:
        errors.push({ message: `Field '${selection.name}' doesn't exist on type 'Query'` });
        return null;
    }
  };

  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'inlineFragment') continue;
    const key = selection.alias ?? selection.name;
    const resolved = resolveRoot(selection);
    if (resolved === null || typeof resolved !== 'object') {
      data[key] = resolved;
      continue;
    }
    const record = resolved as Record<string, unknown>;
    const typeName = typeof record.__typeName === 'string' ? (record.__typeName as string) : selection.name === 'viewer' ? 'Viewer' : selection.name === 'repository' ? 'Repository' : selection.name === 'node' ? (typeof record.__typeName === 'string' ? record.__typeName : 'Unknown') : 'Unknown';
    delete record.__typeName;

    // The connection fields need their arguments and paging, so they get resolved before projection.
    enrichConnections(selection.selections, record, selection.name, viewer, variables);

    data[key] = project(selection.selections, record, typeName, context, errors, [key]);
  }
  return { data, errors };
}

/** Pre-resolve connection fields (issues, pullRequests, files) with their arguments. */
function enrichConnections(
  selections: Selection[],
  record: Record<string, unknown>,
  rootField: string,
  viewer: User,
  variables: Record<string, unknown>,
): void {
  void rootField;
  if (selections.length === 0) return;
  const repositoryId = typeof record.id === 'string' ? record.id : '';
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    if (selection.name !== 'issues' && selection.name !== 'pullRequests') continue;
    const decoded = decodeGlobalId(repositoryId);
    if (decoded === null || decoded.type !== 'Repository') continue;
    const [owner, name] = decoded.id.split('/') as [string, string];
    const repo = repoOf(viewer, owner, name ?? '');
    if (repo === null) continue;

    if (selection.name === 'issues') {
      const states = argValue(selection, 'states', variables);
      const first = argValue(selection, 'first', variables);
      const after = argValue(selection, 'after', variables);
      let rows = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state)));
        rows = rows.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const orderBy = argValue(selection, 'orderBy', variables) as Record<string, unknown> | undefined;
      const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'DESC';
      rows.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      const page = paginate(rows, typeof first === 'number' ? first : null, typeof after === 'string' ? after : null);
      record.issues = {
        nodes: page.slice.map((issue) => issueNode(repo, issue)),
        pageInfo: page.pageInfo,
        totalCount: rows.length,
      };
    }

    if (selection.name === 'pullRequests') {
      const first = argValue(selection, 'first', variables);
      const after = argValue(selection, 'after', variables);
      const rows = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const page = paginate(rows, typeof first === 'number' ? first : null, typeof after === 'string' ? after : null);
      record.pullRequests = {
        nodes: page.slice.map((pull) => pullNode(repo, pull)),
        pageInfo: page.pageInfo,
        totalCount: rows.length,
      };
    }
  }

  // issue(number:) and pullRequest(number:) need their numeric argument.
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    if (selection.name !== 'issue' && selection.name !== 'pullRequest') continue;
    const decoded = decodeGlobalId(repositoryId);
    if (decoded === null || decoded.type !== 'Repository') continue;
    const [owner, name] = decoded.id.split('/') as [string, string];
    const repo = repoOf(viewer, owner, name ?? '');
    if (repo === null) continue;
    const number = Number(argValue(selection, 'number', variables));
    if (selection.name === 'issue') {
      const issue = repo.issues.get(number);
      record.issue = issue === undefined ? null : issueNode(repo, issue);
    } else {
      const pull = repo.pulls.get(number);
      record.pullRequest = pull === undefined ? null : pullNode(repo, pull);
    }
  }
}

/** Execute a mutation operation. */
function executeMutation(operation: Operation, context: Context, errors: ExecResult['errors']): ExecResult {
  const { viewer, variables } = context;
  const data: Record<string, unknown> = {};

  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    const input = (argValue(selection, 'input', variables) ?? {}) as Record<string, unknown>;
    const typeName = 'Mutation';

    switch (selection.name) {
      case 'createIssue': {
        const repo = repoByNameOrId(viewer, input);
        if (repo === null) {
          errors.push({ message: 'Could not resolve to a Repository with the given id' });
          data[key] = null;
          break;
        }
        const number = store.nextIssueNumber(repo);
        const issue: Issue = {
          number,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          user: viewer,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          comments: [],
        };
        repo.issues.set(number, issue);
        data[key] = project(
          selection.selections,
          { issue: issueNode(repo, issue) },
          typeName,
          context,
          errors,
          [key],
        );
        break;
      }
      case 'closeIssue': {
        const id = typeof input.issueId === 'string' ? input.issueId : '';
        const decoded = decodeGlobalId(id);
        let found: { repo: Repo; issue: Issue } | null = null;
        for (const repo of store.reposOf(viewer.login)) {
          const issue = repo.issues.get(Number(decoded?.id));
          if (issue !== undefined) found = { repo, issue };
        }
        if (found === null) {
          errors.push({ message: 'Could not resolve to an Issue with the given id' });
          data[key] = null;
          break;
        }
        found.issue.state = 'closed';
        data[key] = project(
          selection.selections,
          { issue: issueNode(found.repo, found.issue) },
          typeName,
          context,
          errors,
          [key],
        );
        break;
      }
      case 'createPullRequest': {
        const repo = repoByNameOrId(viewer, input);
        if (repo === null) {
          errors.push({ message: 'Could not resolve to a Repository with the given id' });
          data[key] = null;
          break;
        }
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined || baseSha === undefined) {
          errors.push({ message: `No commits between ${baseRef} and ${headRef}` });
          data[key] = null;
          break;
        }
        const number = store.nextIssueNumber(repo);
        const pull: Pull = {
          number,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          head: { ref: headRef, sha: headSha },
          base: { ref: baseRef, sha: baseSha },
          user: viewer,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        repo.pulls.set(number, pull);
        data[key] = project(selection.selections, { pullRequest: pullNode(repo, pull) }, typeName, context, errors, [key]);
        break;
      }
      case 'mergePullRequest': {
        const id = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
        const decoded = decodeGlobalId(id);
        let found: { repo: Repo; pull: Pull } | null = null;
        for (const repo of store.reposOf(viewer.login)) {
          const pull = repo.pulls.get(Number(decoded?.id));
          if (pull !== undefined) found = { repo, pull };
        }
        if (found === null) {
          errors.push({ message: 'Could not resolve to a PullRequest with the given id' });
          data[key] = null;
          break;
        }
        const { repo, pull } = found;
        const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
        const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
        if (baseTip !== undefined && headTip !== undefined && !pull.merged) {
          // Squash merge: the head's tree over the base tip, one parent, then move the base ref.
          const headTree = commitTree(repo, headTip);
          const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
          const body = Buffer.from(
            `tree ${headTree ?? ''}\nparent ${baseTip}\nauthor ${viewer.name} <${viewer.email}> ${Math.floor(Date.now() / 1000)} +0000\ncommitter ${viewer.name} <${viewer.email}> ${Math.floor(Date.now() / 1000)} +0000\n\n${message}\n`,
            'utf8',
          );
          const sha = store.put(repo, 'commit', body);
          repo.commits.set(sha, {
            sha,
            message,
            author: viewer,
            committer: viewer,
            authorDate: new Date().toISOString(),
            committerDate: new Date().toISOString(),
            parents: [baseTip],
            tree: headTree ?? '',
          });
          repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
          pull.merged = true;
          pull.mergedAt = new Date().toISOString();
          pull.mergeCommitSha = sha;
          pull.state = 'closed';
        }
        data[key] = project(selection.selections, { pullRequest: pullNode(repo, pull) }, typeName, context, errors, [key]);
        break;
      }
      case 'addComment': {
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
        const decoded = decodeGlobalId(subjectId);
        let found: { repo: Repo; issue: Issue } | null = null;
        for (const repo of store.reposOf(viewer.login)) {
          const issue = repo.issues.get(Number(decoded?.id));
          if (issue !== undefined) found = { repo, issue };
        }
        if (found === null) {
          errors.push({ message: 'Could not resolve to an Issue with the given id' });
          data[key] = null;
          break;
        }
        const comment = {
          id: store.nextComment(),
          body: String(input.body ?? ''),
          user: viewer,
          createdAt: new Date().toISOString(),
        };
        found.issue.comments.push(comment);
        data[key] = project(
          selection.selections,
          { commentEdge: { node: { id: globalId('Comment', comment.id), body: comment.body, author: { login: viewer.login } } } },
          typeName,
          context,
          errors,
          [key],
        );
        break;
      }
      default:
        errors.push({ message: `Field '${selection.name}' doesn't exist on type 'Mutation'` });
        data[key] = null;
    }
  }

  return { data, errors };
}

/** Resolve a repository from a mutation input's repositoryId (a global id). */
function repoByNameOrId(viewer: User, input: Record<string, unknown>): Repo | null {
  const id = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  const [owner, name] = decoded.id.split('/') as [string, string];
  return repoOf(viewer, owner ?? '', name ?? '');
}

// ---------------------------------------------------------------------------------------------
// HTTP glue

/** A GraphQL HTTP reply. */
export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Answer one GraphQL request body. A JSON array is GitHub's operation batching. */
export function handleGraphQL(body: unknown, viewer: User | null): GraphQLReply {
  if (viewer === null) return { status: 401, body: { message: 'Requires authentication' } };

  /** Run one `{query, variables, operationName}` request. */
  const runOne = (entry: unknown): unknown => {
    const request = (entry ?? {}) as Record<string, unknown>;
    const query = typeof request.query === 'string' ? request.query : '';
    const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
    if (query.trim() === '') {
      return { data: null, errors: [{ message: 'A query string is required' }] };
    }
    let document: Document;
    try {
      document = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    const operation = document.operations[0];
    if (operation === undefined) {
      return { data: null, errors: [{ message: 'No operation in the document' }] };
    }
    const result = execute(operation, viewer, variables);
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  };

  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}

export { TYPE_NAMES, NODE_TYPES, globalId, decodeGlobalId, lex, Parser, commitParents, parseTreeEntries };