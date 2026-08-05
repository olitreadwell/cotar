import assert from 'node:assert';
import { describe, it } from 'node:test';

import { Source } from '@chunkd/source';
import { SourceMemory } from '@chunkd/source-memory';
import fnv1a from '@sindresorhus/fnv1a';

import { CotarIndex } from '../../binary.index.js';
import { Cotar } from '../../cotar.js';
import { IndexHeaderSize, IndexMagic, IndexSize, IndexV2RecordSize, IndexVersion } from '../../format.js';

function abToChar(buf: ArrayBuffer | null, offset: number): string | null {
  if (buf == null) return null;
  return String.fromCharCode(new Uint8Array(buf)[offset] ?? 0);
}

export function writeHeaderFooter(output: Buffer, count: number, version = IndexVersion): void {
  if (output.length < IndexSize * 2) {
    throw new Error('Buffer is too small for CotarHeader, minimum size: ' + IndexSize * 2);
  }
  // Write the header at the start of the buffer
  output.write(IndexMagic, 0);
  output.writeUInt8(version, 3);
  output.writeUInt32LE(count, 4);

  // Write the header at the end of the buffer
  output.write(IndexMagic, output.length - 8);
  output.writeUInt8(version, output.length - 5);
  output.writeUInt32LE(count, output.length - 4);
}

const ExpectedRecordV2 =
  'Q09UAgQAAAB0wPmDP22WfQIAAAAIAAAAAAAAAAAAAAAAAAAAAAAAACZjB1u0iLSnAAAAAAEAAAC/I5YiYFMqNwEAAAAEAAAAQ09UAgQAAAA=';

describe('CotarBinary.fake', () => {
  const TestFiles = [
    { path: 'tiles/0/0/0.pbf.gz', offset: 0, size: 1 },
    { path: 'tiles/1/1/1.pbf.gz', offset: 512, size: 4 },
    { path: 'tiles/1/1/2.pbf.gz', offset: 1024, size: 8 },
  ];
  const TestFileSize = TestFiles.length + 1;

  const tarIndexV2: Buffer = Buffer.alloc(TestFileSize * IndexV2RecordSize + IndexHeaderSize * 2);

  for (const record of TestFiles) {
    const hash = fnv1a(record.path, { size: 64 });
    const index = Number(hash % BigInt(TestFileSize));

    const offsetV2 = index * IndexV2RecordSize + IndexHeaderSize;
    tarIndexV2.writeBigUInt64LE(hash, offsetV2);
    tarIndexV2.writeUInt32LE(record.offset / 512, offsetV2 + 8);
    tarIndexV2.writeUInt32LE(record.size, offsetV2 + 12);
  }
  writeHeaderFooter(tarIndexV2, TestFileSize, 2);

  it('should load a tile from fake v2 index', async () => {
    assert.equal(tarIndexV2.toString('base64'), ExpectedRecordV2);

    const cotar = new Cotar(
      new SourceMemory('memory://tar', Buffer.from('0123456789')),
      await CotarIndex.create(new SourceMemory('memory://index', tarIndexV2)),
    );

    assert.deepEqual(await cotar.index.find('tiles/0/0/0.pbf.gz'), { offset: 0, size: 1 });
    assert.deepEqual(await cotar.index.find('tiles/1/1/1.pbf.gz'), { offset: 512, size: 4 });
    assert.deepEqual(await cotar.index.find('tiles/1/1/2.pbf.gz'), { offset: 1024, size: 8 });
    assert.equal(await cotar.index.find('tiles/1/1/3.pbf.gz'), null);

    const tile0 = await cotar.get('tiles/0/0/0.pbf.gz');
    assert.notEqual(tile0, null);
    assert.equal(abToChar(tile0, 0), '0');
  });

  it('should load v2 from a combined tar & header', async () => {
    const tar = Buffer.concat([Buffer.from('0123456789'), tarIndexV2]);
    const source = new SourceMemory('memory://combined', tar);
    const cotar = await Cotar.fromTar(source);
    // assert.equal(cotar.index.sourceOffset, 10);
    assert.deepEqual(cotar.index.metadata, { magic: 'COT', version: 2, count: 4 });

    assert.deepEqual(await cotar.index.find('tiles/0/0/0.pbf.gz'), { offset: 0, size: 1 });
    assert.deepEqual(await cotar.index.find('tiles/1/1/1.pbf.gz'), { offset: 512, size: 4 });
    assert.deepEqual(await cotar.index.find('tiles/1/1/2.pbf.gz'), { offset: 1024, size: 8 });
    assert.equal(await cotar.index.find('tiles/1/1/3.pbf.gz'), null);

    const tile0 = await cotar.get('tiles/0/0/0.pbf.gz');
    assert.notEqual(tile0, null);
    assert.equal(abToChar(tile0, 0), '0');
  });
});

/** Wrap a source and count how many times it is read from. */
class CountingSource implements Source {
  type = 'counting';
  url = new URL('memory://counting');
  fetchCount = 0;
  inner: Source;
  constructor(inner: Source) {
    this.inner = inner;
  }
  head(): ReturnType<Source['head']> {
    return this.inner.head();
  }
  fetch(offset: number, length?: number): Promise<ArrayBuffer> {
    this.fetchCount++;
    return this.inner.fetch(offset, length);
  }
}

describe('CotarBinary.find requests', () => {
  const SlotCount = 64;

  /** Build an index where `path` sits `probe` slots after its home slot. */
  function craftIndex(path: string, probe: number): { buffer: Buffer; offset: number; size: number } {
    const buffer = Buffer.alloc(SlotCount * IndexV2RecordSize + IndexHeaderSize * 2);
    const home = Number(fnv1a(path, { size: 64 }) % BigInt(SlotCount));

    // Fill the slots between the home slot and the file with other (non-empty)
    // records so a lookup has to probe past them to reach the file.
    for (let i = 0; i < probe; i++) {
      const slot = home + i;
      const at = slot * IndexV2RecordSize + IndexHeaderSize;
      buffer.writeBigUInt64LE(BigInt(slot + 1), at); // any non-zero, non-matching hash
    }

    const fileOffset = 512 * 3;
    const fileSize = 42;
    const at = (home + probe) * IndexV2RecordSize + IndexHeaderSize;
    buffer.writeBigUInt64LE(fnv1a(path, { size: 64 }), at);
    buffer.writeUInt32LE(fileOffset / 512, at + 8);
    buffer.writeUInt32LE(fileSize, at + 12);

    writeHeaderFooter(buffer, SlotCount);
    return { buffer, offset: fileOffset, size: fileSize };
  }

  // Pick a path whose home slot leaves room for the probe run without wrapping.
  const probe = 3;
  let path = '';
  for (let i = 0; ; i++) {
    const candidate = 'probe/' + i;
    const home = Number(fnv1a(candidate, { size: 64 }) % BigInt(SlotCount));
    if (home + probe < SlotCount) {
      path = candidate;
      break;
    }
  }

  it('reads a probe run in a single request', async () => {
    const crafted = craftIndex(path, probe);
    const source = new CountingSource(new SourceMemory('memory://index', crafted.buffer));
    const index = await CotarIndex.create(source);

    // Only count the reads done by find(), not the header read done by create().
    source.fetchCount = 0;
    const record = await index.find(path);

    assert.deepEqual(record, { offset: crafted.offset, size: crafted.size });
    // The file is `probe` slots past its home slot, so the old code would read
    // once per slot. Batching the probe run reads it all in one request.
    assert.equal(source.fetchCount, 1);
  });

  it('still returns null for a missing file', async () => {
    const crafted = craftIndex(path, probe);
    const source = new CountingSource(new SourceMemory('memory://index', crafted.buffer));
    const index = await CotarIndex.create(source);

    assert.equal(await index.find('does/not/exist'), null);
  });

  it('finds a file whose probe run wraps past the end of the table', async () => {
    // Pick a path whose home slot is the last slot, so its record has to be
    // placed at slot 0 and a lookup wraps around the end of the table.
    let wrapPath = '';
    for (let i = 0; ; i++) {
      const candidate = 'wrap/' + i;
      if (Number(fnv1a(candidate, { size: 64 }) % BigInt(SlotCount)) === SlotCount - 1) {
        wrapPath = candidate;
        break;
      }
    }

    const buffer = Buffer.alloc(SlotCount * IndexV2RecordSize + IndexHeaderSize * 2);
    // Occupy the home (last) slot so the file spills over to slot 0.
    const homeAt = (SlotCount - 1) * IndexV2RecordSize + IndexHeaderSize;
    buffer.writeBigUInt64LE(BigInt(1), homeAt);
    // Place the file at slot 0.
    buffer.writeBigUInt64LE(fnv1a(wrapPath, { size: 64 }), IndexHeaderSize);
    buffer.writeUInt32LE(9, IndexHeaderSize + 8);
    buffer.writeUInt32LE(7, IndexHeaderSize + 12);
    writeHeaderFooter(buffer, SlotCount);

    const index = await CotarIndex.create(new SourceMemory('memory://index', buffer));
    assert.deepEqual(await index.find(wrapPath), { offset: 9 * 512, size: 7 });
  });
});
