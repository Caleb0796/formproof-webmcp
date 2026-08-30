import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';

import type {
  XfaSemanticsResult,
  XfaSemanticsUnavailableReason,
} from '../lib/xfa-semantics';

const { extractXfaSemantics } = (await import(
  new URL('../lib/xfa-semantics.ts', import.meta.url).href
)) as typeof import('../lib/xfa-semantics');

const XFA_NAMESPACE = 'http://www.xfa.org/schema/xfa-template/3.3/';

class DeflateBitWriter {
  readonly bytes: number[] = [];
  current = 0;
  bitCount = 0;

  write(value: number, bitCount: number): void {
    for (let index = 0; index < bitCount; index += 1) {
      this.current |= ((value >>> index) & 1) << this.bitCount;
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.bitCount = 0;
      }
    }
  }

  alignToByte(): void {
    if (this.bitCount === 0) return;
    this.bytes.push(this.current);
    this.current = 0;
    this.bitCount = 0;
  }

  writeBytes(bytes: Uint8Array): void {
    assert.equal(this.bitCount, 0);
    this.bytes.push(...bytes);
  }

  finish(): Uint8Array {
    this.alignToByte();
    return Uint8Array.from(this.bytes);
  }
}

function reverseBits(value: number, width: number): number {
  let reversed = 0;
  for (let index = 0; index < width; index += 1) {
    reversed = (reversed << 1) | ((value >>> index) & 1);
  }
  return reversed;
}

function fixedHuffmanCode(symbol: number): readonly [number, number] {
  if (symbol <= 143) return [0x30 + symbol, 8];
  if (symbol <= 255) return [0x190 + symbol - 144, 9];
  if (symbol <= 279) return [symbol - 256, 7];
  return [0xc0 + symbol - 280, 8];
}

function writeFixedHuffmanSymbol(
  writer: DeflateBitWriter,
  symbol: number,
): void {
  const [code, width] = fixedHuffmanCode(symbol);
  writer.write(reverseBits(code, width), width);
}

function repeatedAAdler32(length: number): number {
  const modulus = BigInt(65_521);
  const count = BigInt(length);
  const one = BigInt(1);
  const byte = BigInt(65);
  const a = (one + byte * count) % modulus;
  const b = (count + (byte * count * (count + one)) / BigInt(2)) % modulus;
  return Number((b << BigInt(16)) | a) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStream(raw: Uint8Array, checksum: number): Uint8Array {
  const bytes = new Uint8Array(2 + raw.length + 4);
  bytes[0] = 0x78;
  bytes[1] = 0x01;
  bytes.set(raw, 2);
  const checksumOffset = bytes.length - 4;
  bytes[checksumOffset] = checksum >>> 24;
  bytes[checksumOffset + 1] = checksum >>> 16;
  bytes[checksumOffset + 2] = checksum >>> 8;
  bytes[checksumOffset + 3] = checksum;
  return bytes;
}

function bytesFromHex(hex: string): Uint8Array {
  assert.equal(hex.length % 2, 0);
  return Uint8Array.from(
    hex.match(/../gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function fixedHuffmanBomb(repetitions: number): Uint8Array {
  const writer = new DeflateBitWriter();
  writer.write(1, 1);
  writer.write(1, 2);
  writeFixedHuffmanSymbol(writer, 65);
  for (let index = 0; index < repetitions; index += 1) {
    writeFixedHuffmanSymbol(writer, 285);
    writer.write(0, 5);
  }
  writeFixedHuffmanSymbol(writer, 256);

  return zlibStream(writer.finish(), repeatedAAdler32(1 + 258 * repetitions));
}

function fixedThenStored(contents: Uint8Array): Uint8Array {
  assert.ok(contents.length <= 0xffff);
  const writer = new DeflateBitWriter();
  writer.write(0, 1);
  writer.write(1, 2);
  writeFixedHuffmanSymbol(writer, 256);
  writer.write(1, 1);
  writer.write(0, 2);
  writer.alignToByte();
  const length = contents.length;
  const complement = ~length & 0xffff;
  writer.writeBytes(
    Uint8Array.of(
      length,
      length >>> 8,
      complement,
      complement >>> 8,
      ...contents,
    ),
  );
  return zlibStream(writer.finish(), adler32(contents));
}

interface Packet {
  readonly name: string;
  readonly contents?: string | Uint8Array;
  readonly compressed?: boolean;
  readonly stream?: PDFRawStream;
}

async function documentWithPackets(
  packets: readonly Packet[],
): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  const xfa = PDFArray.withContext(document.context);
  for (const packet of packets) {
    const stream =
      packet.stream ??
      (packet.compressed === false
        ? document.context.stream(packet.contents ?? '')
        : document.context.flateStream(packet.contents ?? ''));
    xfa.push(PDFString.of(packet.name));
    xfa.push(document.context.register(stream));
  }
  document.getForm().acroForm.dict.set(PDFName.of('XFA'), xfa);
  return document;
}

async function documentWithTemplate(
  xml: string | Uint8Array,
): Promise<PDFDocument> {
  return documentWithPackets([{ name: 'template', contents: xml }]);
}

async function documentWithFilteredTemplate(
  contents: Uint8Array,
  filterNames: readonly string[],
  filterAsArray: boolean,
  decodeParameters = false,
): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  let filter: PDFName | PDFArray;
  if (filterAsArray) {
    filter = PDFArray.withContext(document.context);
    for (const name of filterNames) filter.push(PDFName.of(name));
  } else {
    filter = PDFName.of(filterNames[0]);
  }
  const stream = document.context.stream(
    contents,
    decodeParameters
      ? {
          Filter: filter,
          DecodeParms: document.context.obj({ Predictor: 12 }),
        }
      : { Filter: filter },
  );
  const xfa = PDFArray.withContext(document.context);
  xfa.push(PDFString.of('template'));
  xfa.push(document.context.register(stream));
  document.getForm().acroForm.dict.set(PDFName.of('XFA'), xfa);
  return document;
}

function assertUnavailable(
  result: XfaSemanticsResult,
  reason: XfaSemanticsUnavailableReason,
): void {
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, reason);
  assert.equal(result.byExactSomName.size, 0);
  assert.equal(result.humanOnlyExactSomNames.size, 0);
  assert.equal(result.readOnlyExactSomNames.size, 0);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.duplicateCount, 0);
}

void test('extracts exact occurrence-aware SOM semantics', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}" xmlns:h="http://www.w3.org/1999/xhtml">
      <subform name="Root">
        <subform name="Header">
          <field name="Applicant">
            <assist><speak> Applicant   legal name </speak></assist>
          </field>
        </subform>
        <area>
          <subform>
            <field name="Amount">
              <assist>
                <speak priority="toolTip"/>
                <toolTip>First row amount</toolTip>
              </assist>
              <caption><value><text>Amount one</text></value></caption>
            </field>
          </subform>
        </area>
        <area>
          <subform>
            <field name="Amount">
              <assist><speak>Second row amount</speak></assist>
            </field>
          </subform>
        </area>
        <exclGroup name="Choice">
          <assist><speak>Choose one option</speak></assist>
          <field name="Yes"><assist><speak>Must not map</speak></assist></field>
          <field name="No"/>
        </exclGroup>
        <field name="Tail"/>
        <h:field name="Foreign"/>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
  assert.equal(result.candidateCount, 5);
  assert.equal(result.duplicateCount, 0);
  assert.deepEqual(
    [...result.byExactSomName.keys()],
    [
      'Root[0].Header[0].Applicant[0]',
      'Root[0].#subform[1].Amount[0]',
      'Root[0].#subform[2].Amount[1]',
      'Root[0].Choice[0]',
      'Root[0].Tail[0]',
    ],
  );
  assert.deepEqual(
    result.byExactSomName.get('Root[0].Header[0].Applicant[0]'),
    { speak: 'Applicant legal name', caption: null },
  );
  assert.deepEqual(result.byExactSomName.get('Root[0].#subform[1].Amount[0]'), {
    speak: 'First row amount',
    caption: 'Amount one',
  });
  assert.deepEqual(result.byExactSomName.get('Root[0].Choice[0]'), {
    speak: 'Choose one option',
    caption: null,
  });
  assert.equal(result.byExactSomName.has('Amount[0]'), false);
  assert.equal(result.byExactSomName.has('Root[0].Choice[0].Yes[0]'), false);
  assert.equal(result.byExactSomName.has('Foreign[0]'), false);
});

void test('keeps nameless exclGroup transparent and named exclGroup terminal', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <exclGroup>
          <field name="F"><assist><speak>First field</speak></assist></field>
        </exclGroup>
        <field name="F"><assist><speak>Second field</speak></assist></field>
        <exclGroup name="Choice">
          <field name="G"><assist><speak>Hidden field</speak></assist></field>
        </exclGroup>
        <field name="G"><assist><speak>Direct field</speak></assist></field>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.byExactSomName.entries()],
    [
      ['Root[0].F[0]', { speak: 'First field', caption: null }],
      ['Root[0].F[1]', { speak: 'Second field', caption: null }],
      ['Root[0].Choice[0]', { speak: null, caption: null }],
      ['Root[0].G[0]', { speak: 'Direct field', caption: null }],
    ],
  );
});

void test('escapes literal dots inside a legal exact SOM segment', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <field name="My.child">
        <assist><speak>Dotted field</speak></assist>
      </field>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual([...result.byExactSomName.keys()], ['My\\.child[0]']);
  assert.deepEqual(result.byExactSomName.get('My\\.child[0]'), {
    speak: 'Dotted field',
    caption: null,
  });
  assert.equal(result.byExactSomName.has('My.child[0]'), false);
});

void test('rejects explicit names containing injected SOM control syntax', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <field name="Safe"><assist><speak>Safe field</speak></assist></field>
      <field name="A[0].B"><assist><speak>Injected field</speak></assist></field>
    </template>
  `);

  assertUnavailable(extractXfaSemantics(document), 'template_invalid_som_name');
});

void test('rejects invalid explicit names instead of retaining partial semantics', async () => {
  for (const invalidName of ['A:B', '1Leading', 'A\\B', '']) {
    const document = await documentWithTemplate(`
      <template xmlns="${XFA_NAMESPACE}">
        <field name="Safe"><assist><speak>Safe field</speak></assist></field>
        <subform name="${invalidName}"><field name="Child"/></subform>
      </template>
    `);

    assertUnavailable(
      extractXfaSemantics(document),
      'template_invalid_som_name',
    );
  }
});

void test('does not treat the template display name as a SOM path segment', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}" name="Human readable form 2026">
      <field name="Field"><assist><speak>Visible field</speak></assist></field>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual([...result.byExactSomName.keys()], ['Field[0]']);
});

void test('accepts only the verified XFA template 3.3 and 3.6 namespaces', async () => {
  const version36 = await documentWithTemplate(`
    <template xmlns="http://www.xfa.org/schema/xfa-template/3.6/">
      <field name="Field"/>
    </template>
  `);
  assert.equal(extractXfaSemantics(version36).status, 'available');

  const unverifiedVersion = await documentWithTemplate(`
    <template xmlns="http://www.xfa.org/schema/xfa-template/3.4/">
      <field name="Field"/>
    </template>
  `);
  assertUnavailable(
    extractXfaSemantics(unverifiedVersion),
    'template_namespace_unsupported',
  );
});

void test('excludes proto and page layout branches from exact SOM semantics', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <proto>
          <field name="F"><assist><speak>Prototype field</speak></assist></field>
        </proto>
        <pageSet name="Pages">
          <pageArea name="Page">
            <field name="PageField"><assist><speak>Page field</speak></assist></field>
          </pageArea>
        </pageSet>
        <field name="F"><assist><speak>Direct field</speak></assist></field>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.equal(result.candidateCount, 1);
  assert.deepEqual(
    [...result.byExactSomName.entries()],
    [['Root[0].F[0]', { speak: 'Direct field', caption: null }]],
  );
});

void test('rejects prototype inheritance that can change exact SOM occurrences', async () => {
  for (const reference of ['use="#repeatField"', 'usehref="#repeatField"']) {
    const document = await documentWithTemplate(`
      <template xmlns="${XFA_NAMESPACE}">
        <subform name="Root">
          <proto>
            <field id="repeatField">
              <occur initial="2" min="2" max="2"/>
            </field>
          </proto>
          <field name="F" ${reference}>
            <assist><speak>Repeated field</speak></assist>
          </field>
          <field name="F"><assist><speak>Distinct field</speak></assist></field>
        </subform>
      </template>
    `);

    assertUnavailable(
      extractXfaSemantics(document),
      'template_structure_unsupported',
    );
  }
});

void test('does not treat a foreign-namespaced use attribute as XFA inheritance', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}" xmlns:foreign="urn:foreign">
      <field name="F" foreign:use="#not-xfa">
        <assist><speak>Direct field</speak></assist>
      </field>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(result.byExactSomName.get('F[0]'), {
    speak: 'Direct field',
    caption: null,
  });
});

void test('counts named page layout siblings before ignoring their subtrees', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <pageSet name="F"/>
        <field name="F"><assist><speak>Field F</speak></assist></field>
        <pageArea name="G"/>
        <field name="G"><assist><speak>Field G</speak></assist></field>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.byExactSomName.keys()],
    ['Root[0].F[1]', 'Root[0].G[1]'],
  );
});

void test('does not treat foreign or property wrappers as transparent SOM containers', async () => {
  const wrappers = [
    '<e:wrapper xmlns:e="urn:evil"><field name="F"><assist><speak>Injected field</speak></assist></field></e:wrapper>',
    '<extras><field name="F"><assist><speak>Injected field</speak></assist></field></extras>',
  ];

  for (const wrapper of wrappers) {
    const document = await documentWithTemplate(`
      <template xmlns="${XFA_NAMESPACE}">
        ${wrapper}
        <field name="F"><assist><speak>Direct field</speak></assist></field>
      </template>
    `);
    const result = extractXfaSemantics(document);

    assert.equal(result.status, 'available');
    assert.deepEqual(
      [...result.byExactSomName.entries()],
      [['F[0]', { speak: 'Direct field', caption: null }]],
    );
  }
});

void test('counts named draw siblings in exact SOM occurrences', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <draw name="F"><value><text>Boilerplate</text></value></draw>
        <field name="F"><assist><speak>Direct field</speak></assist></field>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.byExactSomName.entries()],
    [['Root[0].F[1]', { speak: 'Direct field', caption: null }]],
  );
});

void test('counts named exObject siblings in exact SOM occurrences', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <exObject name="F"/>
        <field name="F"><assist><speak>Direct field</speak></assist></field>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.byExactSomName.entries()],
    [['Root[0].F[1]', { speak: 'Direct field', caption: null }]],
  );
});

void test('counts named event siblings in exact SOM occurrences', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <event name="F"/>
        <field name="F"><assist><speak>Direct field</speak></assist></field>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.byExactSomName.entries()],
    [['Root[0].F[1]', { speak: 'Direct field', caption: null }]],
  );
});

void test('rejects unmodeled named XFA siblings instead of guessing occurrences', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <unmodeled name="F"/>
        <field name="F"><assist><speak>Direct field</speak></assist></field>
      </subform>
    </template>
  `);

  assertUnavailable(
    extractXfaSemantics(document),
    'template_structure_unsupported',
  );
});

void test('rejects unsupported subformSet structure instead of flattening paths', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <subformSet name="Set">
          <subform name="Child"><field name="Field"/></subform>
        </subformSet>
      </subform>
    </template>
  `);

  assertUnavailable(
    extractXfaSemantics(document),
    'template_structure_unsupported',
  );
});

void test('counts direct named variables as sibling SOM occurrences', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <variables><script name="Field">ignored</script></variables>
        <field name="Field"><assist><speak>Direct field</speak></assist></field>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.byExactSomName.entries()],
    [['Root[0].Field[1]', { speak: 'Direct field', caption: null }]],
  );
});

void test('rejects candidate occurrence ranges that are not exactly one', async () => {
  const templates = [
    '<field name="Field"><occur initial="2"/></field>',
    '<subform name="Group"><occur max="2"/><field name="Field"/></subform>',
    '<exclGroup name="Choice"><occur min="2"/></exclGroup>',
    '<field name="Unbounded"><occur max="-1"/></field>',
    '<field name="F"><occur initial="0" min="0" max="1"/></field><field name="F"/>',
    '<field name="F"><occur min="0"/></field><field name="F"/>',
    '<field name="F"><occur max="0"/></field><field name="F"/>',
    '<subform name="Root"><subform name="Group"><occur initial="0" min="0" max="1"/><field name="F"><assist><speak>Absent first group</speak></assist></field></subform><subform name="Group"><field name="F"><assist><speak>Present second group</speak></assist></field></subform></subform>',
  ];

  for (const body of templates) {
    const document = await documentWithTemplate(
      `<template xmlns="${XFA_NAMESPACE}">${body}</template>`,
    );
    assertUnavailable(
      extractXfaSemantics(document),
      'template_occurrence_unsupported',
    );
  }

  const exactlyOne = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <field name="Field"><occur initial="1" min="1" max="1"/></field>
    </template>
  `);
  assert.equal(extractXfaSemantics(exactlyOne).status, 'available');
});

void test('accepts only direct semantic text and rejects nested or exData content', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}" xmlns:h="http://www.w3.org/1999/xhtml">
      <field name="Direct">
        <assist><speak>Direct speak</speak><toolTip>Direct tip</toolTip></assist>
        <caption><value><text>Direct caption</text></value></caption>
      </field>
      <field name="NestedSpeak">
        <assist><speak>Pay <h:strong>nothing</h:strong> now</speak></assist>
      </field>
      <field name="RichCaption">
        <caption><value><exData><h:p>Foreign caption</h:p></exData></value></caption>
      </field>
      <field name="NestedCaption">
        <caption><value><text>Before <h:span>not</h:span> after</text></value></caption>
      </field>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(result.byExactSomName.get('Direct[0]'), {
    speak: 'Direct speak',
    caption: 'Direct caption',
  });
  assert.deepEqual(result.byExactSomName.get('NestedSpeak[0]'), {
    speak: null,
    caption: null,
  });
  assert.deepEqual(result.byExactSomName.get('RichCaption[0]'), {
    speak: null,
    caption: null,
  });
  assert.deepEqual(result.byExactSomName.get('NestedCaption[0]'), {
    speak: null,
    caption: null,
  });
});

void test('resolves effective speak prompts from disable and priority', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <field name="Default">
        <assist><speak>Default custom prompt</speak></assist>
      </field>
      <field name="Custom">
        <assist><speak priority="custom">Explicit custom prompt</speak></assist>
      </field>
      <field name="Caption">
        <assist><speak priority="caption">Wrong custom prompt</speak></assist>
        <caption><value><text>Caption prompt</text></value></caption>
      </field>
      <field name="Name">
        <assist><speak priority="name">Wrong custom prompt</speak></assist>
        <caption><value><text>Wrong caption prompt</text></value></caption>
      </field>
      <field name="ToolTip">
        <assist>
          <speak priority="toolTip">Wrong custom prompt</speak>
          <toolTip>Tooltip prompt</toolTip>
        </assist>
      </field>
      <field name="Disabled">
        <assist>
          <speak disable="1" priority="toolTip">Disabled custom prompt</speak>
          <toolTip>Disabled tooltip prompt</toolTip>
        </assist>
      </field>
      <field name="InvalidDisable">
        <assist><speak disable="true">Untrusted custom prompt</speak></assist>
      </field>
      <field name="CaptionFallback">
        <assist><speak priority="caption">Caption fallback custom</speak></assist>
      </field>
      <field name="ToolTipFallback">
        <assist><speak priority="toolTip">Tooltip fallback custom</speak></assist>
      </field>
      <field name="CustomFallback">
        <assist>
          <speak priority="custom"/>
          <toolTip>Custom fallback tooltip</toolTip>
        </assist>
      </field>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.equal(
    result.byExactSomName.get('Default[0]')?.speak,
    'Default custom prompt',
  );
  assert.equal(
    result.byExactSomName.get('Custom[0]')?.speak,
    'Explicit custom prompt',
  );
  assert.equal(
    result.byExactSomName.get('Caption[0]')?.speak,
    'Caption prompt',
  );
  assert.equal(result.byExactSomName.get('Name[0]')?.speak, null);
  assert.equal(result.byExactSomName.get('Name[0]')?.caption, null);
  assert.equal(
    result.byExactSomName.get('ToolTip[0]')?.speak,
    'Tooltip prompt',
  );
  assert.equal(result.byExactSomName.get('Disabled[0]')?.speak, null);
  assert.equal(
    result.byExactSomName.get('Disabled[0]')?.discoverySpeak,
    undefined,
  );
  assert.equal(result.byExactSomName.get('InvalidDisable[0]')?.speak, null);
  assert.equal(
    result.byExactSomName.get('InvalidDisable[0]')?.discoverySpeak,
    undefined,
  );
  assert.equal(
    result.byExactSomName.get('CaptionFallback[0]')?.speak,
    'Caption fallback custom',
  );
  assert.equal(
    result.byExactSomName.get('ToolTipFallback[0]')?.speak,
    'Tooltip fallback custom',
  );
  assert.equal(
    result.byExactSomName.get('CustomFallback[0]')?.speak,
    'Custom fallback tooltip',
  );
});

void test('accepts only bounded direct disabled custom speak as discovery text', async () => {
  const boundaryText = 'A'.repeat(180);
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}" xmlns:h="http://www.w3.org/1999/xhtml">
      <field name="DefaultPriority">
        <assist><speak disable="1"> First name   and middle initial </speak></assist>
      </field>
      <field name="CustomPriority">
        <assist><speak disable="1" priority="custom">Employer identification number</speak></assist>
      </field>
      <field name="Boundary">
        <assist><speak disable="1">${boundaryText}</speak></assist>
      </field>
      <field name="CaptionPriority">
        <assist><speak disable="1" priority="caption">Caption-derived hint</speak></assist>
      </field>
      <field name="NamePriority">
        <assist><speak disable="1" priority="name">Name-derived hint</speak></assist>
      </field>
      <field name="ToolTipPriority">
        <assist><speak disable="1" priority="toolTip">Tooltip-derived hint</speak></assist>
      </field>
      <field name="UnknownPriority">
        <assist><speak disable="1" priority="future">Unknown-priority hint</speak></assist>
      </field>
      <field name="EnabledByDefault">
        <assist><speak>Visible prompt</speak></assist>
      </field>
      <field name="ExplicitlyEnabled">
        <assist><speak disable="0">Visible prompt</speak></assist>
      </field>
      <field name="UnknownDisable">
        <assist><speak disable="true">Untrusted hidden prompt</speak></assist>
      </field>
      <field name="Nested">
        <assist><speak disable="1">Pay <h:strong>nothing</h:strong> now</speak></assist>
      </field>
      <field name="TooLong">
        <assist><speak disable="1">${'B'.repeat(181)}</speak></assist>
      </field>
      <field name="PunctuationOnly">
        <assist><speak disable="1">--- ... !!!</speak></assist>
      </field>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(result.byExactSomName.get('DefaultPriority[0]'), {
    speak: null,
    caption: null,
    discoverySpeak: 'First name and middle initial',
  });
  assert.deepEqual(result.byExactSomName.get('CustomPriority[0]'), {
    speak: null,
    caption: null,
    discoverySpeak: 'Employer identification number',
  });
  assert.equal(
    result.byExactSomName.get('Boundary[0]')?.discoverySpeak,
    boundaryText,
  );
  for (const fieldName of [
    'CaptionPriority',
    'NamePriority',
    'ToolTipPriority',
    'UnknownPriority',
    'EnabledByDefault',
    'ExplicitlyEnabled',
    'UnknownDisable',
    'Nested',
    'TooLong',
    'PunctuationOnly',
  ]) {
    assert.equal(
      result.byExactSomName.get(`${fieldName}[0]`)?.discoverySpeak,
      undefined,
      `${fieldName} must not supply discovery text`,
    );
  }
});

void test('marks an exact XFA signature UI as human-only structural evidence', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <field name="ApprovalControl">
        <ui><signature/></ui>
        <assist><speak>Approval control</speak></assist>
      </field>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(result.byExactSomName.get('ApprovalControl[0]'), {
    speak: 'Approval control',
    caption: null,
  });
  assert.deepEqual([...result.humanOnlyExactSomNames], ['ApprovalControl[0]']);
});

void test('inherits XFA access restrictions without allowing a child to loosen them', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="LockedGroup" access="protected">
        <field name="Inherited" access="open"/>
      </subform>
      <subform name="OpenGroup" access="open">
        <field name="Protected" access="protected"/>
        <field name="ReadOnly" access="readOnly"/>
        <field name="NonInteractive" access="nonInteractive"/>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.readOnlyExactSomNames],
    [
      'LockedGroup[0].Inherited[0]',
      'OpenGroup[0].Protected[0]',
      'OpenGroup[0].ReadOnly[0]',
      'OpenGroup[0].NonInteractive[0]',
    ],
  );
});

void test('locks a named exclusion group when any member access is restricted', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <subform name="Root">
        <exclGroup name="RestrictedFirst">
          <field name="A" access="protected"/>
          <field name="B" access="open"/>
        </exclGroup>
        <exclGroup name="RestrictedLast">
          <field name="A" access="open"/>
          <field name="B" access="nonInteractive"/>
        </exclGroup>
        <exclGroup name="InheritedRestriction">
          <subform access="readOnly">
            <field name="A" access="open"/>
          </subform>
          <field name="B" access="open"/>
        </exclGroup>
        <exclGroup name="OpenChoice">
          <field name="A" access="open"/>
          <field name="B"/>
        </exclGroup>
      </subform>
    </template>
  `);

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual(
    [...result.readOnlyExactSomNames],
    [
      'Root[0].RestrictedFirst[0]',
      'Root[0].RestrictedLast[0]',
      'Root[0].InheritedRestriction[0]',
    ],
  );
  assert.equal(
    result.readOnlyExactSomNames.has('Root[0].OpenChoice[0]'),
    false,
  );
});

void test('rejects unknown XFA access values instead of treating them as open', async () => {
  for (const body of [
    '<field name="F" access="futureMode"/>',
    '<exclGroup name="Choice"><field name="A" access="futureMode"/></exclGroup>',
  ]) {
    const document = await documentWithTemplate(`
      <template xmlns="${XFA_NAMESPACE}">${body}</template>
    `);

    assertUnavailable(
      extractXfaSemantics(document),
      'template_structure_unsupported',
    );
  }
});

void test('accepts only one exact template packet and never decodes other packets', async () => {
  const validTemplate = `<template xmlns="${XFA_NAMESPACE}"><field name="Only"/></template>`;
  const document = await PDFDocument.create();
  const corruptCompressedStream = document.context.stream(
    Uint8Array.of(0, 1, 2, 3),
    { Filter: 'FlateDecode' },
  );
  const withIgnoredCorruptPacket = await documentWithPackets([
    {
      name: 'datasets',
      stream: corruptCompressedStream,
    },
    { name: 'template', contents: validTemplate },
  ]);
  const available = extractXfaSemantics(withIgnoredCorruptPacket);
  assert.equal(available.status, 'available');
  assert.deepEqual([...available.byExactSomName.keys()], ['Only[0]']);

  const wrongCase = await documentWithPackets([
    { name: 'Template', contents: validTemplate },
  ]);
  assertUnavailable(extractXfaSemantics(wrongCase), 'template_packet_missing');

  const duplicate = await documentWithPackets([
    { name: 'template', contents: validTemplate },
    { name: 'template', contents: validTemplate },
  ]);
  assertUnavailable(
    extractXfaSemantics(duplicate),
    'template_packet_duplicate',
  );
});

void test('decodes only no-filter or one bounded FlateDecode layer', async () => {
  const xml = `<template xmlns="${XFA_NAMESPACE}"><field name="Only"/></template>`;
  const compressed = deflateSync(xml);
  const unfiltered = await documentWithPackets([
    { name: 'template', contents: xml, compressed: false },
  ]);
  assert.deepEqual(
    [...extractXfaSemantics(unfiltered).byExactSomName.keys()],
    ['Only[0]'],
  );

  const arrayFilter = await documentWithFilteredTemplate(
    compressed,
    ['FlateDecode'],
    true,
  );
  assert.deepEqual(
    [...extractXfaSemantics(arrayFilter).byExactSomName.keys()],
    ['Only[0]'],
  );

  const chained = await documentWithFilteredTemplate(
    deflateSync(compressed),
    ['FlateDecode', 'FlateDecode'],
    true,
  );
  assertUnavailable(
    extractXfaSemantics(chained),
    'template_packet_filter_unsupported',
  );

  const decodeParameters = await documentWithFilteredTemplate(
    compressed,
    ['FlateDecode'],
    false,
    true,
  );
  assertUnavailable(
    extractXfaSemantics(decodeParameters),
    'template_packet_filter_unsupported',
  );

  const oversizedCompressed = await documentWithFilteredTemplate(
    new Uint8Array(4 * 1024 * 1024 + 1),
    ['FlateDecode'],
    false,
  );
  assertUnavailable(
    extractXfaSemantics(oversizedCompressed),
    'template_packet_compressed_too_large',
  );
});

void test('preserves prefetched bytes across Huffman and stored blocks', async () => {
  const xml = `<template xmlns="${XFA_NAMESPACE}"><field name="Stored"/></template>`;
  const document = await documentWithFilteredTemplate(
    fixedThenStored(new TextEncoder().encode(xml)),
    ['FlateDecode'],
    false,
  );

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.deepEqual([...result.byExactSomName.keys()], ['Stored[0]']);
});

void test('reads fully prefetched bytes before stored-block input', async () => {
  const compressed = bytesFromHex(
    '780104c0050810000000a0feffffffffffffffffffffffffffffffffffffffff47f27469dab6439b865d9a26e8d1b64dbbce7913b5e8d2a543aef4e9bb77ef9eae47b386e9da776a9ebe73e3164ddb364cdfa359c3b45d9ab6edd0a66197a6e933a7cb9c3e51be04020b00f4ff3c2f74656d706c6174653eedd519f8',
  );
  const document = await documentWithFilteredTemplate(
    compressed,
    ['FlateDecode'],
    false,
  );

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.equal(result.byExactSomName.size, 0);
});

void test('accepts a literal-only dynamic block with a zero-bit distance tree', async () => {
  const compressed = bytesFromHex(
    '780105c0050810000000a0feffffffffffffffffffffffffffffffffffffffff47f27469dab6439b865d9a26e8d1b64dbbce7913b5e8d2a543aef4e9bb77ef9eae47b386e9da776a9ebe73e3164ddb364cdfa359c3b45d9ab6edd0a66197a6e933a7cb9c3e51fa7c00e5101602',
  );
  const document = await documentWithFilteredTemplate(
    compressed,
    ['FlateDecode'],
    false,
  );

  const result = extractXfaSemantics(document);

  assert.equal(result.status, 'available');
  assert.equal(result.byExactSomName.size, 0);
});

void test('rejects an undersubscribed dynamic literal tree', async () => {
  const compressed = bytesFromHex(
    '780105c005000004000090feffffffffffffffffffffffffffffffffffffffff877872c934db1cb2c930974c23c823db6cb2cb39de88b2c825971ce28a3efadc73cf3dba3c32cb30baec73ca3cfa9c33ce22d36c338c3e8fcc328c36974cb3cd219b0c73c934fa98a38b39fa88a28f0fe5101602',
  );
  const document = await documentWithFilteredTemplate(
    compressed,
    ['FlateDecode'],
    false,
  );

  assertUnavailable(
    extractXfaSemantics(document),
    'template_packet_decode_failed',
  );
});

void test('interrupts a single-block fixed-Huffman bomb at the decoded limit', async () => {
  const compressed = fixedHuffmanBomb(260_000);
  assert.ok(compressed.byteLength > 400_000);
  assert.ok(compressed.byteLength < 450_000);
  const document = await documentWithFilteredTemplate(
    compressed,
    ['FlateDecode'],
    false,
  );
  const before = process.memoryUsage().arrayBuffers;

  assertUnavailable(extractXfaSemantics(document), 'template_packet_too_large');

  const allocated = process.memoryUsage().arrayBuffers - before;
  assert.ok(
    allocated < 24 * 1024 * 1024,
    `bounded decoder allocated ${allocated} bytes`,
  );
});

void test('rejects non-array and malformed XFA packet structures', async () => {
  const noAcroForm = await PDFDocument.create();
  assertUnavailable(extractXfaSemantics(noAcroForm), 'acroform_missing');

  const noXfa = await PDFDocument.create();
  noXfa.getForm();
  assertUnavailable(extractXfaSemantics(noXfa), 'xfa_missing');

  const singleStream = await PDFDocument.create();
  singleStream
    .getForm()
    .acroForm.dict.set(
      PDFName.of('XFA'),
      singleStream.context.register(
        singleStream.context.flateStream(
          `<template xmlns="${XFA_NAMESPACE}"/>`,
        ),
      ),
    );
  assertUnavailable(extractXfaSemantics(singleStream), 'xfa_not_packet_array');

  const odd = await PDFDocument.create();
  const oddArray = PDFArray.withContext(odd.context);
  oddArray.push(PDFString.of('template'));
  odd.getForm().acroForm.dict.set(PDFName.of('XFA'), oddArray);
  assertUnavailable(extractXfaSemantics(odd), 'xfa_packet_array_malformed');

  const wrongPair = await PDFDocument.create();
  const wrongPairArray = PDFArray.withContext(wrongPair.context);
  wrongPairArray.push(PDFString.of('template'));
  wrongPairArray.push(PDFString.of('not a stream'));
  wrongPair.getForm().acroForm.dict.set(PDFName.of('XFA'), wrongPairArray);
  assertUnavailable(
    extractXfaSemantics(wrongPair),
    'xfa_packet_array_malformed',
  );
});

void test('rejects DTDs, entity declarations, invalid UTF-8, and malformed XML', async () => {
  const dtd = await documentWithTemplate(`
    <!DOCTYPE template [<!ENTITY x "expanded">]>
    <template xmlns="${XFA_NAMESPACE}"><field name="A">&x;</field></template>
  `);
  assertUnavailable(extractXfaSemantics(dtd), 'template_unsafe_xml');

  const entity = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}"><!ENTITY x "expanded"></template>
  `);
  assertUnavailable(extractXfaSemantics(entity), 'template_unsafe_xml');

  const invalidUtf8 = await documentWithTemplate(
    Uint8Array.of(0x3c, 0xc3, 0x28, 0x3e),
  );
  assertUnavailable(extractXfaSemantics(invalidUtf8), 'template_invalid_utf8');

  const malformed = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}"><field name="A"></template>`,
  );
  assertUnavailable(extractXfaSemantics(malformed), 'template_malformed_xml');

  const foreign = await documentWithTemplate(
    '<template xmlns="urn:not-xfa"><field name="A"/></template>',
  );
  assertUnavailable(
    extractXfaSemantics(foreign),
    'template_namespace_unsupported',
  );
});

void test('bounds decompression, element count, and XML depth', async () => {
  const oversized = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}">${'x'.repeat(4 * 1024 * 1024)}</template>`,
  );
  assertUnavailable(
    extractXfaSemantics(oversized),
    'template_packet_too_large',
  );

  const tooManyNodes = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}">${'<draw/>'.repeat(100_000)}</template>`,
  );
  assertUnavailable(
    extractXfaSemantics(tooManyNodes),
    'template_node_limit_exceeded',
  );

  const tooDeep = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}">${'<subform>'.repeat(64)}${'</subform>'.repeat(64)}</template>`,
  );
  assertUnavailable(
    extractXfaSemantics(tooDeep),
    'template_depth_limit_exceeded',
  );
});

void test('rejects cumulative exact SOM key amplification from a small template', async () => {
  const nestedSubforms = Array.from(
    { length: 60 },
    (_, index) => `<subform name="Level${index}_${'x'.repeat(40)}">`,
  ).join('');
  const fields = Array.from(
    { length: 700 },
    (_, index) => `<field name="Field${index}"/>`,
  ).join('');
  const xml = `<template xmlns="${XFA_NAMESPACE}">${nestedSubforms}${fields}${'</subform>'.repeat(60)}</template>`;
  assert.ok(xml.length < 22_000);
  const document = await documentWithTemplate(xml);

  assertUnavailable(
    extractXfaSemantics(document),
    'template_semantic_budget_exceeded',
  );
});

void test('fails the whole template closed above the discovery text budget', async () => {
  const disabledSpeakField = (value: string) =>
    `<field name="F"><assist><speak disable="1">${value}</speak></assist></field>`;
  const repeatedAliases = disabledSpeakField('A'.repeat(180)).repeat(1_456);
  const atLimit = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}">${repeatedAliases}${disabledSpeakField('B'.repeat(64))}</template>`,
  );

  const atLimitResult = extractXfaSemantics(atLimit);
  assert.equal(atLimitResult.status, 'available');
  assert.equal(atLimitResult.candidateCount, 1_457);
  assert.equal(
    atLimitResult.byExactSomName.get('F[1456]')?.discoverySpeak?.length,
    64,
  );

  const overLimit = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}">${repeatedAliases}${disabledSpeakField('B'.repeat(64))}${disabledSpeakField('C')}</template>`,
  );

  assertUnavailable(
    extractXfaSemantics(overLimit),
    'template_semantic_budget_exceeded',
  );
});

void test('rejects excessive exact SOM candidate counts independently', async () => {
  const atLimit = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}">${'<field name="F"/>'.repeat(10_000)}</template>`,
  );
  const atLimitResult = extractXfaSemantics(atLimit);
  assert.equal(atLimitResult.status, 'available');
  assert.equal(atLimitResult.candidateCount, 10_000);

  const overLimit = await documentWithTemplate(
    `<template xmlns="${XFA_NAMESPACE}">${'<field name="F"/>'.repeat(10_001)}</template>`,
  );

  assertUnavailable(
    extractXfaSemantics(overLimit),
    'template_semantic_budget_exceeded',
  );
});

void test('returns null instead of truncated semantic text after overflow', async () => {
  const document = await documentWithTemplate(`
    <template xmlns="${XFA_NAMESPACE}">
      <field name="Long">
        <assist><speak>${'s'.repeat(2_100)}</speak></assist>
        <caption><value><text>${'c'.repeat(600)}</text></value></caption>
      </field>
      <field name="Boundary">
        <assist><speak>${'s'.repeat(2_000)}</speak></assist>
        <caption><value><text>${'c'.repeat(512)}</text></value></caption>
      </field>
    </template>
  `);

  const result = extractXfaSemantics(document);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.byExactSomName.get('Long[0]'), {
    speak: null,
    caption: null,
  });
  assert.equal(result.byExactSomName.get('Boundary[0]')?.speak?.length, 2_000);
  assert.equal(result.byExactSomName.get('Boundary[0]')?.caption?.length, 512);
});
