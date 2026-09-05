import { deflateSync } from "node:zlib";

/**
 * Character cards, built the way the tools that make them build them.
 *
 * The PNGs here are REAL PNGs — signature, IHDR, IDAT, tEXt, IEND, each with a
 * correct CRC — rather than a byte string shaped to satisfy the parser. A
 * fixture that only the code under test can read proves that the code can read
 * that fixture, which is not the question. These open in an image viewer.
 */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const body = new Uint8Array(type.length + data.length);
  for (let i = 0; i < type.length; i += 1) body[i] = type.charCodeAt(i);
  body.set(data, type.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

function textChunk(keyword: string, value: string) {
  const encoded = new TextEncoder().encode(`${keyword}\0${value}`);
  return chunk("tEXt", encoded);
}

/** A 1x1 opaque pixel, properly deflated, so the file is a valid image. */
function imageChunks() {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1); // width
  view.setUint32(4, 1); // height
  ihdr[8] = 8;          // bit depth
  ihdr[9] = 2;          // colour type: truecolour
  const idat = deflateSync(Buffer.from([0x00, 0x8a, 0x5c, 0xb4]));
  return [chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(idat)), chunk("IEND", new Uint8Array())];
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG card carrying the given chunks.
 *
 * The tEXt chunks go BEFORE IEND and after IHDR, which is where every exporter
 * puts them and where a spec-compliant reader looks.
 */
export function pngCard(chunks: { keyword: string; json: unknown }[]) {
  const [ihdr, idat, iend] = imageChunks();
  return concat([
    signature,
    ihdr,
    ...chunks.map((entry) => textChunk(entry.keyword, Buffer.from(JSON.stringify(entry.json), "utf8").toString("base64"))),
    idat,
    iend,
  ]);
}

/** The original TavernAI shape: no wrapper, no spec field. */
export const v1Card = {
  name: "Wren Calloway",
  description: "A lighthouse keeper on a coast that has not had ships in forty years.",
  personality: "Watchful. Speaks in short sentences. Does not explain herself twice.",
  scenario: "{{user}} has walked up the cliff path in weather nobody sensible walks in.",
  first_mes: "*She does not turn from the glass.* \"You'll have got wet for nothing. There's no boat.\"",
  mes_example: "{{char}}: \"Light's due. Talk while I work or don't talk.\"",
};

/** V2, with everything V2 added, including a character book. */
export const v2Card = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Wren Calloway",
    description: "A lighthouse keeper on a coast that has not had ships in forty years.",
    personality: "Watchful. Speaks in short sentences.",
    scenario: "{{user}} has walked up the cliff path.",
    first_mes: "\"You'll have got wet for nothing.\"",
    mes_example: "{{char}}: \"Light's due.\"",
    creator_notes: "Do not use with the group-chat preset — she talks over everyone.",
    system_prompt: "Write in close third person. Never narrate {{user}}'s thoughts.",
    post_history_instructions: "Keep replies under 200 words.",
    alternate_greetings: ["*The door is already open.* \"Shut it behind you.\""],
    tags: ["Romance", "Slow Burn", "my own category"],
    creator: "someone",
    character_version: "1.4",
    character_book: {
      name: "The Calloway Coast",
      description: "What the coast knows.",
      entries: [
        { keys: ["the wreck", "Mairi"], content: "The Mairi went down in 1981 with all six aboard.", enabled: true, insertion_order: 1, name: "The wreck" },
        { keys: ["fog"], content: "The fog here comes in from the east, which is wrong, and everyone pretends not to notice.", enabled: true, insertion_order: 0 },
        { keys: ["unused"], content: "Cut from an earlier draft.", enabled: false, insertion_order: 2 },
      ],
    },
  },
};

/** V3, including the fields V3 introduced. */
export const v3Card = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    ...v2Card.data,
    nickname: "The Keeper",
    group_only_greetings: ["\"Both of you? The path barely takes one.\""],
    source: ["https://example.com/cards/wren"],
    creation_date: 1_700_000_000,
  },
};

/** A card whose author classified it as explicit, via its own tags. */
export const adultCard = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Vesper Lang",
    description: "A tattoo artist who is not subtle about what she wants.",
    personality: "Blunt, vulgar, sexually forward.",
    scenario: "Six months of appointments that could have taken two.",
    first_mes: "\"You booked three hours for forty minutes of work again.\"",
    mes_example: "{{char}}: \"Sit down.\"",
    tags: ["NSFW", "Explicit", "Romance"],
  },
};
