// Reads only the family names out of a font file, without loading the whole file. No Figma or DOM.
//
// A studio font folder can hold tens of thousands of files. Reading each one in full to find a
// handful of families is slow and holds a lot of memory, so the folder scan used to stop after
// a few hundred files. The family names live in the small 'name' table, which the table
// directory at the start of the file points to. Three small reads per face are enough:
// the header, the table directory and the 'name' table.
//
// `read` returns the bytes in [offset, offset + length) and may return fewer at the end of the
// file. Anything that does not look like a font gives null, and the caller falls back to
// reading the whole file.

const TTCF = 0x74746366 // 'ttcf'
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* 'OTTO' */, 0x74727565 /* 'true' */])
const NAME = 0x6e616d65 // 'name'
const MAX_FACES = 256
const MAX_TABLES = 512
/** Name tables are a few KB; anything far larger is a broken file */
const MAX_NAME_TABLE = 1024 * 1024
/** Family (1), typographic family (16), WWS family (21) and full name (4) */
const FAMILY_IDS = new Set([1, 4, 16, 21])

export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1]
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

function decodeUtf16be(bytes: Uint8Array): string {
  let out = ''
  for (let at = 0; at + 1 < bytes.length; at += 2) out += String.fromCharCode(u16(bytes, at))
  return out
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

/** Family-like names in a 'name' table, deduplicated, in table order */
export function familyNamesFromNameTable(table: Uint8Array): string[] {
  if (table.length < 6) return []
  const count = u16(table, 2)
  const storage = u16(table, 4)
  const names: string[] = []
  for (let i = 0; i < count; i += 1) {
    const record = 6 + i * 12
    if (record + 12 > table.length) break
    const platform = u16(table, record)
    const encoding = u16(table, record + 2)
    const nameId = u16(table, record + 6)
    const length = u16(table, record + 8)
    const offset = u16(table, record + 10)
    if (!FAMILY_IDS.has(nameId)) continue
    const start = storage + offset
    if (start + length > table.length) continue
    const raw = table.subarray(start, start + length)
    let text: string | null = null
    if (platform === 0 || platform === 3) text = decodeUtf16be(raw)
    else if (platform === 1 && encoding === 0) text = decodeLatin1(raw)
    if (text === null) continue
    const trimmed = text.replace(/\0/g, '').trim()
    if (trimmed !== '' && !names.includes(trimmed)) names.push(trimmed)
  }
  return names
}

async function faceNames(
  read: ByteReader,
  base: number,
  known?: Uint8Array
): Promise<string[] | null> {
  const header = known ?? (await read(base, 12))
  if (header.length < 12 || !SFNT_VERSIONS.has(u32(header, 0))) return null
  const tables = u16(header, 4)
  if (tables === 0 || tables > MAX_TABLES) return null
  const directory = await read(base + 12, tables * 16)
  if (directory.length < tables * 16) return null
  for (let i = 0; i < tables; i += 1) {
    const entry = i * 16
    if (u32(directory, entry) !== NAME) continue
    const offset = u32(directory, entry + 8)
    const length = u32(directory, entry + 12)
    if (length === 0 || length > MAX_NAME_TABLE) return null
    const table = await read(offset, length)
    if (table.length < length) return null
    return familyNamesFromNameTable(table)
  }
  return null
}

/**
 * Family names of every face in a font file (TTF, OTF, TTC or OTC).
 * Null when the file is not a font this reader understands; the caller then reads it whole.
 */
export async function readFamilyNames(read: ByteReader): Promise<string[] | null> {
  const head = await read(0, 12)
  if (head.length < 12) return null
  if (u32(head, 0) !== TTCF) return faceNames(read, 0, head)

  const count = u32(head, 8)
  if (count === 0 || count > MAX_FACES) return null
  const offsets = await read(12, count * 4)
  if (offsets.length < count * 4) return null
  const names: string[] = []
  for (let i = 0; i < count; i += 1) {
    const face = await faceNames(read, u32(offsets, i * 4))
    if (face === null) return null
    for (const name of face) if (!names.includes(name)) names.push(name)
  }
  return names
}
