import { describe, expect, it } from 'vitest'
import { familyNamesFromNameTable, readFamilyNames } from '../src/lib/fontNames'

type NameRecord = { platform: number; encoding: number; nameId: number; text: string }

function nameTable(records: NameRecord[]): Uint8Array {
  const strings = records.map((record) =>
    record.platform === 1
      ? Uint8Array.from([...record.text].map((c) => c.charCodeAt(0)))
      : Uint8Array.from(
          [...record.text].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])
        )
  )
  const storage = 6 + records.length * 12
  const size = storage + strings.reduce((sum, s) => sum + s.length, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint16(2, records.length)
  view.setUint16(4, storage)
  let offset = 0
  records.forEach((record, i) => {
    const at = 6 + i * 12
    view.setUint16(at, record.platform)
    view.setUint16(at + 2, record.encoding)
    view.setUint16(at + 6, record.nameId)
    view.setUint16(at + 8, strings[i].length)
    view.setUint16(at + 10, offset)
    out.set(strings[i], storage + offset)
    offset += strings[i].length
  })
  return out
}

/** A minimal SFNT: header, a directory with a dummy table and 'name', then the tables */
function sfnt(table: Uint8Array, base = 0): { face: Uint8Array; nameOffset: number } {
  const directory = 12 + 2 * 16
  const face = new Uint8Array(directory)
  const view = new DataView(face.buffer)
  view.setUint32(0, 0x00010000)
  view.setUint16(4, 2)
  // dummy 'head'
  view.setUint32(12, 0x68656164)
  // 'name' entry: offset filled by the caller
  view.setUint32(28, 0x6e616d65)
  view.setUint32(28 + 12, table.length)
  return { face, nameOffset: base + 28 + 8 }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function reader(bytes: Uint8Array) {
  let reads = 0
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    reads += 1
    return bytes.slice(offset, offset + length)
  }
  return { read, reads: () => reads }
}

const dazzed = nameTable([
  { platform: 3, encoding: 1, nameId: 1, text: 'Dazzed Medium' },
  { platform: 3, encoding: 1, nameId: 16, text: 'Dazzed' },
  { platform: 3, encoding: 1, nameId: 2, text: 'Regular' },
  { platform: 1, encoding: 0, nameId: 1, text: 'Dazzed Medium' }
])

describe('familyNamesFromNameTable', () => {
  it('reads family, typographic family and Mac names, without duplicates or styles', () => {
    expect(familyNamesFromNameTable(dazzed)).toEqual(['Dazzed Medium', 'Dazzed'])
  })

  it('ignores records that point outside the table', () => {
    const broken = dazzed.slice(0, dazzed.length - 4)
    expect(familyNamesFromNameTable(broken)).not.toContain('Dazzed Medium'.repeat(2))
  })
})

describe('readFamilyNames', () => {
  it('reads a single font with three small reads', async () => {
    const { face, nameOffset } = sfnt(dazzed)
    const file = concat([face, dazzed])
    new DataView(file.buffer).setUint32(nameOffset, face.length)
    const { read, reads } = reader(file)
    expect(await readFamilyNames(read)).toEqual(['Dazzed Medium', 'Dazzed'])
    expect(reads()).toBe(3)
  })

  it('reads every face of a collection', async () => {
    const nuckle = nameTable([{ platform: 3, encoding: 1, nameId: 1, text: 'Nuckle' }])
    const header = new Uint8Array(12 + 2 * 4)
    const hv = new DataView(header.buffer)
    hv.setUint32(0, 0x74746366)
    hv.setUint32(8, 2)
    const first = sfnt(dazzed, header.length)
    const secondBase = header.length + first.face.length
    const second = sfnt(nuckle, secondBase)
    hv.setUint32(12, header.length)
    hv.setUint32(16, secondBase)
    const file = concat([header, first.face, second.face, dazzed, nuckle])
    const view = new DataView(file.buffer)
    view.setUint32(first.nameOffset, secondBase + second.face.length)
    view.setUint32(second.nameOffset, secondBase + second.face.length + dazzed.length)
    expect(await readFamilyNames(reader(file).read)).toEqual(['Dazzed Medium', 'Dazzed', 'Nuckle'])
  })

  it('gives null for files that are not fonts', async () => {
    expect(await readFamilyNames(reader(new TextEncoder().encode('not a font at all')).read)).toBe(
      null
    )
    expect(await readFamilyNames(reader(new Uint8Array(4)).read)).toBe(null)
  })
})
