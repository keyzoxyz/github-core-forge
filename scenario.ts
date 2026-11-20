// The seeded scenario, replicated from the env's own generator. The env's build scenario is
// deterministic from a fixed 64-bit seed, so the entry can grow the very same viewer login, user
// list and 30 viewer repositories the suite expects, without asking the env for them. Everything
// here mirrors program/env/src/wire.ts (its RNG is splitmix64; its name, repo and path tables are
// the ones below), because the checks compare what the server answers against these seeded rows.

/** The env's fixed scenario seed: the same constant its wire.ts holds. */
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const U64_MASK = 0xffffffffffffffffn;

/** FNV-1a 64 over a label's characters. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64 finalizer. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** A stream seed for a label, as the env derives one. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** The env's RNG: splitmix64, with the same unbiased nextInt. */
class Rng {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** A stream from a label. */
  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error(`nextInt ${maxExclusive}`);
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  chance(probability: number): boolean {
    return this.nextU32() / 4294967296 < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = swap;
    }
    return copy;
  }
}

export { Rng, scenarioSeedFor, mix64, fnv1a64 };

// -------------------------------------------------------------------------------------------
// Name tables (the env's own)

export const FIRST_NAMES: readonly string[] = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];

export const LAST_NAMES: readonly string[] = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

export const REPO_ADJECTIVES: readonly string[] = ['amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat', 'vivid', 'warm', 'witty', 'young', 'zesty'];

export const REPO_NOUNS: readonly string[] = ['acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor', 'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven', 'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr'];

// -------------------------------------------------------------------------------------------
// Seeded users and viewer repositories

/** A seeded user row. */
export interface SeededUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** A seeded repository name row (owner filled in by the caller). */
export interface SeededRepo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
}

export const REPO_DESCRIPTIONS: readonly string[] = ['a small service with a sharp edge', 'notes and experiments, kept until they are not', 'the tooling behind the thing', 'a reference implementation, for reading', 'what the prototype became', 'fixtures, generators and the odd benchmark', 'the parts that must not break', 'a sandbox for the next idea'];

/** `count` users with unique logins, deterministic for this scenario. */
function generateUsers(count: number): SeededUser[] {
  const rng = Rng.fromLabel('users');
  const used = new Set<string>();
  const users: SeededUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** `count` repository names for `owner`, deterministic for this scenario. */
function generateRepos(count: number, label: string, firstId: number): SeededRepo[] {
  const rng = Rng.fromLabel(label);
  const used = new Set<string>();
  const repos: SeededRepo[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const base = `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    // The env draws a description after each name, which advances the stream; skipping that draw
    // would shift every later repository.
    repos.push({
      id: firstId + i,
      name,
      description: rng.pick(REPO_DESCRIPTIONS),
      private: i % 7 === 3,
      defaultBranch: 'main',
    });
  }
  return repos;
}

const SCENARIO_USERS = 12;
const SCENARIO_VIEWER_REPOS = 30;

/** The seeded users; index 0 is the viewer. */
const USERS = generateUsers(SCENARIO_USERS);

/** The viewer the trial's token names: the first seeded user. */
export const VIEWER: SeededUser = USERS[0] as SeededUser;

/** The 30 repositories the viewer owns before the suite creates any more. */
export const VIEWER_REPOS: SeededRepo[] = generateRepos(SCENARIO_VIEWER_REPOS, 'repos.viewer', 5000);
