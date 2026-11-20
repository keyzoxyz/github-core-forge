// GitHub-like forge: in-memory state shared by every surface (REST v3, GraphQL v4, MCP, git smart
// HTTP). One process, one trial, no persistence needed: the env recreates the entry per trial and
// every check builds what it needs through the API, so plain Maps are the whole store.
//
// Object identity follows git: a blob's id is the SHA-1 of `blob <len>\0<bytes>`, a tree and commit
// likewise. The REST contents API and the git smart-HTTP surface therefore agree on every sha
// without a translation layer, which is what `mcp.rest-parity` and the git checks compare.

import { createHash } from 'node:crypto';
import { VIEWER, VIEWER_REPOS } from './scenario.ts';

/** SHA-1 of a git object: `<type> <byteLen>\0<payload>`, hex. */
export function gitObjectId(type: 'blob' | 'tree' | 'commit' | 'tag', payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\u0000`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, payload])).digest('hex');
}

/** A stored git object; `data` is the payload without the git header. */
export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

/** One ref: a branch or a tag, stored as refs/heads/<name> or refs/tags/<name>. */
export interface GitRef {
  name: string;
  sha: string;
}

/** A user the seeded scenario names; the token's login owns repositories. */
export interface User {
  login: string;
  name: string;
  email: string;
}

/** A repository: its identity, its refs and its object database. */
export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  /** Number of the next issue or pull opened in this repository (one counter, as GitHub shares it). */
  nextNumber: number;
  /** Labels created through POST /labels, keyed by name. */
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Objects keyed by sha; the same map the git surface advertises and packs. */
  objects: Map<string, GitObject>;
  /** refs/heads/<name> -> sha */
  refs: Map<string, string>;
  /** commit sha -> parents, message and timestamps, for the REST commits surface. */
  commits: Map<string, CommitMeta>;
  /** Unborn repositories have no commit yet: contents PUT still has to work. */
  createdAt: string;
}

export interface CommitMeta {
  sha: string;
  message: string;
  author: User;
  committer: User;
  authorDate: string;
  committerDate: string;
  parents: string[];
  tree: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  user: User;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: User;
  createdAt: string;
  updatedAt: string;
}

/** The whole store. One instance per process. */
export class Store {
  readonly users = new Map<string, User>();
  /** owner/name -> Repo */
  readonly repos = new Map<string, Repo>();
  /** The login the bearer token names: repositories it creates are its own. */
  readonly tokenLogins: Map<string, User> = new Map();
  private nextCommentId = 1;

  /** A repository key, `owner/name`. */
  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Register a login this token may act as. The env seeds one token per trial. */
  registerToken(token: string, user: User): void {
    this.tokenLogins.set(token, user);
  }

  /** The user a bearer token names, or null when the token is not one the env seeded. */
  userForToken(token: string | null): User | null {
    if (token === null) return null;
    return this.tokenLogins.get(token) ?? null;
  }

  /** A repository by owner and name, or null. */
  repo(owner: string, name: string): Repo | null {
    return this.repos.get(Store.key(owner, name)) ?? null;
  }

  /** Create a repository; the caller has already refused duplicates. */
  createRepo(owner: string, name: string, options: { description?: string; private?: boolean } = {}): Repo {
    const repo: Repo = {
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? true,
      defaultBranch: 'main',
      nextNumber: 1,
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      objects: new Map(),
      refs: new Map(),
      commits: new Map(),
      createdAt: nowIso(),
    };
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  /** Every repository the given login owns, oldest first (the pagination check walks this). */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  /** Take the next issue/pull number in a repository (GitHub shares one counter). */
  nextIssueNumber(repo: Repo): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  /** A comment id, process-wide and monotonic from 1. */
  nextComment(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** Store a git object in one repository and return its sha. Idempotent: same bytes, one object. */
  put(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const sha = gitObjectId(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }
}

/** An ISO-8601 timestamp at second resolution, GitHub's REST format. */
export function nowIso(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A single shared store for the process. */
export const store = new Store();

/**
 * Seed the store the way the env's scenario demands: register the viewer's token, create the 30
 * repositories the scenario says the viewer already owns, and give each one its seeded description
 * and visibility. The token comes from MAKEFUN_SHOP_TOKEN (the variable the rules name); when it is
 * absent — a local run outside a trial — a placeholder is registered so the server still answers.
 */
export function seedScenario(token: string): void {
  const viewer: User = { login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
  store.users.set(viewer.login, viewer);
  store.registerToken(token, viewer);
  for (const seed of VIEWER_REPOS) {
    const repo = store.createRepo(viewer.login, seed.name, { description: seed.description, private: seed.private });
    repo.createdAt = nowIso();
  }
}

/** The environment variable that carries the trial's bearer token. */
export const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';

/** Seed from the process environment; safe to call once, at import time. */
export function seedFromEnvironment(): void {
  const token = process.env[TOKEN_ENV] ?? '';
  seedScenario(token === '' ? 'local-dev-token' : token);
}