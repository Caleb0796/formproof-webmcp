import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  rgb,
} from 'pdf-lib';

import {
  createFormFieldDefinitionFromPdf,
  createFormState,
  exportFillPackageFromUi,
  getArtifactReviewFieldNames,
  stageFieldUpdates,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/form-state.ts';
import {
  applyApprovedValues,
  applyConfirmedDerivativeValues,
  inspectPdf,
  PdfEngineError,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/pdf-engine.ts';

const FIELD_NAME = 'applicant.name';

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function xrefStreamEntries(offsets: readonly number[]): Uint8Array {
  const entries = new Uint8Array(offsets.length * 7);
  offsets.forEach((offset, objectNumber) => {
    const index = objectNumber * 7;
    entries[index] = objectNumber === 0 ? 0 : 1;
    const value = objectNumber === 0 ? 0 : offset;
    entries[index + 1] = (value >>> 24) & 255;
    entries[index + 2] = (value >>> 16) & 255;
    entries[index + 3] = (value >>> 8) & 255;
    entries[index + 4] = value & 255;
    entries[index + 5] = objectNumber === 0 ? 255 : 0;
    entries[index + 6] = objectNumber === 0 ? 255 : 0;
  });
  return entries;
}

function setXrefStreamEntry(
  entries: Uint8Array,
  objectNumber: number,
  type: 0 | 1 | 2,
  fieldTwo: number,
  fieldThree: number,
): void {
  const index = objectNumber * 7;
  entries[index] = type;
  entries[index + 1] = (fieldTwo >>> 24) & 255;
  entries[index + 2] = (fieldTwo >>> 16) & 255;
  entries[index + 3] = (fieldTwo >>> 8) & 255;
  entries[index + 4] = fieldTwo & 255;
  entries[index + 5] = (fieldThree >>> 8) & 255;
  entries[index + 6] = fieldThree & 255;
}

function compressedDuplicateCatalogPdf(filter: 'flate' | 'none' = 'flate'): {
  bytes: Uint8Array;
  decodedObjectStream: Uint8Array;
} {
  const encoder = new TextEncoder();
  const objects = [
    {
      number: 2,
      body: '<< /Type /Catalog /Pages 3 0 R /AcroForm << /Fields [] /XFA (hidden-xfa) >> /AcroForm 5 0 R >>',
    },
    {
      number: 3,
      body: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    },
    {
      number: 4,
      body: '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] /Resources << >> /Annots [6 0 R] >>',
    },
    { number: 5, body: '<< /Fields [6 0 R] >>' },
    {
      number: 6,
      body: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [10 10 110 30] /P 4 0 R >>',
    },
  ];
  let objectData = '';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(objectData).byteLength);
    objectData += `${object.body}\n`;
  }
  const objectHeader = objects
    .map((object, index) => `${object.number} ${offsets[index]}`)
    .join(' ')
    .concat(' ');
  const decodedObjectStream = encoder.encode(objectHeader + objectData);
  const streamContents =
    filter === 'flate'
      ? Uint8Array.from(deflateSync(decodedObjectStream))
      : decodedObjectStream;

  const header = encoder.encode('%PDF-1.7\n%\u0080\u0081\u0082\u0083\n');
  const objectStreamOffset = header.byteLength;
  const objectStream = concatenate(
    encoder.encode(
      `7 0 obj\n<< /Type /ObjStm /N ${objects.length} /First ${encoder.encode(objectHeader).byteLength} /Length ${streamContents.byteLength}${filter === 'flate' ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
    ),
    streamContents,
    encoder.encode('\nendstream\nendobj\n'),
  );
  const xrefOffset = objectStreamOffset + objectStream.byteLength;
  const entries = new Uint8Array(9 * 7);
  setXrefStreamEntry(entries, 0, 0, 0, 65_535);
  setXrefStreamEntry(entries, 1, 0, 0, 0);
  objects.forEach((object, index) => {
    setXrefStreamEntry(entries, object.number, 2, 7, index);
  });
  setXrefStreamEntry(entries, 7, 1, objectStreamOffset, 0);
  setXrefStreamEntry(entries, 8, 1, xrefOffset, 0);
  const xrefStream = concatenate(
    encoder.encode(
      `8 0 obj\n<< /Type /XRef /Length ${entries.byteLength} /W [1 4 2] /Size 9 /Root 2 0 R >>\nstream\n`,
    ),
    entries,
    encoder.encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF`),
  );
  return {
    bytes: concatenate(header, objectStream, xrefStream),
    decodedObjectStream,
  };
}

function syntheticLinearizedPdf(linearizedValue: string): Uint8Array {
  const encoder = new TextEncoder();
  const encode = (value: string) => encoder.encode(value);
  const assemble = (values: {
    length: number;
    firstPageEnd: number;
    mainXrefOffset: number;
  }) => {
    const header = encode('%PDF-1.7\n%\u0080\u0081\u0082\u0083\n');
    const linearization = encode(
      `1 0 obj\n<< /Linearized ${linearizedValue} /L ${values.length} /O 5 /E ${values.firstPageEnd} /N 1 /T ${values.mainXrefOffset} /H [0 0] >>\nendobj\n`,
    );
    const firstXrefOffset = header.byteLength + linearization.byteLength;
    const firstXrefHeader = encode(
      `2 0 obj\n<< /Type /XRef /Length 49 /W [1 4 2] /Size 7 /Root 3 0 R /Prev ${values.mainXrefOffset} >>\nstream\n`,
    );
    const xrefPlaceholder = new Uint8Array(49);
    const xrefFooter = encode('\nendstream\nendobj\n');
    const pseudoMarker = encode('startxref\n0\n%%EOF\n');
    const catalog = encode(
      '3 0 obj\n<< /Type /Catalog /Pages 4 0 R >>\nendobj\n',
    );
    const pages = encode(
      '4 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj\n',
    );
    const page = encode(
      '5 0 obj\n<< /Type /Page /Parent 4 0 R /MediaBox [0 0 200 200] >>\nendobj\n',
    );
    const catalogOffset =
      firstXrefOffset +
      firstXrefHeader.byteLength +
      xrefPlaceholder.byteLength +
      xrefFooter.byteLength +
      pseudoMarker.byteLength;
    const pagesOffset = catalogOffset + catalog.byteLength;
    const pageOffset = pagesOffset + pages.byteLength;
    const mainXrefOffset = pageOffset + page.byteLength;
    const mainXrefHeader = encode(
      '6 0 obj\n<< /Type /XRef /Length 49 /W [1 4 2] /Size 7 /Root 3 0 R >>\nstream\n',
    );
    const finalMarker = encode(`startxref\n${firstXrefOffset}\n%%EOF`);
    const entries = xrefStreamEntries([
      0,
      header.byteLength,
      firstXrefOffset,
      catalogOffset,
      pagesOffset,
      pageOffset,
      mainXrefOffset,
    ]);
    const bytes = concatenate(
      header,
      linearization,
      firstXrefHeader,
      entries,
      xrefFooter,
      pseudoMarker,
      catalog,
      pages,
      page,
      mainXrefHeader,
      entries,
      xrefFooter,
      finalMarker,
    );
    return {
      bytes,
      values: {
        length: bytes.byteLength,
        firstPageEnd: catalogOffset + 1,
        mainXrefOffset,
      },
    };
  };

  let values = { length: 0, firstPageEnd: 0, mainXrefOffset: 0 };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = assemble(values);
    if (
      next.values.length === values.length &&
      next.values.firstPageEnd === values.firstPageEnd &&
      next.values.mainXrefOffset === values.mainXrefOffset
    ) {
      return next.bytes;
    }
    values = next.values;
  }
  throw new Error('synthetic linearization offsets did not converge');
}

function lastStartXref(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  const matches = [
    ...text.matchAll(/startxref\s+(\d+)(?:\s|%[^\r\n]*(?:\r\n|\r|\n))*%%EOF/gu),
  ];
  const offset = Number(matches.at(-1)?.[1]);
  assert.ok(Number.isSafeInteger(offset), 'incremental base needs startxref');
  return offset;
}

function appendIncrementalObject(
  source: Uint8Array,
  options: {
    objectNumber: number;
    body: string;
    root: PDFRef;
    size: number;
    beforeEof?: string;
    eofText?: string;
    omitMarker?: boolean;
    previousXref?: number;
    emittedStartXref?: number;
  },
): Uint8Array {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('\n');
  const objectOffset = source.byteLength + prefix.byteLength;
  const object = encoder.encode(
    `${options.objectNumber} 0 obj\n${options.body}\nendobj\n`,
  );
  const xrefOffset = objectOffset + object.byteLength;
  const xref = encoder.encode(
    `xref\n${options.objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size ${options.size} /Root ${options.root.toString()} /Prev ${options.previousXref ?? lastStartXref(source)} >>\n` +
      (options.omitMarker
        ? ''
        : `startxref\n${options.emittedStartXref ?? xrefOffset}\n${options.beforeEof ?? ''}${options.eofText ?? '%%EOF'}\n`),
  );
  return concatenate(source, prefix, object, xref);
}

function appendIncrementalObjects(
  source: Uint8Array,
  options: {
    definitions: readonly { body: string; objectNumber: number }[];
    root: PDFRef;
    size: number;
  },
): Uint8Array {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('\n');
  let objectOffset = source.byteLength + prefix.byteLength;
  const objects: Uint8Array[] = [];
  const xrefSections: string[] = [];
  for (const definition of [...options.definitions].sort(
    (left, right) => left.objectNumber - right.objectNumber,
  )) {
    const object = encoder.encode(
      `${definition.objectNumber} 0 obj\n${definition.body}\nendobj\n`,
    );
    xrefSections.push(
      `${definition.objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n`,
    );
    objects.push(object);
    objectOffset += object.byteLength;
  }
  const xrefOffset = objectOffset;
  const xref = encoder.encode(
    `xref\n${xrefSections.join('')}trailer\n<< /Size ${options.size} /Root ${options.root.toString()} /Prev ${lastStartXref(source)} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return concatenate(source, prefix, ...objects, xref);
}

function replaceSingleAsciiSameLength(
  source: Uint8Array,
  before: string,
  after: string,
): Uint8Array {
  const encoder = new TextEncoder();
  assert.equal(
    encoder.encode(after).byteLength,
    encoder.encode(before).byteLength,
  );
  const text = new TextDecoder('latin1').decode(source);
  const offset = text.indexOf(before);
  assert.notEqual(offset, -1, `missing patch marker: ${before}`);
  assert.equal(
    text.indexOf(before, offset + 1),
    -1,
    `duplicate patch marker: ${before}`,
  );
  const output = source.slice();
  output.set(encoder.encode(after), offset);
  return output;
}

async function ordinaryFormPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 200]);
  const field = document.getForm().createTextField(FIELD_NAME);
  field.addToPage(page, {
    x: 30,
    y: 100,
    width: 220,
    height: 24,
    borderColor: rgb(0, 0, 0),
  });
  return document.save({ useObjectStreams: false });
}

async function incrementalFixture(
  body: string,
  beforeEof?: string,
): Promise<{
  bytes: Uint8Array;
  objectNumber: number;
}> {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  return {
    bytes: appendIncrementalObject(base, {
      objectNumber,
      body,
      root,
      size: objectNumber + 1,
      beforeEof,
    }),
    objectNumber,
  };
}

async function objectStreamFixture(
  dictionaryEntries: string,
  payload = '99 0 << /Type /AuditMarker >>',
): Promise<Uint8Array> {
  const payloadLength = new TextEncoder().encode(payload).byteLength;
  const { bytes } = await incrementalFixture(
    `<< /Type /ObjStm ${dictionaryEntries} /Length ${payloadLength} >>\nstream\n${payload}\nendstream`,
  );
  return bytes;
}

async function compressedObjectStreamBomb(): Promise<{
  bytes: Uint8Array;
  compressedBytes: number;
  decodedBytes: number;
}> {
  const source = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(source, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const decoded = new Uint8Array(17 * 1024 * 1024);
  decoded.fill(32);
  decoded.set(new TextEncoder().encode('99 0 null'));
  const compressed = Uint8Array.from(deflateSync(decoded));
  const encoder = new TextEncoder();
  const prefix = encoder.encode('\n');
  const objectOffset = source.byteLength + prefix.byteLength;
  const object = concatenate(
    encoder.encode(
      `${objectNumber} 0 obj\n<< /Type /ObjStm /N 1 /First 5 /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n`,
    ),
    compressed,
    encoder.encode('\nendstream\nendobj\n'),
  );
  const xrefOffset = objectOffset + object.byteLength;
  const xref = encoder.encode(
    `xref\n${objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size ${objectNumber + 1} /Root ${root.toString()} /Prev ${lastStartXref(source)} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return {
    bytes: concatenate(source, prefix, object, xref),
    compressedBytes: compressed.byteLength,
    decodedBytes: decoded.byteLength,
  };
}

function encodeAscii85(input: Uint8Array): Uint8Array {
  let encoded = '';
  for (let offset = 0; offset < input.byteLength; offset += 4) {
    const length = Math.min(4, input.byteLength - offset);
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      value = value * 256 + (index < length ? input[offset + index] : 0);
    }
    const group = Array.from({ length: 5 }, () => 0);
    for (let index = 4; index >= 0; index -= 1) {
      group[index] = (value % 85) + 33;
      value = Math.floor(value / 85);
    }
    encoded += String.fromCharCode(...group.slice(0, length + 1));
  }
  return new TextEncoder().encode(`${encoded}~>`);
}

function appendCompressedOrdinaryStream(
  source: Uint8Array,
  root: PDFRef,
  objectNumber: number,
  decodedBytes: number,
  options: {
    ascii85?: boolean;
    filter?: string;
    length?: string;
  } = {},
): { bytes: Uint8Array; compressedBytes: number } {
  const decoded = new Uint8Array(decodedBytes);
  decoded.fill(32);
  const compressed = Uint8Array.from(deflateSync(decoded));
  const streamContents = options.ascii85
    ? encodeAscii85(compressed)
    : compressed;
  const encoder = new TextEncoder();
  const prefix = encoder.encode('\n');
  const objectOffset = source.byteLength + prefix.byteLength;
  const object = concatenate(
    encoder.encode(
      `${objectNumber} 0 obj\n<< /Length ${options.length ?? streamContents.byteLength} /Filter ${options.filter ?? '/FlateDecode'} >>\nstream\n`,
    ),
    streamContents,
    encoder.encode('\nendstream\nendobj\n'),
  );
  const xrefOffset = objectOffset + object.byteLength;
  const xref = encoder.encode(
    `xref\n${objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size ${objectNumber + 1} /Root ${root.toString()} /Prev ${lastStartXref(source)} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return {
    bytes: concatenate(source, prefix, object, xref),
    compressedBytes: streamContents.byteLength,
  };
}

async function assertObjectStreamRejected(
  bytes: Uint8Array,
  expectedIssue: string,
  label: string,
): Promise<void> {
  const parsed = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(parsed.getPageCount(), 1, label);

  const inspection = await inspectPdf(bytes);
  assert.equal(inspection.protection.protectionType, 'unknown', label);
  assert.equal(
    inspection.protection.evidence.historyScanComplete,
    false,
    label,
  );
  assert.equal(
    inspection.protection.evidence.historyScanIssues?.includes(expectedIssue),
    true,
    label,
  );
  assert.equal(
    inspection.protection.evidence.unknownStructures.includes(
      'historical_scan_inconclusive',
    ),
    true,
    label,
  );
  assert.deepEqual(inspection.protection.exportStrategies, [], label);
  await assert.rejects(
    applyApprovedValues(bytes, { [FIELD_NAME]: 'Must not be written' }),
    (error: unknown) =>
      error instanceof PdfEngineError &&
      error.code === 'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
    label,
  );
}

async function assertObjectStreamResourceRejected(
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfEngineError &&
      error.code === 'PDF_RESOURCE_LIMIT_EXCEEDED',
    label,
  );
}

void test('fails closed when a later revision redefines a historical ByteRange object', async () => {
  const firstRevision = await incrementalFixture(
    '<< /Type /Sig /ByteRange [0 10 20 10] /Contents <00> >>',
  );
  const firstParsed = await PDFDocument.load(firstRevision.bytes, {
    updateMetadata: false,
  });
  const root = firstParsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const source = appendIncrementalObject(firstRevision.bytes, {
    objectNumber: firstRevision.objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: firstRevision.objectNumber + 1,
  });
  const sourceSnapshot = source.slice();

  const rawText = new TextDecoder('latin1').decode(source);
  assert.equal(rawText.match(/\/ByteRange\b/gu)?.length, 1);
  assert.match(
    rawText,
    /\/Type \/Sig \/ByteRange \[0 10 20 10\] \/Contents <00>/u,
  );

  const latest = await PDFDocument.load(source, { updateMetadata: false });
  const currentObject = latest.context.lookup(
    PDFRef.of(firstRevision.objectNumber, 0),
  );
  assert.ok(currentObject instanceof PDFDict);
  assert.equal(currentObject.has(PDFName.of('ByteRange')), false);
  assert.equal(
    currentObject.lookup(PDFName.of('Type'), PDFName).decodeText(),
    'HiddenOldSignature',
  );

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.byteRangeEntryCount, 0);
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 3);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
  assert.equal(inspection.protection.evidence.signatureDictionaryCount, 0);
  assert.equal(
    inspection.protection.evidence.unreachableSignatureDictionaryCount,
    0,
  );
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_byte_range_changed_or_missing',
    'historical_signature_structure_changed_or_missing',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
  assert.equal(
    inspection.protection.allowedMutations.includes('create_filled_pdf'),
    false,
  );
  assert.equal(
    inspection.protection.allowedMutations.includes('create_fill_package'),
    false,
  );

  await assert.rejects(
    applyApprovedValues(source, { [FIELD_NAME]: 'Synthetic' }),
    (error) =>
      error instanceof PdfEngineError &&
      error.code === 'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );

  const state = await createFormState(
    {
      fileName: 'historical-signature.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD_NAME,
        value: 'Synthetic',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          evidence: ['Synthetic regression value'],
        },
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('historical fixture could not be staged');
  const fillPackage = await exportFillPackageFromUi(staged.state, source, {
    confirmedFieldNames: getArtifactReviewFieldNames(staged.state),
    createdAt: '2026-08-29T00:00:00.000Z',
  });
  assert.equal(fillPackage.ok, false);
  if (fillPackage.ok) throw new Error('historical fixture exported a package');
  assert.deepEqual(
    fillPackage.errors.map(({ code }) => code),
    ['artifact_unavailable'],
  );
  assert.deepEqual(source, sourceSnapshot);
});

void test('fails closed when a historical document signature is redefined as UR3 with the same refs', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 200]);
  const form = document.getForm();
  const writable = form.createTextField(FIELD_NAME);
  writable.addToPage(page, {
    x: 30,
    y: 120,
    width: 220,
    height: 24,
    borderColor: rgb(0, 0, 0),
  });
  const signatureField = form.createTextField('approval.signature');
  signatureField.addToPage(page, {
    x: 30,
    y: 70,
    width: 220,
    height: 24,
    borderColor: rgb(0, 0, 0),
  });
  signatureField.acroField.dict.set(PDFName.of('FT'), PDFName.of('Sig'));
  signatureField.acroField.dict.delete(PDFName.of('DA'));

  const byteRangeRef = document.context.register(
    document.context.obj([0, 10, 20, 10]),
  );
  const signatureRef = document.context.register(
    document.context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: byteRangeRef,
      Contents: PDFHexString.of('00'),
    }),
  );
  signatureField.acroField.dict.set(PDFName.of('V'), signatureRef);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  const base = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  const baseInspection = await inspectPdf(base);
  assert.equal(baseInspection.protection.protectionType, 'document_signature');

  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const parsedSignatureField = parsed
    .getForm()
    .getSignature('approval.signature');
  let fieldBody = parsedSignatureField.acroField.dict.toString();
  fieldBody = fieldBody.replace(
    new RegExp(`\\s*/V\\s+${signatureRef.objectNumber}\\s+0\\s+R`, 'u'),
    '',
  );
  assert.equal(fieldBody.includes('/V'), false);
  const permsObjectNumber = parsed.context.largestObjectNumber + 1;
  const catalogBody = parsed.catalog
    .toString()
    .replace(/>>\s*$/u, `/Perms ${permsObjectNumber} 0 R\n>>`);
  const rangePlaceholder = '[ 0 1 2 4444444444 ]';
  const ur3Body =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ` +
    `/ByteRange ${byteRangeRef.toString()} /Contents <00> ` +
    `/Reference [ << /Type /SigRef /TransformMethod /UR3 ` +
    `/TransformParams << /Type /TransformParams /V /2.2 /P false /Form [ /FillIn ] >> >> ] >>`;
  let source = appendIncrementalObjects(base, {
    definitions: [
      { objectNumber: root.objectNumber, body: catalogBody },
      {
        objectNumber: parsedSignatureField.acroField.ref.objectNumber,
        body: fieldBody,
      },
      { objectNumber: signatureRef.objectNumber, body: ur3Body },
      { objectNumber: byteRangeRef.objectNumber, body: rangePlaceholder },
      {
        objectNumber: permsObjectNumber,
        body: `<< /UR3 ${signatureRef.toString()} >>`,
      },
    ],
    root,
    size: permsObjectNumber + 1,
  });
  source = replaceSingleAsciiSameLength(
    source,
    rangePlaceholder,
    `[ 0 1 2 ${String(source.byteLength - 2).padStart(10, '0')} ]`,
  );
  const sourceSnapshot = source.slice();

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.deepEqual(inspection.protection.evidence.permsKeys, ['UR3']);
  assert.deepEqual(inspection.protection.evidence.usageRightsKeys, ['UR3']);
  assert.equal(inspection.protection.evidence.usageRightsSignatureCount, 1);
  assert.equal(inspection.protection.evidence.documentSignatureCount, 0);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_byte_range_changed_or_missing',
    'historical_signature_structure_changed_or_missing',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
  assert.deepEqual(inspection.protection.allowedMutations, ['inspect_fields']);

  await assert.rejects(
    applyApprovedValues(source, { [FIELD_NAME]: 'Must not be written' }),
    (error: unknown) =>
      error instanceof PdfEngineError &&
      error.code === 'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );
  await assert.rejects(
    applyConfirmedDerivativeValues(
      source,
      { [FIELD_NAME]: 'Must not be written' },
      { humanConfirmedProtectionLoss: true },
    ),
    (error: unknown) =>
      error instanceof PdfEngineError &&
      error.code === 'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );

  const state = await createFormState(
    {
      fileName: 'same-ref-signature-to-ur3.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD_NAME,
        value: 'Must not be exported',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          evidence: ['Same-ref history attack regression value'],
        },
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok)
    throw new Error('same-ref attack fixture could not be staged');
  const fillPackage = await exportFillPackageFromUi(staged.state, source, {
    confirmedFieldNames: getArtifactReviewFieldNames(staged.state),
    createdAt: '2026-08-29T00:00:00.000Z',
  });
  assert.equal(fillPackage.ok, false);
  if (fillPackage.ok) throw new Error('same-ref attack exported a package');
  assert.deepEqual(
    fillPackage.errors.map(({ code }) => code),
    ['artifact_unavailable'],
  );
  assert.deepEqual(source, sourceSnapshot);
});

void test('keeps an unchanged historical certification conclusive when signatures and DSS are appended', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 200]);
  const catalogRef = document.context.getObjectRef(document.catalog);
  assert.ok(catalogRef instanceof PDFRef);
  const certificationReference = document.context.obj({
    Type: 'SigRef',
    TransformMethod: 'DocMDP',
    Data: catalogRef,
    TransformParams: { Type: 'TransformParams', V: '1.2', P: 2 },
  });
  const certificationRef = document.context.register(
    document.context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 10, 20, 10],
      Contents: PDFHexString.of('01020304'),
      Reference: [certificationReference],
    }),
  );
  const form = document.getForm();
  const certificationField = form.createTextField('certification.signature');
  certificationField.addToPage(page, {
    x: 10,
    y: 10,
    width: 60,
    height: 20,
  });
  certificationField.acroField.dict.set(PDFName.of('FT'), PDFName.of('Sig'));
  certificationField.acroField.dict.delete(PDFName.of('DA'));
  certificationField.acroField.dict.set(PDFName.of('V'), certificationRef);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const acroFormRef = document.catalog.get(PDFName.of('AcroForm'));
  assert.ok(acroFormRef instanceof PDFRef);
  document.catalog.set(
    PDFName.of('Perms'),
    document.context.register(
      document.context.obj({ DocMDP: certificationRef }),
    ),
  );

  const base = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  const baseInspection = await inspectPdf(base);
  assert.equal(baseInspection.protection.protectionType, 'doc_mdp');

  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const acroForm = parsed.context.lookup(acroFormRef);
  assert.ok(acroForm instanceof PDFDict);
  const rawFields = acroForm.get(PDFName.of('Fields'));
  assert.ok(rawFields instanceof PDFArray || rawFields instanceof PDFRef);
  const parsedFields = parsed.context.lookup(rawFields);
  assert.ok(parsedFields instanceof PDFArray);
  const certificationFieldRef = parsedFields.get(0);
  assert.ok(certificationFieldRef instanceof PDFRef);
  const pageRef = parsed.getPage(0).ref;
  const firstNewObjectNumber = parsed.context.largestObjectNumber + 1;
  const secondSignatureRef = PDFRef.of(firstNewObjectNumber, 0);
  const secondFieldRef = PDFRef.of(firstNewObjectNumber + 1, 0);
  const ordinaryFieldRef = PDFRef.of(firstNewObjectNumber + 2, 0);
  const dssObjectNumber = firstNewObjectNumber + 3;
  const fieldsRef = PDFRef.of(firstNewObjectNumber + 4, 0);
  const catalogBody = parsed.catalog
    .toString()
    .replace(/>>\s*$/u, `/DSS ${dssObjectNumber} 0 R\n>>`);
  const acroFormBody = acroForm
    .toString()
    .replace(
      /\/Fields\s+(?:\[[^\]]*\]|\d+\s+\d+\s+R)/u,
      `/Fields ${fieldsRef.toString()}`,
    );
  assert.notEqual(acroFormBody, acroForm.toString());
  const source = appendIncrementalObjects(base, {
    definitions: [
      { objectNumber: root.objectNumber, body: catalogBody },
      { objectNumber: acroFormRef.objectNumber, body: acroFormBody },
      {
        objectNumber: secondSignatureRef.objectNumber,
        body: '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 10 20 10] /Contents <aabbccdd> >>',
      },
      {
        objectNumber: secondFieldRef.objectNumber,
        body: `<< /Type /Annot /Subtype /Widget /FT /Sig /T (second.signature) /V ${secondSignatureRef.toString()} /Rect [0 0 0 0] /P ${pageRef.toString()} >>`,
      },
      {
        objectNumber: ordinaryFieldRef.objectNumber,
        body: `<< /Type /Annot /Subtype /Widget /FT /Tx /T (ordinary) /Rect [0 0 0 0] /P ${pageRef.toString()} >>`,
      },
      { objectNumber: dssObjectNumber, body: '<< /VRI << >> >>' },
      {
        objectNumber: fieldsRef.objectNumber,
        body: `[ ${certificationFieldRef.toString()} ${secondFieldRef.toString()} ${ordinaryFieldRef.toString()} ]`,
      },
    ],
    root,
    size: fieldsRef.objectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'doc_mdp');
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, []);
  assert.equal(inspection.protection.evidence.signatureDictionaryCount, 2);
  assert.equal(inspection.protection.evidence.documentSignatureCount, 1);
  assert.equal(
    inspection.protection.evidence.docMdpSignatureDictionaryCount,
    1,
  );
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
});

void test('does not flag a benign incremental revision without ByteRange', async () => {
  const { bytes } = await incrementalFixture('<< /Type /AuditMarker >>');
  const inspection = await inspectPdf(bytes);

  assert.equal(inspection.protection.protectionType, 'none');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, []);
  assert.deepEqual(inspection.protection.exportStrategies, [
    'filled_pdf',
    'fill_package',
  ]);
});

void test('does not confuse ByteRange text inside a PDF string with protection', async () => {
  const { bytes } = await incrementalFixture(
    '<< /Type /AuditMarker /Note (The tokens /ByteRange and startxref are documentation.) >>',
  );
  const inspection = await inspectPdf(bytes);

  assert.equal(inspection.protection.protectionType, 'none');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, []);
});

void test('ignores ByteRange-like bytes inside comments, hex strings, and streams', async () => {
  const commented = await incrementalFixture(
    '<< /Type /AuditMarker /Hex <2F4279746552616E6765> >> % /ByteRange startxref',
  );
  const streamed = await incrementalFixture(
    '<< /Length 21 >>\nstream\n/ByteRange startxref\nendstream',
  );

  for (const { bytes } of [commented, streamed]) {
    const inspection = await inspectPdf(bytes);
    assert.equal(inspection.protection.protectionType, 'none');
    assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 0);
    assert.equal(
      inspection.protection.evidence.historicalByteRangeNameCount,
      0,
    );
    assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  }
});

void test('uses a direct stream Length instead of stopping at embedded end markers', async () => {
  const streamData = 'AAA\nendstream\nendobj\n/ByteRange\nZZZ';
  const { bytes } = await incrementalFixture(
    `<< /Length ${new TextEncoder().encode(streamData).byteLength} >>\nstream\n${streamData}\nendstream`,
  );
  const parsed = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.ok(parsed.context.enumerateIndirectObjects().length >= 5);

  const inspection = await inspectPdf(bytes);
  assert.equal(inspection.protection.protectionType, 'none');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, []);
});

void test('does not treat a ByteRange name value as a dictionary key', async () => {
  const { bytes } = await incrementalFixture(
    '<< /Type /AuditMarker /Note /ByteRange >>',
  );
  const inspection = await inspectPdf(bytes);

  assert.equal(inspection.protection.protectionType, 'none');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, []);
});

void test('recognizes hex-escaped historical ByteRange names', async () => {
  const firstRevision = await incrementalFixture(
    '<< /Type /Sig /#42yteRange [0 10 20 10] /Contents <00> >>',
  );
  const parsed = await PDFDocument.load(firstRevision.bytes, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const source = appendIncrementalObject(firstRevision.bytes, {
    objectNumber: firstRevision.objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: firstRevision.objectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 1);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_byte_range_changed_or_missing',
    'historical_signature_structure_changed_or_missing',
  ]);
});

void test('treats comments between startxref and EOF as PDF whitespace', async () => {
  const firstRevision = await incrementalFixture(
    '<< /Type /Sig /ByteRange [0 10 20 10] /Contents <00> >>',
    '% conforming PDF comment\n',
  );
  const parsed = await PDFDocument.load(firstRevision.bytes, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const source = appendIncrementalObject(firstRevision.bytes, {
    objectNumber: firstRevision.objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: firstRevision.objectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 3);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_byte_range_changed_or_missing',
    'historical_signature_structure_changed_or_missing',
  ]);
});

void test('ignores a plausible revision marker embedded in raw stream data', async () => {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const streamObjectOffset = base.byteLength + 1;
  const streamData = `benign payload\nstartxref\n${streamObjectOffset}\n%%EOF\nmore benign payload`;
  const source = appendIncrementalObject(base, {
    objectNumber,
    body: `<< /Length ${new TextEncoder().encode(streamData).byteLength} >>\nstream\n${streamData}\nendstream`,
    root,
    size: objectNumber + 1,
  });
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'none');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
});

void test('ignores plausible revision markers inside literal strings', async () => {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const objectOffset = base.byteLength + 1;
  const source = appendIncrementalObject(base, {
    objectNumber,
    body: `<< /Type /AuditMarker /Note (benign\nstartxref\n${objectOffset}\n%%EOF\ntext) >>`,
    root,
    size: objectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'none');
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
});

void test('does not spend the revision budget on markers inside a stream', async () => {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const objectOffset = base.byteLength + 1;
  const streamData = `startxref\n${objectOffset}\n%%EOF\n`.repeat(33);
  const source = appendIncrementalObject(base, {
    objectNumber,
    body: `<< /Length ${new TextEncoder().encode(streamData).byteLength} >>\nstream\n${streamData}endstream`,
    root,
    size: objectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'none');
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
});

void test('does not hide a real historical signature when its marker is copied into a stream', async () => {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const signatureObjectNumber = parsed.context.largestObjectNumber + 1;
  const streamObjectNumber = signatureObjectNumber + 1;
  const signed = appendIncrementalObject(base, {
    objectNumber: signatureObjectNumber,
    body: '<< /Type /Sig /ByteRange [0 10 20 10] /Contents <00> >>',
    root,
    size: signatureObjectNumber + 1,
  });
  const signedMarker = `startxref\n${lastStartXref(signed)}\n%%EOF`;

  let guessedStreamXref = signed.byteLength + 100;
  let withMarkerStream = signed;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const streamData = `${signedMarker}\nstartxref\n${guessedStreamXref}\n%%EOF`;
    withMarkerStream = appendIncrementalObject(signed, {
      objectNumber: streamObjectNumber,
      body: `<< /Length ${new TextEncoder().encode(streamData).byteLength} >>\nstream\n${streamData}\nendstream`,
      root,
      size: streamObjectNumber + 1,
    });
    const actualStreamXref = lastStartXref(withMarkerStream);
    if (actualStreamXref === guessedStreamXref) break;
    guessedStreamXref = actualStreamXref;
  }
  assert.equal(lastStartXref(withMarkerStream), guessedStreamXref);
  const source = appendIncrementalObject(withMarkerStream, {
    objectNumber: signatureObjectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: streamObjectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 4);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_byte_range_changed_or_missing',
    'historical_signature_structure_changed_or_missing',
  ]);
});

void test('finds a historical ByteRange dictionary stored in an object stream', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 200]);
  const field = document.getForm().createTextField(FIELD_NAME);
  field.addToPage(page, {
    x: 30,
    y: 100,
    width: 220,
    height: 24,
    borderColor: rgb(0, 0, 0),
  });
  const historicalSignature = document.context.obj({
    Type: PDFName.of('Sig'),
    ByteRange: document.context.obj([0, 10, 20, 10]),
    Contents: PDFHexString.of('00'),
  });
  const signatureReference = document.context.register(historicalSignature);
  const firstRevision = await document.save({ useObjectStreams: true });
  assert.equal(
    new TextDecoder('latin1').decode(firstRevision).includes('/ByteRange'),
    false,
  );

  const parsed = await PDFDocument.load(firstRevision, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const source = appendIncrementalObject(firstRevision, {
    objectNumber: signatureReference.objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: parsed.context.largestObjectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.byteRangeEntryCount, 0);
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.historyScanComplete, true);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_byte_range_changed_or_missing',
    'historical_signature_structure_changed_or_missing',
  ]);
});

void test('fails closed for an unreachable signature dictionary on a raw stream', async () => {
  const { bytes } = await incrementalFixture(
    '<< /Type /Sig /ByteRange [0 10 20 10] /Contents <00> /Length 1 >>\nstream\nX\nendstream',
  );
  const inspection = await inspectPdf(bytes);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.byteRangeEntryCount, 1);
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 1);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 0);
  assert.equal(
    inspection.protection.evidence.unreachableSignatureDictionaryCount,
    1,
  );
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_or_unreachable_signature_structure',
    'unclassified_signature_dictionary',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed for a signature dictionary nested under an unreachable object', async () => {
  const { bytes } = await incrementalFixture(
    '<< /Payload << /Type /Sig /ByteRange [0 10 20 10] /Contents <00> >> >>',
  );
  const inspection = await inspectPdf(bytes);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.byteRangeEntryCount, 1);
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 1);
  assert.equal(
    inspection.protection.evidence.unreachableSignatureDictionaryCount,
    1,
  );
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_or_unreachable_signature_structure',
    'unclassified_signature_dictionary',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed when an intermediate revision marker has an invalid xref offset', async () => {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const body = '<< /Type /Sig /ByteRange [0 10 20 10] /Contents <00> >>';
  const historicalXrefOffset =
    base.byteLength +
    1 +
    new TextEncoder().encode(`${objectNumber} 0 obj\n${body}\nendobj\n`)
      .byteLength;
  const historical = appendIncrementalObject(base, {
    objectNumber,
    body,
    root,
    size: objectNumber + 1,
    emittedStartXref: 0,
  });
  const source = appendIncrementalObject(historical, {
    objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: objectNumber + 1,
    previousXref: historicalXrefOffset,
  });
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, [
    'final_revision_boundary_unverified',
    'revision_xref_offset_invalid',
    'unmarked_classic_xref_section',
  ]);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed when an intermediate revision marker has no EOF boundary', async () => {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const body = '<< /Type /Sig /ByteRange [0 10 20 10] /Contents <00> >>';
  const historicalXrefOffset =
    base.byteLength +
    1 +
    new TextEncoder().encode(`${objectNumber} 0 obj\n${body}\nendobj\n`)
      .byteLength;
  const historical = appendIncrementalObject(base, {
    objectNumber,
    body,
    root,
    size: objectNumber + 1,
    eofText: '% intermediate EOF deliberately absent',
  });
  const source = appendIncrementalObject(historical, {
    objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: objectNumber + 1,
    previousXref: historicalXrefOffset,
  });
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, [
    'final_revision_boundary_unverified',
    'revision_marker_malformed',
    'unmarked_classic_xref_section',
  ]);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed for an unmarked intermediate xref section', async () => {
  const base = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(base, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const body = '<< /Type /Sig /ByteRange [0 10 20 10] /Contents <00> >>';
  const historicalXrefOffset =
    base.byteLength +
    1 +
    new TextEncoder().encode(`${objectNumber} 0 obj\n${body}\nendobj\n`)
      .byteLength;
  const historical = appendIncrementalObject(base, {
    objectNumber,
    body,
    root,
    size: objectNumber + 1,
    omitMarker: true,
  });
  const source = appendIncrementalObject(historical, {
    objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: objectNumber + 1,
    previousXref: historicalXrefOffset,
  });
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.revisionMarkerCount, 2);
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, [
    'unmarked_classic_xref_section',
  ]);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed for a historical signature structure without ByteRange', async () => {
  const firstRevision = await incrementalFixture(
    '<< /Type /Sig /Contents <00> >>',
  );
  const parsed = await PDFDocument.load(firstRevision.bytes, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const source = appendIncrementalObject(firstRevision.bytes, {
    objectNumber: firstRevision.objectNumber,
    body: '<< /Type /HiddenOldSignature >>',
    root,
    size: firstRevision.objectNumber + 1,
  });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.rawByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.historicalByteRangeNameCount, 0);
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, [
    'revision_signature_fingerprint_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
    'historical_signature_structure_changed_or_missing',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed for a duplicate Catalog key inside supported object streams', async () => {
  for (const filter of ['flate', 'none'] as const) {
    const { bytes, decodedObjectStream } =
      compressedDuplicateCatalogPdf(filter);
    const decodedText = new TextDecoder('latin1').decode(decodedObjectStream);
    assert.equal(decodedText.match(/\/AcroForm\b/gu)?.length, 2, filter);
    assert.match(decodedText, /\/XFA \(hidden-xfa\)/u, filter);
    assert.equal(
      new TextDecoder('latin1').decode(bytes).includes('/AcroForm'),
      filter === 'none',
      filter,
    );

    const parsed = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.deepEqual(
      parsed
        .getForm()
        .getFields()
        .map((field) => field.getName()),
      ['name'],
      filter,
    );
    assert.equal(parsed.catalog.AcroForm()?.has(PDFName.of('XFA')), false);

    const inspection = await inspectPdf(bytes);
    assert.equal(inspection.protection.protectionType, 'unknown', filter);
    assert.equal(inspection.protection.evidence.xfaPresent, false, filter);
    assert.equal(
      inspection.protection.evidence.historyScanComplete,
      false,
      filter,
    );
    assert.equal(
      inspection.protection.evidence.historyScanIssues?.includes(
        'dictionary_key_duplicate',
      ),
      true,
      filter,
    );
    assert.deepEqual(inspection.protection.exportStrategies, [], filter);
    await assert.rejects(
      applyApprovedValues(bytes, { name: 'Must not be written' }),
      (error: unknown) =>
        error instanceof PdfEngineError &&
        error.code === 'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
      filter,
    );
  }
});

void test('fails closed for unsupported object stream filters and decode parameters', async () => {
  const cases = [
    {
      label: 'unsupported direct filter',
      dictionary: '/N 1 /First 5 /Filter /ASCIIHexDecode',
    },
    {
      label: 'multiple filters',
      dictionary: '/N 1 /First 5 /Filter [/FlateDecode /ASCIIHexDecode]',
    },
    {
      label: 'indirect filter',
      dictionary: '/N 1 /First 5 /Filter 999 0 R',
    },
    {
      label: 'FlateDecode parameters',
      dictionary: '/N 1 /First 5 /Filter /FlateDecode /DecodeParms null',
    },
  ];

  for (const { label, dictionary } of cases) {
    await assertObjectStreamResourceRejected(
      await objectStreamFixture(dictionary),
      label,
    );
  }
});

void test('fails closed for missing, indirect, or invalid object stream metadata', async () => {
  const cases = [
    { label: 'missing N', dictionary: '/First 5' },
    { label: 'missing First', dictionary: '/N 1' },
    { label: 'indirect N', dictionary: '/N 999 0 R /First 5' },
    { label: 'indirect First', dictionary: '/N 1 /First 999 0 R' },
    { label: 'negative N', dictionary: '/N -1 /First 5' },
    { label: 'fractional First', dictionary: '/N 1 /First 4.5' },
    { label: 'First beyond payload', dictionary: '/N 1 /First 999' },
  ];

  for (const { label, dictionary } of cases) {
    await assertObjectStreamRejected(
      await objectStreamFixture(dictionary),
      'object_stream_metadata_invalid',
      label,
    );
  }
});

void test('fails closed for invalid object stream headers and offsets', async () => {
  const cases = [
    {
      label: 'non-integer header offset',
      dictionary: '/N 1 /First 5',
      payload: '99 X << /Type /AuditMarker >>',
    },
    {
      label: 'offset beyond payload',
      dictionary: '/N 1 /First 7',
      payload: '99 999 << /Type /AuditMarker >>',
    },
    {
      label: 'non-increasing offsets',
      dictionary: '/N 2 /First 11',
      payload: '99 0 100 0 << /Type /AuditMarker >> << /Type /AuditMarker >>',
    },
    {
      label: 'duplicate object numbers',
      dictionary: '/N 2 /First 10',
      payload: '99 0 99 2 << /Type /AuditMarker >> << /Type /AuditMarker >>',
    },
  ];

  for (const { label, dictionary, payload } of cases) {
    await assertObjectStreamRejected(
      await objectStreamFixture(dictionary, payload),
      'object_stream_header_invalid',
      label,
    );
  }
});

void test('fails closed before expanding an excessive object stream object count', async () => {
  await assertObjectStreamResourceRejected(
    await objectStreamFixture('/N 200001 /First 5'),
    'object count budget',
  );
});

void test('rejects a compressed object-stream bomb before pdf-lib parsing', async () => {
  const fixture = await compressedObjectStreamBomb();
  assert.ok(fixture.compressedBytes < 64 * 1024);
  assert.equal(fixture.decodedBytes, 17 * 1024 * 1024);
  await assertObjectStreamResourceRejected(
    fixture.bytes,
    'decoded byte budget',
  );

  const inspection = await inspectPdf(await ordinaryFormPdf());
  assert.equal(inspection.pageCount, 1);
});

void test('bounds single and cumulative ordinary Flate streams before parsing', async () => {
  const source = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(source, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const firstObjectNumber = parsed.context.largestObjectNumber + 1;

  const single = appendCompressedOrdinaryStream(
    source,
    root,
    firstObjectNumber,
    25 * 1024 * 1024,
  );
  assert.ok(single.compressedBytes < 64 * 1024);
  await assertObjectStreamResourceRejected(single.bytes, 'single Flate budget');

  let cumulative = source;
  for (let index = 0; index < 5; index += 1) {
    cumulative = appendCompressedOrdinaryStream(
      cumulative,
      root,
      firstObjectNumber + index,
      20 * 1024 * 1024,
    ).bytes;
  }
  await assertObjectStreamResourceRejected(
    cumulative,
    'cumulative Flate budget',
  );
});

void test('rejects unbounded Flate filter chains and stream extents', async () => {
  const source = await ordinaryFormPdf();
  const parsed = await PDFDocument.load(source, { updateMetadata: false });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const objectNumber = parsed.context.largestObjectNumber + 1;
  const supportedChain = appendCompressedOrdinaryStream(
    source,
    root,
    objectNumber,
    1_024,
    {
      ascii85: true,
      filter: '[/ASCII85Decode /FlateDecode]',
    },
  );
  assert.equal((await inspectPdf(supportedChain.bytes)).pageCount, 1);

  const cases = [
    {
      label: 'nested filter chain',
      options: { filter: '[/ASCII85Decode /FlateDecode]' },
    },
    {
      label: 'false direct length',
      options: { length: '1' },
    },
    {
      label: 'indirect length',
      options: { length: '999 0 R' },
    },
  ] as const;

  for (const { label, options } of cases) {
    const fixture = appendCompressedOrdinaryStream(
      source,
      root,
      objectNumber,
      1_024,
      options,
    );
    await assertObjectStreamResourceRejected(fixture.bytes, label);
  }
});

void test('fails closed when the final revision boundary cannot be verified', async () => {
  const source = concatenate(
    await ordinaryFormPdf(),
    new TextEncoder().encode('\nstartxref\n0\n%%EOF\n'),
  );
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, [
    'final_revision_boundary_unverified',
    'revision_xref_offset_invalid',
  ]);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed for an unmarked historical xref stream', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 200]);
  const field = document.getForm().createTextField(FIELD_NAME);
  field.addToPage(page, {
    x: 30,
    y: 100,
    width: 220,
    height: 24,
    borderColor: rgb(0, 0, 0),
  });
  const signature = document.context.obj({
    Type: PDFName.of('Sig'),
    ByteRange: document.context.obj([0, 10, 20, 10]),
    Contents: PDFHexString.of('00'),
  });
  const signatureReference = document.context.register(signature);
  const firstRevision = await document.save({ useObjectStreams: true });
  const firstRevisionText = new TextDecoder('latin1').decode(firstRevision);
  const markerStart = firstRevisionText.lastIndexOf('startxref');
  assert.ok(markerStart > 0);
  const originalXrefOffset = lastStartXref(firstRevision);
  const withoutMarker = firstRevision.subarray(0, markerStart);

  const parsed = await PDFDocument.load(firstRevision, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const prefix = new TextEncoder().encode('\n');
  const objectOffset = withoutMarker.byteLength + prefix.byteLength;
  const object = new TextEncoder().encode(
    `${signatureReference.objectNumber} 0 obj\n<< /Type /HiddenOldSignature >>\nendobj\n`,
  );
  const xrefOffset = objectOffset + object.byteLength;
  const tail = new TextEncoder().encode(
    `xref\n${signatureReference.objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size ${parsed.context.largestObjectNumber + 1} /Root ${root.toString()} /Prev ${originalXrefOffset} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  const source = concatenate(withoutMarker, prefix, object, tail);
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.deepEqual(inspection.protection.evidence.historyScanIssues, [
    'unmarked_xref_stream',
  ]);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('does not accept a non-leading fake linearization dictionary', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 200]);
  const field = document.getForm().createTextField(FIELD_NAME);
  field.addToPage(page, {
    x: 30,
    y: 100,
    width: 220,
    height: 24,
    borderColor: rgb(0, 0, 0),
  });
  const signatureReference = document.context.register(
    document.context.obj({
      Type: PDFName.of('Sig'),
      ByteRange: document.context.obj([0, 10, 20, 10]),
      Contents: PDFHexString.of('00'),
    }),
  );
  document.context.register(
    document.context.obj({
      Linearized: 1,
      L: 1,
      O: 1,
      E: 1,
      N: 1,
      T: 1,
      H: document.context.obj([0, 0]),
    }),
  );
  const firstRevision = await document.save({ useObjectStreams: true });
  const firstRevisionText = new TextDecoder('latin1').decode(firstRevision);
  const markerStart = firstRevisionText.lastIndexOf('startxref');
  assert.ok(markerStart > 0);
  const originalXrefOffset = lastStartXref(firstRevision);
  const fakeLinearizedRevision = concatenate(
    firstRevision.subarray(0, markerStart),
    new TextEncoder().encode('startxref\n0\n%%EOF\n'),
  );
  const parsed = await PDFDocument.load(fakeLinearizedRevision, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  const prefix = new TextEncoder().encode('\n');
  const objectOffset = fakeLinearizedRevision.byteLength + prefix.byteLength;
  const object = new TextEncoder().encode(
    `${signatureReference.objectNumber} 0 obj\n<< /Type /HiddenOldSignature >>\nendobj\n`,
  );
  const xrefOffset = objectOffset + object.byteLength;
  const tail = new TextEncoder().encode(
    `xref\n${signatureReference.objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size ${parsed.context.largestObjectNumber + 1} /Root ${root.toString()} /Prev ${originalXrefOffset} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  const source = concatenate(fakeLinearizedRevision, prefix, object, tail);
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  const historyScanIssues =
    inspection.protection.evidence.historyScanIssues ?? [];
  assert.equal(
    historyScanIssues.includes('revision_xref_offset_invalid'),
    true,
  );
  assert.equal(historyScanIssues.includes('unmarked_xref_stream'), true);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed when a stream Type is an indirect reference', async () => {
  const document = await PDFDocument.create();
  document.addPage([400, 200]);
  const signatureReference = document.context.register(
    document.context.obj({
      Type: PDFName.of('Sig'),
      ByteRange: document.context.obj([0, 10, 20, 10]),
      Contents: PDFHexString.of('00'),
    }),
  );
  const firstRevision = await document.save({ useObjectStreams: true });
  const firstRevisionText = new TextDecoder('latin1').decode(firstRevision);
  const markerStart = firstRevisionText.lastIndexOf('startxref');
  assert.ok(markerStart > 0);
  const originalXrefOffset = lastStartXref(firstRevision);
  const typeOffset = firstRevisionText.indexOf(
    '/Type /XRef',
    originalXrefOffset,
  );
  assert.ok(typeOffset > originalXrefOffset);
  const patched = Uint8Array.from(firstRevision);
  const indirectType = new TextEncoder().encode('/Type 9 0 R');
  assert.equal(indirectType.byteLength, '/Type /XRef'.length);
  patched.set(indirectType, typeOffset);
  const withoutMarker = patched.subarray(0, markerStart);

  const parsed = await PDFDocument.load(firstRevision, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);
  assert.ok(parsed.context.largestObjectNumber < 9);
  const prefix = new TextEncoder().encode('\n9 0 obj\n/XRef\nendobj\n');
  const typeObjectOffset = withoutMarker.byteLength + 1;
  const objectOffset = withoutMarker.byteLength + prefix.byteLength;
  const object = new TextEncoder().encode(
    `${signatureReference.objectNumber} 0 obj\n<< /Type /HiddenOldSignature >>\nendobj\n`,
  );
  const xrefOffset = objectOffset + object.byteLength;
  const tail = new TextEncoder().encode(
    `xref\n${signatureReference.objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
      `9 1\n${String(typeObjectOffset).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size 10 /Root ${root.toString()} /Prev ${originalXrefOffset} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  const source = concatenate(withoutMarker, prefix, object, tail);
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.equal(
    inspection.protection.evidence.historyScanIssues?.includes(
      'stream_type_indirect',
    ),
    true,
  );
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('accepts bounded PDF number spellings for a verified linearization dictionary', async () => {
  for (const value of ['1.0', '+1.0', '1.', '+01.000']) {
    const source = syntheticLinearizedPdf(value);
    const document = await PDFDocument.load(source, {
      updateMetadata: false,
    });
    assert.equal(document.getPageCount(), 1);

    const inspection = await inspectPdf(source);
    assert.equal(inspection.protection.protectionType, 'none');
    assert.equal(inspection.protection.evidence.revisionMarkerCount, 1);
    assert.equal(inspection.protection.evidence.historyScanComplete, true);
    assert.deepEqual(inspection.protection.evidence.historyScanIssues, []);
  }
});

void test('does not broaden the linearization exception beyond numeric one', async () => {
  const source = syntheticLinearizedPdf('1.0001');
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.equal(
    inspection.protection.evidence.historyScanIssues?.includes(
      'revision_xref_offset_invalid',
    ),
    true,
  );
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('does not use a hybrid xref declaration to allowlist hidden history', async () => {
  const document = await PDFDocument.create();
  document.addPage([400, 200]);
  const signatureReference = document.context.register(
    document.context.obj({
      Type: PDFName.of('Sig'),
      ByteRange: document.context.obj([0, 10, 20, 10]),
      Contents: PDFHexString.of('00'),
    }),
  );
  const firstRevision = await document.save({ useObjectStreams: true });
  const firstRevisionText = new TextDecoder('latin1').decode(firstRevision);
  const markerStart = firstRevisionText.lastIndexOf('startxref');
  assert.ok(markerStart > 0);
  const originalXrefOffset = lastStartXref(firstRevision);
  const withoutMarker = firstRevision.subarray(0, markerStart);
  const parsed = await PDFDocument.load(firstRevision, {
    updateMetadata: false,
  });
  const root = parsed.context.trailerInfo.Root;
  assert.ok(root instanceof PDFRef);

  const prefix = new TextEncoder().encode('\n');
  const objectOffset = withoutMarker.byteLength + prefix.byteLength;
  const object = new TextEncoder().encode(
    `${signatureReference.objectNumber} 0 obj\n<< /Type /HiddenOldSignature >>\nendobj\n`,
  );
  const xrefOffset = objectOffset + object.byteLength;
  const tail = new TextEncoder().encode(
    `xref\n${signatureReference.objectNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
      `trailer\n<< /Size ${parsed.context.largestObjectNumber + 1} /Root ${root.toString()} /Prev ${originalXrefOffset} /XRefStm ${originalXrefOffset} >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  const source = concatenate(withoutMarker, prefix, object, tail);
  await PDFDocument.load(source, { updateMetadata: false });

  const inspection = await inspectPdf(source);
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.historyScanComplete, false);
  assert.equal(
    inspection.protection.evidence.historyScanIssues?.includes(
      'hybrid_xref_unverified',
    ),
    true,
  );
  assert.deepEqual(inspection.protection.evidence.unknownStructures, [
    'historical_scan_inconclusive',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});
