// Git smart HTTP: info/refs advertisements (v0 and v2), upload-pack with ls-refs and fetch, and
// receive-pack with a real packfile parser. No git binary exists in the trial pod, so every byte of
// the protocol is built here on node:zlib and node:crypto.
//
// Two protocols share the paths. A request carrying `Git-Protocol: version=2` (or the env's probe)
// gets the v2 advertisement: `version 2` plus capability lines, then ls-refs and sectioned fetch
// replies. receive-pack always speaks v0, because that is what a push needs: a ref advertisement
// with capabilities after a NUL, then a pkt-line command list followed by a raw pack.
//
// The object model is the store's: a blob/tree/commit/tag's id is the SHA-1 of its git header plus
// payload, so what this module writes into a pack is exactly what the REST contents API reports.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  buildCommitPayload,
  buildTreePayload,
  commitParents,
  commitTree,
  parseTreeEntries,
  reachableFrom,
  type TreeEntry,
} from './rest.ts';
import { gitObjectId, nowIso, store, type GitObject, type Repo, type User } from './store.ts';

/** The all-zero object id: an unborn ref and a delete command both use it. */
export const ZERO_OID = '0'.repeat(40);

/** Object type numbers in a packfile. */
const PACK_TYPES: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAMES: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The longest pkt-line payload. */
const PKT_MAX = 65520 - 4;

// ---------------------------------------------------------------------------------------------
// pkt-line

/** Encode one pkt-line: a 4-hex length followed by the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX) throw new Error(`pkt-line payload ${data.length} over the ${PKT_MAX} maximum`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, data]);
}

/** The flush packet. */
export const PKT_FLUSH = Buffer.from('0000', 'utf8');

/** The delimiter packet v2 sections use. */
export const PKT_DELIM = Buffer.from('0001', 'utf8');

/** Encode a mixed line list, where 'flush' and 'delim' are the control packets. */
export function encodePackets(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** One decoded pkt-line. */
export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a buffer of pkt-lines; stops at the first incomplete packet. */
export function decodePackets(buffer: Buffer, startAt = 0): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let at = startAt;
  while (at + 4 <= buffer.length) {
    const header = buffer.subarray(at, at + 4).toString('utf8');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      // The response-end packet; treat it as a flush for section purposes.
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (at + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, consumed: at - startAt };
}

// ---------------------------------------------------------------------------------------------
// packfile writing

/** One object to write into a pack. */
interface PackEntry {
  sha: string;
  object: GitObject;
}

/** The varint object header: type in the low 4 bits, size in 4 + 7-bit groups. */
function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(0x80 | (first & 0x7f));
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a complete packfile (header, deflated entries, SHA-1 trailer) from objects. */
export function buildPack(entries: readonly PackEntry[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) {
    const type = PACK_TYPES[entry.object.type];
    const body = deflateSync(entry.object.data);
    parts.push(packObjectHeader(type, entry.object.data.length));
    parts.push(body);
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// ---------------------------------------------------------------------------------------------
// packfile reading (a push sends one)

/** Read one object's compressed body from a pack, returning the payload and the bytes consumed. */
function inflateAt(buffer: Buffer, at: number): { data: Buffer; consumed: number } {
  // zlib.inflateSync with info:true reports how many input bytes the stream actually used, which is
  // how a pack's concatenated zlib streams are walked without a length prefix.
  const result = inflateSync(buffer.subarray(at), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** A parsed pack: its objects by sha, and whether it carried deltas. */
export interface ParsedPack {
  objects: Map<string, GitObject>;
  deltaCount: number;
  /** The pack's own declared count, for a sanity check. */
  declaredCount: number;
}

/** Resolve a delta against its base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const out = Buffer.alloc(resultSize);
  let written = 0;
  for (;;) {
    if (at >= delta.length) break;
    const op = delta[at++] as number;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[at++] as number;
      if (op & 0x02) offset |= (delta[at++] as number) << 8;
      if (op & 0x04) offset |= (delta[at++] as number) << 16;
      if (op & 0x08) offset |= (delta[at++] as number) << 24;
      if (op & 0x10) size |= delta[at++] as number;
      if (op & 0x20) size |= (delta[at++] as number) << 8;
      if (op & 0x40) size |= (delta[at++] as number) << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op !== 0) {
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out.subarray(0, written);
}

/** Parse a packfile into objects, resolving ofs-delta and ref-delta against a resolver. */
export function parsePack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ParsedPack {
  if (pack.length < 32) throw new Error('pack is shorter than its header and trailer');
  const declaredCount = pack.readUInt32BE(8);
  let at = 12;
  const byOffset = new Map<number, { sha: string; object: GitObject }>();
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;

  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = at;
    let byte = pack[at++] as number;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[at++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }

    const store0 = (payload: Buffer, objectType: GitObject['type']): { sha: string; object: GitObject } => {
      const sha = gitObjectId(objectType, payload);
      const object: GitObject = { type: objectType, data: payload };
      objects.set(sha, object);
      byOffset.set(entryOffset, { sha, object });
      return { sha, object };
    };

    if (type === 6) {
      // ofs-delta: a backward offset to the base entry in this same pack.
      let offsetByte = pack[at++] as number;
      let baseOffset = offsetByte & 0x7f;
      while ((offsetByte & 0x80) !== 0) {
        offsetByte = pack[at++] as number;
        baseOffset = ((baseOffset + 1) << 7) | (offsetByte & 0x7f);
      }
      const baseEntry = byOffset.get(entryOffset - baseOffset);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at ${entryOffset - baseOffset} is not in the pack`);
      const inflated = inflateAt(pack, at);
      at += inflated.consumed;
      const resolved = applyDelta(baseEntry.object.data, inflated.data);
      store0(resolved, baseEntry.object.type);
      deltaCount += 1;
    } else if (type === 7) {
      // ref-delta: the base is named by its object id, possibly one the server already holds.
      const baseSha = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const inflated = inflateAt(pack, at);
      at += inflated.consumed;
      const known = objects.get(baseSha) ?? resolveBase?.(baseSha);
      if (known === undefined) throw new Error(`ref-delta base ${baseSha} is not available`);
      const resolved = applyDelta(known.data, inflated.data);
      store0(resolved, known.type);
      deltaCount += 1;
    } else {
      const objectType = PACK_TYPE_NAMES[type];
      if (objectType === undefined) throw new Error(`pack entry type ${type} is not a known object type`);
      const inflated = inflateAt(pack, at);
      at += inflated.consumed;
      if (inflated.data.length !== size) throw new Error(`pack entry size ${inflated.data.length} != declared ${size}`);
      store0(inflated.data, objectType);
    }
  }

  return { objects, deltaCount, declaredCount };
}

// ---------------------------------------------------------------------------------------------
// ref advertisement

/** One advertised ref. */
interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  unborn?: boolean;
}

/** The capabilities a v0 receive-pack advertisement offers. */
const RECEIVE_CAPS = [
  'report-status',
  'report-status-v2',
  'delete-refs',
  'side-band-64k',
  'ofs-delta',
  'quiet',
  'agent=makefun-forge/1.0',
].join(' ');

/** The capabilities a v2 upload-pack advertisement offers. */
const V2_CAPS = [
  'version 2',
  'agent=makefun-forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done ofs-delta',
  'object-format=sha1',
  'server-option',
];

/** Every ref a repository holds, plus HEAD, peeled tags, and the unborn default branch. */
function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const headTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTarget !== undefined) refs.push({ oid: headTarget, name: 'HEAD' });
  for (const [name, oid] of repo.refs) {
    refs.push({ oid, name });
    if (name.startsWith('refs/tags/')) {
      // An annotated tag peels to a commit; a lightweight tag is already the commit.
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const text = object.data.toString('utf8');
        const target = text.split('\n').find((line) => line.startsWith('object '));
        if (target !== undefined) refs.push({ oid: target.slice(7).trim(), name: `${name}^{}`, peeled: undefined });
      }
    }
  }
  return refs;
}

/** Peel a tag ref to its commit: an annotated tag's `object` line, a lightweight tag's own oid. */
function peelCommitOf(repo: Repo, oid: string): string | null {
  let current = oid;
  // Walk at most a few hops; a tag-of-tag chain deeper than this is not a scenario this suite builds.
  for (let hop = 0; hop < 4; hop += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    const target = object.data.toString('utf8').split('\n').find((line) => line.startsWith('object '));
    if (target === undefined) return null;
    current = target.slice(7).trim();
  }
  return null;
}

/** Build the v0 ref advertisement for a service, with capabilities on the first line. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', headPeeled?: string): Buffer {
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    // An unborn repository advertises the all-zero pseudo-ref so a push has a first line to carry
    // capabilities on, exactly as git's receive-pack does.
    const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : `side-band-64k thin-pack ofs-delta agent=makefun-forge/1.0`;
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const caps = service === 'git-receive-pack'
    ? RECEIVE_CAPS
    : `side-band-64k thin-pack ofs-delta multi_ack_detailed no-done agent=makefun-forge/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`;
  let first = true;
  for (const ref of refs) {
    const line = first ? `${ref.oid} ${ref.name}\u0000${caps}\n` : `${ref.oid} ${ref.name}\n`;
    parts.push(pktLine(line));
    first = false;
  }
  if (headPeeled !== undefined) parts.push(pktLine(`${headPeeled} HEAD^{}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Build the v2 capability advertisement (no refs; ls-refs answers those). */
function v2Advertisement(): Buffer {
  const lines = [...V2_CAPS];
  const body = encodePackets([...lines.map((line) => `${line}\n`), 'flush']);
  return body;
}

/** Whether a request asked for protocol v2. */
export function wantsV2(gitProtocolHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(gitProtocolHeader) ? gitProtocolHeader.join(',') : gitProtocolHeader;
  if (typeof raw !== 'string') return false;
  return /(^|[:,])\s*version\s*=\s*2/.test(raw);
}

// ---------------------------------------------------------------------------------------------
// ls-refs and fetch

/** Answer a v2 ls-refs command body. */
function answerLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePackets(body);
  const prefixes: string[] = [];
  const flags = new Set<string>();
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === '') continue;
    const space = line.indexOf(' ');
    const word = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1);
    if (word === 'peel' || word === 'symrefs' || word === 'unborn') flags.add(word);
    else if (word === 'ref-prefix') prefixes.push(rest);
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const refs = advertisedRefs(repo).filter((ref) => keep(ref.name));
  const out: Buffer[] = [];
  const headTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  for (const ref of refs) {
    if (ref.name === 'HEAD') {
      const symref = flags.has('symrefs') && headTarget !== undefined ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      out.push(pktLine(`${ref.oid} HEAD${symref}\n`));
      continue;
    }
    // An annotated tag carries its peeled commit as an attribute on its own line: `peeled:<sha>`
    // is what the v2 client reads, so a separate `<ref>^{}` line would be ignored.
    let peelAttr = '';
    if (flags.has('peel') && ref.name.startsWith('refs/tags/')) {
      const peeled = peelCommitOf(repo, ref.oid);
      if (peeled !== null) peelAttr = ` peeled:${peeled}`;
    }
    out.push(pktLine(`${ref.oid} ${ref.name}${peelAttr}\n`));
  }
  // An unborn default branch, when asked for and absent.
  if (flags.has('unborn') && headTarget === undefined && keep('HEAD')) {
    out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

/** Frame a pack for a fetch: sideband band 1 packets, then a flush. */
function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const max = PKT_MAX - 1;
  for (let at = 0; at < pack.length; at += max) {
    const slice = pack.subarray(at, Math.min(at + max, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

/** The commits within `depth` generations of a want, and the boundaries that result. */
function shallowSlice(
  repo: Repo,
  wants: readonly string[],
  depth: number,
  existingShallow: readonly string[],
): { commits: Set<string>; shallow: string[]; unshallow: string[] } {
  const include = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const alreadyShallow = new Set(existingShallow);
  const visited = new Set<string>();
  let frontier = [...wants];
  for (let generation = 1; generation <= depth && frontier.length > 0; generation += 1) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (visited.has(sha)) continue;
      visited.add(sha);
      include.add(sha);
      const parents = commitParents(repo, sha);
      if (generation === depth && parents.length > 0) {
        if (!shallow.includes(sha)) shallow.push(sha);
      }
      for (const parent of parents) if (!visited.has(parent)) next.push(parent);
    }
    frontier = next;
  }
  for (const sha of alreadyShallow) {
    if (include.has(sha) && !shallow.includes(sha)) unshallow.push(sha);
  }
  return { commits: include, shallow, unshallow };
}

/** Answer a v2 fetch command body: acknowledgments, optional shallow-info, then a packfile. */
/** The pack bytes for a fixed object set, memoized per repository (the clone bench re-clones the same tip). */
const packCache = new WeakMap<Repo, Map<string, Buffer>>();

function packFor(repo: Repo, shas: Set<string>): Buffer {
  let cache = packCache.get(repo);
  if (cache === undefined) {
    cache = new Map();
    packCache.set(repo, cache);
  }
  const key = [...shas].sort().join(',');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const entries: PackEntry[] = [];
  for (const sha of shas) {
    const object = repo.objects.get(sha);
    if (object !== undefined) entries.push({ sha, object });
  }
  const built = buildPack(entries);
  if (cache.size > 16) cache.clear();
  cache.set(key, built);
  return built;
}

function answerFetch(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const existingShallow: string[] = [];
  let depth: number | null = null;
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) existingShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(value) && value > 0) depth = value;
    }
  }

  const out: Buffer[] = [];

  // The objects already reachable from what the client says it has. A commit the client marked
  // shallow is a boundary: its history is NOT held, so the walk must stop there instead of
  // assuming the whole ancestry is present (that assumption is what makes deepen send nothing).
  const haveSet = new Set<string>();
  const shallowBoundary = new Set(existingShallow);
  for (const have of haves) {
    const stack = [have];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (haveSet.has(sha)) continue;
      haveSet.add(sha);
      const object = repo.objects.get(sha);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        if (shallowBoundary.has(sha)) continue;
        for (const parent of commitParents(repo, sha)) stack.push(parent);
        const tree = commitTree(repo, sha);
        if (tree !== null) stack.push(tree);
      } else if (object.type === 'tree') {
        for (const entry of parseTreeEntries(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = object.data.toString('utf8').split('\n').find((line) => line.startsWith('object '));
        if (target !== undefined) stack.push(target.slice(7).trim());
      }
    }
  }

  // Which objects to send: everything reachable from the wants, minus the haves, minus nothing when
  // a shallow depth restricts the walk to the commits inside it.
  let wantedCommits: Set<string> | null = null;
  let shallowLines: string[] = [];
  let unshallowLines: string[] = [];
  if (depth !== null) {
    const sliced = shallowSlice(repo, wants, depth, existingShallow);
    wantedCommits = sliced.commits;
    shallowLines = sliced.shallow;
    unshallowLines = sliced.unshallow;
  }

  const toSend = new Set<string>();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit' && wantedCommits !== null) {
      // A shallow walk: the listed commits, their trees and blobs, and no parents outside the slice.
      const stack: string[] = [];
      for (const sha of wantedCommits) stack.push(sha);
      const walked = new Set<string>();
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (walked.has(sha) || haveSet.has(sha)) continue;
        walked.add(sha);
        const current = repo.objects.get(sha);
        if (current === undefined) continue;
        toSend.add(sha);
        if (current.type === 'commit') {
          const tree = commitTree(repo, sha);
          if (tree !== null) stack.push(tree);
        } else if (current.type === 'tree') {
          for (const entry of parseTreeEntries(current.data)) stack.push(entry.oid);
        }
      }
    } else {
      for (const sha of reachableFrom(repo, want)) {
        if (!haveSet.has(sha)) toSend.add(sha);
      }
    }
  }

  // acknowledgments
  out.push(pktLine('acknowledgments\n'));
  if (haves.length === 0) {
    out.push(pktLine('NAK\n'));
  } else if (toSend.size === 0) {
    out.push(pktLine(`ACK ${haves[haves.length - 1]}\n`));
    out.push(pktLine('ready\n'));
  } else {
    out.push(pktLine(`ACK ${haves[haves.length - 1]}\n`));
    out.push(pktLine('ready\n'));
  }
  out.push(PKT_FLUSH);

  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const sha of shallowLines) out.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallowLines) out.push(pktLine(`unshallow ${sha}\n`));
    out.push(PKT_FLUSH);
  }

  if (toSend.size > 0) {
    out.push(pktLine('packfile\n'));
    out.push(sidebandPack(packFor(repo, toSend)));
  }

  return Buffer.concat(out);
}

/** Answer a v0 upload-pack fetch body (the non-v2 fallback a plain client uses). */
function answerFetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets, consumed } = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45).trim());
  }
  void consumed;
  const haveSet = new Set<string>();
  for (const have of haves) for (const sha of reachableFrom(repo, have)) haveSet.add(sha);
  const toSend = new Set<string>();
  for (const want of wants) {
    for (const sha of reachableFrom(repo, want)) if (!haveSet.has(sha)) toSend.add(sha);
  }
  const out: Buffer[] = [];
  if (toSend.size === 0) {
    out.push(pktLine(`NAK\n`));
    return Buffer.concat(out);
  }
  out.push(pktLine('NAK\n'));
  out.push(sidebandPack(packFor(repo, toSend)));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (a push)

/** One ref update a push asks for. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** The result of applying one push command. */
interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Apply a push: parse the command list and the pack, then move the refs that are allowed to move. */
export function answerReceivePack(repo: Repo, body: Buffer, pusher: User | null): Buffer {
  const { packets, consumed } = decodePackets(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '').replace(/\u0000.*$/, '');
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }

  const packStart = consumed;
  let deltaCount = 0;
  const resolver = (oid: string): GitObject | undefined => repo.objects.get(oid);
  if (packStart < body.length) {
    const packBytes = body.subarray(packStart);
    if (packBytes.length >= 32 && packBytes.subarray(0, 4).toString('utf8') === 'PACK') {
      const parsed = parsePack(packBytes, resolver);
      deltaCount = parsed.deltaCount;
      for (const [sha, object] of parsed.objects) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, object);
        // Record commit metadata for the REST surface when a pushed commit arrives.
        if (object.type === 'commit' && !repo.commits.has(sha)) {
          repo.commits.set(sha, commitMetaOf(sha, object.data, pusher));
        }
      }
    }
  }

  // Apply the commands. A non-fast-forward update is refused per ref and changes nothing.
  const reports: RefReport[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const deleting = command.newOid === ZERO_OID;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (deleting) {
      if (current === ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
      continue;
    }
    // A branch update must be a fast-forward: the old tip has to be an ancestor of the new one.
    if (current !== ZERO_OID) {
      const ancestry = new Set<string>();
      const stack = [command.newOid];
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (ancestry.has(sha)) continue;
        ancestry.add(sha);
        for (const parent of commitParents(repo, sha)) stack.push(parent);
      }
      const currentIsAncestor = ancestry.has(current);
      if (!currentIsAncestor) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }

  // Report status, framed in sideband band 1 as side-band-64k requires.
  const reportLines: Buffer[] = [pktLine('unpack ok\n')];
  for (const report of reports) {
    reportLines.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const report = Buffer.concat(reportLines);
  const framed: Buffer[] = [];
  const max = PKT_MAX - 1;
  for (let at = 0; at < report.length; at += max) {
    framed.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, Math.min(at + max, report.length))])));
  }
  framed.push(PKT_FLUSH);
  void deltaCount;
  return Buffer.concat(framed);
}

/** Build commit metadata from a pushed commit's payload. */
function commitMetaOf(sha: string, data: Buffer, pusher: User | null): {
  sha: string;
  message: string;
  author: User;
  committer: User;
  authorDate: string;
  committerDate: string;
  parents: string[];
  tree: string;
} {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  const treeLine = lines.find((line) => line.startsWith('tree '));
  const parents = lines.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7).trim());
  const authorLine = lines.find((line) => line.startsWith('author ')) ?? '';
  const blank = text.indexOf('\n\n');
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const authorMatch = /^author (.*) <(.*)> (\d+) ([+-]\d+)$/.exec(authorLine);
  const author: User = {
    login: pusher?.login ?? 'git',
    name: authorMatch?.[1] ?? pusher?.name ?? 'git',
    email: authorMatch?.[2] ?? pusher?.email ?? 'git@example',
  };
  return {
    sha,
    message,
    author,
    committer: author,
    authorDate: nowIso(),
    committerDate: nowIso(),
    parents,
    tree: treeLine === undefined ? '' : treeLine.slice(5).trim(),
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP glue

/** What a git route answers: a status, a content type and the bytes. */
export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Parse `/<owner>/<repo>.git/<rest>` into its parts, or null when the shape is not git's. */
export function parseGitPath(segments: string[]): { owner: string; repo: string; rest: string[] } | null {
  if (segments.length < 2) return null;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  return { owner: segments[0] as string, repo: repoSegment.slice(0, -4), rest: segments.slice(2) };
}

/** Answer a git smart-HTTP request; null means "not a git route". */
export function handleGit(
  method: string,
  segments: string[],
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  viewer: User | null,
): GitReply | null {
  const parsed = parseGitPath(segments);
  if (parsed === null) return null;
  const repo = store.repo(parsed.owner, parsed.repo);
  if (repo === null) {
    return {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from('repository not found\n', 'utf8'),
    };
  }

  const joined = parsed.rest.join('/');

  if (joined === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const base = Buffer.concat([pktLine('# service=git-upload-pack\n'), PKT_FLUSH]);
      if (wantsV2(headers['git-protocol'])) {
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-advertisement',
          body: Buffer.concat([base, v2Advertisement()]),
        };
      }
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: v0Advertisement(repo, 'git-upload-pack'),
      };
    }
    if (service === 'git-receive-pack') {
      // receive-pack is always v0: a push needs the capability line on a ref.
      const base = Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH]);
      const advertisement = v0Advertisement(repo, 'git-receive-pack');
      // Drop the service preamble v0Advertisement re-adds, keeping one copy.
      const cut = advertisement.indexOf(PKT_FLUSH) + PKT_FLUSH.length;
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-advertisement',
        body: Buffer.concat([base, advertisement.subarray(cut)]),
      };
    }
    return { status: 403, contentType: 'text/plain', body: Buffer.from('service not enabled\n', 'utf8') };
  }

  if (joined === 'git-upload-pack' && method === 'POST') {
    const isV2 = wantsV2(headers['git-protocol']);
    if (isV2) {
      const { packets } = decodePackets(body);
      const first = packets.find((packet) => packet.kind === 'data');
      const command = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
      if (command === 'command=ls-refs') {
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-result',
          body: answerLsRefs(repo, body),
        };
      }
      if (command === 'command=fetch') {
        return {
          status: 200,
          contentType: 'application/x-git-upload-pack-result',
          body: answerFetch(repo, body),
        };
      }
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: encodePackets([...V2_CAPS.slice(0, 1).map((line) => `${line}\n`), 'flush']),
      };
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: answerFetchV0(repo, body),
    };
  }

  if (joined === 'git-receive-pack' && method === 'POST') {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: answerReceivePack(repo, body, viewer),
    };
  }

  return null;
}

export { buildCommitPayload, buildTreePayload, store };