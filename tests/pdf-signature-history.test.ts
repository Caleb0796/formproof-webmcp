import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib';

import {
  fingerprintPdfSignatures,
  type PdfSignatureFingerprint,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/pdf-signature-history.ts';

type TransformMethod = 'DocMDP' | 'FieldMDP' | 'Identity' | 'UR' | 'UR3';

interface FixtureOptions {
  readonly method?: TransformMethod;
  readonly attachField?: boolean;
  readonly catalogPermsKey?: 'DocMDP' | 'UR' | 'UR3' | null;
  readonly fieldName?: string;
  readonly fieldNames?: readonly string[];
  readonly permissionOrder?: readonly string[];
  readonly reverseDictionaryInsertion?: boolean;
  readonly referenceMethods?: readonly TransformMethod[];
}

function textArray(document: PDFDocument, values: readonly string[]): PDFArray {
  const array = PDFArray.withContext(document.context);
  for (const value of values) array.push(PDFString.of(value));
  return array;
}

function nameArray(document: PDFDocument, values: readonly string[]): PDFArray {
  const array = PDFArray.withContext(document.context);
  for (const value of values) array.push(PDFName.of(value));
  return array;
}

function transformParameters(
  document: PDFDocument,
  method: TransformMethod,
  options: FixtureOptions,
): PDFDict | null {
  if (method === 'Identity') return null;
  const parameters = PDFDict.withContext(document.context);
  const entries: readonly (readonly [string, PDFObject])[] =
    method === 'DocMDP'
      ? [
          ['Type', PDFName.of('TransformParams')],
          ['V', PDFName.of('1.2')],
          ['P', PDFNumber.of(2)],
        ]
      : method === 'FieldMDP'
        ? [
            ['Type', PDFName.of('TransformParams')],
            ['V', PDFName.of('1.2')],
            ['Action', PDFName.of('Include')],
            [
              'Fields',
              textArray(document, options.fieldNames ?? ['alpha', 'beta']),
            ],
          ]
        : [
            ['Type', PDFName.of('TransformParams')],
            ['V', PDFName.of(method === 'UR3' ? '2.2' : '2.0')],
            ['P', document.context.obj(true)],
            ['Msg', PDFString.of('Reader rights granted')],
            [
              'Document',
              nameArray(
                document,
                options.permissionOrder ?? ['FullSave', 'FormFilling'],
              ),
            ],
            [
              'Annots',
              nameArray(
                document,
                options.permissionOrder ?? ['Create', 'Modify'],
              ),
            ],
            [
              'Form',
              nameArray(
                document,
                options.permissionOrder ?? ['FillIn', 'Import'],
              ),
            ],
            [
              'Signature',
              nameArray(
                document,
                options.permissionOrder ?? ['Modify', 'Delete'],
              ),
            ],
            [
              'EF',
              nameArray(
                document,
                options.permissionOrder ?? ['Create', 'Import'],
              ),
            ],
          ];
  const ordered = options.reverseDictionaryInsertion
    ? [...entries].reverse()
    : entries;
  for (const [key, value] of ordered) parameters.set(PDFName.of(key), value);
  return parameters;
}

function signatureReference(
  document: PDFDocument,
  method: TransformMethod,
  options: FixtureOptions,
): PDFDict {
  const reference = PDFDict.withContext(document.context);
  const parameters = transformParameters(document, method, options);
  const data = document.context.trailerInfo.Root;
  const entries: (readonly [string, PDFObject])[] = [
    ['Type', PDFName.of('SigRef')],
    ['TransformMethod', PDFName.of(method)],
    ['DigestMethod', PDFName.of('SHA1')],
    ['DigestValue', PDFHexString.of('aabbccdd')],
    ['DigestLocation', document.context.obj([4, 32])],
  ];
  if (data instanceof PDFRef) entries.push(['Data', data]);
  if (parameters !== null) entries.push(['TransformParams', parameters]);
  const ordered = options.reverseDictionaryInsertion
    ? [...entries].reverse()
    : entries;
  for (const [key, value] of ordered) reference.set(PDFName.of(key), value);
  return reference;
}

async function signatureFixture(
  options: FixtureOptions = {},
): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  const methods = options.referenceMethods ?? [
    options.method ?? ('DocMDP' as const),
  ];
  const references = PDFArray.withContext(document.context);
  for (const method of methods) {
    references.push(signatureReference(document, method, options));
  }
  const signature = PDFDict.withContext(document.context);
  const signatureEntries: readonly (readonly [
    string,
    PDFName | PDFArray | PDFHexString,
  ])[] = [
    ['Type', PDFName.of('Sig')],
    ['Filter', PDFName.of('Adobe.PPKLite')],
    ['SubFilter', PDFName.of('adbe.pkcs7.detached')],
    ['ByteRange', document.context.obj([0, 40, 80, 120])],
    ['Contents', PDFHexString.of('010203040506')],
    ['Reference', references],
  ];
  const orderedSignatureEntries = options.reverseDictionaryInsertion
    ? [...signatureEntries].reverse()
    : signatureEntries;
  for (const [key, value] of orderedSignatureEntries) {
    signature.set(PDFName.of(key), value);
  }
  const signatureRef = document.context.register(signature);

  const fields = PDFArray.withContext(document.context);
  if (options.attachField ?? true) {
    const field = document.context.obj({
      FT: 'Sig',
      T: PDFString.of(options.fieldName ?? 'approval.signature'),
      V: signatureRef,
    }) as PDFDict;
    fields.push(document.context.register(field));
  }
  const acroFormRef = document.context.register(
    document.context.obj({ Fields: fields, SigFlags: 3 }),
  );
  document.catalog.set(PDFName.of('AcroForm'), acroFormRef);

  const catalogPermsKey =
    options.catalogPermsKey === undefined
      ? methods.includes('DocMDP')
        ? 'DocMDP'
        : methods.includes('UR3')
          ? 'UR3'
          : methods.includes('UR')
            ? 'UR'
            : null
      : options.catalogPermsKey;
  if (catalogPermsKey !== null) {
    const perms = PDFDict.withContext(document.context);
    perms.set(PDFName.of(catalogPermsKey), signatureRef);
    document.catalog.set(PDFName.of('Perms'), document.context.register(perms));
  }

  const bytes = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function onlySignature(
  snapshot: Awaited<ReturnType<typeof fingerprintPdfSignatures>>,
): PdfSignatureFingerprint {
  assert.equal(snapshot.complete, true, snapshot.issues.join(', '));
  assert.equal(snapshot.signatures.length, 1);
  const signature = snapshot.signatures[0];
  assert.notEqual(signature.fingerprint, null);
  return signature;
}

function signatureDictionary(document: PDFDocument): PDFDict {
  const acroForm = document.context.lookup(
    document.catalog.get(PDFName.of('AcroForm')),
  );
  assert.ok(acroForm instanceof PDFDict);
  const fields = document.context.lookup(acroForm.get(PDFName.of('Fields')));
  assert.ok(fields instanceof PDFArray);
  const field = fields.lookup(0);
  assert.ok(field instanceof PDFDict);
  const signature = document.context.lookup(field.get(PDFName.of('V')));
  assert.ok(signature instanceof PDFDict);
  return signature;
}

function signatureField(document: PDFDocument): PDFDict {
  const acroForm = document.context.lookup(
    document.catalog.get(PDFName.of('AcroForm')),
  );
  assert.ok(acroForm instanceof PDFDict);
  const fields = document.context.lookup(acroForm.get(PDFName.of('Fields')));
  assert.ok(fields instanceof PDFArray);
  const field = fields.lookup(0);
  assert.ok(field instanceof PDFDict);
  return field;
}

function firstReference(signature: PDFDict): PDFDict {
  const references = signature.context.lookup(
    signature.get(PDFName.of('Reference')),
  );
  assert.ok(references instanceof PDFArray);
  const reference = references.lookup(0);
  assert.ok(reference instanceof PDFDict);
  return reference;
}

function transformParams(reference: PDFDict): PDFDict {
  const parameters = reference.context.lookup(
    reference.get(PDFName.of('TransformParams')),
  );
  assert.ok(parameters instanceof PDFDict);
  return parameters;
}

void test('fingerprints the complete physical signature evidence and attachments', async () => {
  const snapshot = await fingerprintPdfSignatures(await signatureFixture());
  const signature = onlySignature(snapshot);

  assert.match(signature.identity, /^ref:\d+:0$/u);
  assert.deepEqual(signature.resolvedByteRange, [0, 40, 80, 120]);
  assert.deepEqual(signature.byteRangeRaw, {
    kind: 'direct',
    objectType: 'array',
  });
  assert.deepEqual(
    signature.byteRangeElementRaw,
    Array.from({ length: 4 }, () => ({
      kind: 'direct',
      objectType: 'number',
    })),
  );
  assert.equal(signature.contentsLength, 6);
  assert.match(signature.contentsSha256 ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(signature.type, 'Sig');
  assert.equal(signature.filter, 'Adobe.PPKLite');
  assert.equal(signature.subFilter, 'adbe.pkcs7.detached');
  assert.deepEqual(signature.roles, ['docmdp', 'document']);
  assert.deepEqual(signature.transformMethods, ['DocMDP']);
  assert.equal(signature.signedFieldAttachments.length, 1);
  assert.equal(
    signature.signedFieldAttachments[0].fieldName,
    'approval.signature',
  );
  assert.equal(signature.signedFieldAttachments[0].rawValue.kind, 'indirect');
  assert.deepEqual(signature.catalogPermsAttachments, [
    {
      permsContainer: {
        kind: 'indirect',
        reference:
          signature.catalogPermsAttachments[0].permsContainer.kind ===
          'indirect'
            ? signature.catalogPermsAttachments[0].permsContainer.reference
            : '',
      },
      key: 'DocMDP',
      rawValue: {
        kind: 'indirect',
        reference:
          signature.catalogPermsAttachments[0].rawValue.kind === 'indirect'
            ? signature.catalogPermsAttachments[0].rawValue.reference
            : '',
      },
    },
  ]);
  assert.match(signature.referenceCanonical ?? '', /"Data",\["ref","\d+:0"\]/u);
  assert.match(
    signature.referenceCanonical ?? '',
    /"DigestLocation".*"DigestMethod".*"DigestValue"/u,
  );
  assert.match(
    signature.referenceCanonical ?? '',
    /"TransformParams".*"P",\["number",2\]/u,
  );
  assert.equal(snapshot.fingerprintsByIdentity[signature.identity], signature);
});

void test('keeps A stable when B, DSS, and an ordinary field are appended', async () => {
  const document = await signatureFixture();
  const before = await fingerprintPdfSignatures(document);
  const original = onlySignature(before);

  document.catalog.set(
    PDFName.of('DSS'),
    document.context.register(
      document.context.obj({ VRI: document.context.obj({}) }),
    ),
  );
  const acroForm = document.context.lookup(
    document.catalog.get(PDFName.of('AcroForm')),
  );
  assert.ok(acroForm instanceof PDFDict);
  const fields = document.context.lookup(acroForm.get(PDFName.of('Fields')));
  assert.ok(fields instanceof PDFArray);
  fields.push(
    document.context.register(
      document.context.obj({ FT: 'Tx', T: PDFString.of('ordinary') }),
    ),
  );
  const secondSignature = document.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 20, 50, 90],
    Contents: PDFHexString.of('aabbcc'),
  }) as PDFDict;
  const secondSignatureRef = document.context.register(secondSignature);
  fields.push(
    document.context.register(
      document.context.obj({
        FT: 'Sig',
        T: PDFString.of('second.signature'),
        V: secondSignatureRef,
      }),
    ),
  );

  const after = await fingerprintPdfSignatures(document);
  assert.equal(after.complete, true, after.issues.join(', '));
  assert.equal(after.signatures.length, 2);
  assert.equal(
    after.fingerprintsByIdentity[original.identity]?.fingerprint,
    original.fingerprint,
  );
  assert.ok(
    after.signatures.some(({ signedFieldAttachments }) =>
      signedFieldAttachments.some(
        ({ fieldName }) => fieldName === 'second.signature',
      ),
    ),
  );
});

void test('changes a same-ref fingerprint for resolved and raw ByteRange redefinition', async () => {
  const resolvedDocument = await signatureFixture();
  const resolvedBefore = onlySignature(
    await fingerprintPdfSignatures(resolvedDocument),
  );
  signatureDictionary(resolvedDocument).set(
    PDFName.of('ByteRange'),
    resolvedDocument.context.obj([0, 41, 80, 120]),
  );
  const resolvedAfter = onlySignature(
    await fingerprintPdfSignatures(resolvedDocument),
  );
  assert.equal(resolvedAfter.identity, resolvedBefore.identity);
  assert.notEqual(resolvedAfter.fingerprint, resolvedBefore.fingerprint);

  const rawDocument = await signatureFixture();
  const rawBefore = onlySignature(await fingerprintPdfSignatures(rawDocument));
  const sameTupleRef = rawDocument.context.register(
    rawDocument.context.obj([0, 40, 80, 120]),
  );
  signatureDictionary(rawDocument).set(PDFName.of('ByteRange'), sameTupleRef);
  const rawAfter = onlySignature(await fingerprintPdfSignatures(rawDocument));
  assert.equal(rawAfter.identity, rawBefore.identity);
  assert.deepEqual(rawAfter.resolvedByteRange, rawBefore.resolvedByteRange);
  assert.notDeepEqual(rawAfter.byteRangeRaw, rawBefore.byteRangeRaw);
  assert.notEqual(rawAfter.fingerprint, rawBefore.fingerprint);

  const indirectDocument = await signatureFixture();
  const indirectArray = indirectDocument.context.obj([
    0, 40, 80, 120,
  ]) as PDFArray;
  const indirectArrayRef = indirectDocument.context.register(indirectArray);
  signatureDictionary(indirectDocument).set(
    PDFName.of('ByteRange'),
    indirectArrayRef,
  );
  const indirectBefore = onlySignature(
    await fingerprintPdfSignatures(indirectDocument),
  );
  indirectArray.set(1, PDFNumber.of(41));
  const indirectAfter = onlySignature(
    await fingerprintPdfSignatures(indirectDocument),
  );
  assert.equal(indirectAfter.identity, indirectBefore.identity);
  assert.deepEqual(indirectAfter.byteRangeRaw, indirectBefore.byteRangeRaw);
  assert.notDeepEqual(
    indirectAfter.resolvedByteRange,
    indirectBefore.resolvedByteRange,
  );
  assert.notEqual(indirectAfter.fingerprint, indirectBefore.fingerprint);
});

void test('changes a same-ref fingerprint for equal-length Contents replacement', async () => {
  const document = await signatureFixture();
  const before = onlySignature(await fingerprintPdfSignatures(document));
  signatureDictionary(document).set(
    PDFName.of('Contents'),
    PDFHexString.of('0a0b0c0d0e0f'),
  );
  const after = onlySignature(await fingerprintPdfSignatures(document));

  assert.equal(after.identity, before.identity);
  assert.equal(after.contentsLength, before.contentsLength);
  assert.deepEqual(after.contentsRaw, before.contentsRaw);
  assert.notEqual(after.contentsSha256, before.contentsSha256);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

void test('changes a same-ref fingerprint for role, Reference, and transform redefinition', async () => {
  const roleDocument = await signatureFixture();
  const roleBefore = onlySignature(
    await fingerprintPdfSignatures(roleDocument),
  );
  const roleReference = firstReference(signatureDictionary(roleDocument));
  roleReference.set(PDFName.of('TransformMethod'), PDFName.of('FieldMDP'));
  const roleParameters = transformParams(roleReference);
  roleParameters.delete(PDFName.of('P'));
  roleParameters.set(PDFName.of('Action'), PDFName.of('All'));
  const roleAfter = onlySignature(await fingerprintPdfSignatures(roleDocument));
  assert.equal(roleAfter.identity, roleBefore.identity);
  assert.deepEqual(roleAfter.roles, ['docmdp', 'document', 'fieldmdp']);
  assert.notEqual(roleAfter.fingerprint, roleBefore.fingerprint);

  const referenceDocument = await signatureFixture();
  const referenceBefore = onlySignature(
    await fingerprintPdfSignatures(referenceDocument),
  );
  firstReference(signatureDictionary(referenceDocument)).set(
    PDFName.of('DigestValue'),
    PDFHexString.of('11223344'),
  );
  const referenceAfter = onlySignature(
    await fingerprintPdfSignatures(referenceDocument),
  );
  assert.equal(referenceAfter.identity, referenceBefore.identity);
  assert.notEqual(referenceAfter.fingerprint, referenceBefore.fingerprint);

  const paramsDocument = await signatureFixture();
  const paramsBefore = onlySignature(
    await fingerprintPdfSignatures(paramsDocument),
  );
  transformParams(firstReference(signatureDictionary(paramsDocument))).set(
    PDFName.of('P'),
    PDFNumber.of(3),
  );
  const paramsAfter = onlySignature(
    await fingerprintPdfSignatures(paramsDocument),
  );
  assert.equal(paramsAfter.identity, paramsBefore.identity);
  assert.notEqual(paramsAfter.fingerprint, paramsBefore.fingerprint);
});

void test('changes a same-ref fingerprint for field and Catalog Perms attachment redefinition', async () => {
  const fieldDocument = await signatureFixture();
  const fieldBefore = onlySignature(
    await fingerprintPdfSignatures(fieldDocument),
  );
  signatureField(fieldDocument).set(
    PDFName.of('T'),
    PDFString.of('renamed.signature'),
  );
  const fieldAfter = onlySignature(
    await fingerprintPdfSignatures(fieldDocument),
  );
  assert.equal(fieldAfter.identity, fieldBefore.identity);
  assert.notEqual(fieldAfter.fingerprint, fieldBefore.fingerprint);

  const permsDocument = await signatureFixture();
  const permsBefore = onlySignature(
    await fingerprintPdfSignatures(permsDocument),
  );
  const oldPerms = permsDocument.context.lookup(
    permsDocument.catalog.get(PDFName.of('Perms')),
  );
  assert.ok(oldPerms instanceof PDFDict);
  const signatureRef = oldPerms.get(PDFName.of('DocMDP'));
  assert.ok(signatureRef instanceof PDFRef);
  permsDocument.catalog.set(
    PDFName.of('Perms'),
    permsDocument.context.register(
      permsDocument.context.obj({ DocMDP: signatureRef }),
    ),
  );
  const permsAfter = onlySignature(
    await fingerprintPdfSignatures(permsDocument),
  );
  assert.equal(permsAfter.identity, permsBefore.identity);
  assert.notEqual(permsAfter.fingerprint, permsBefore.fingerprint);

  const rawValueDocument = await signatureFixture();
  const rawValueBefore = onlySignature(
    await fingerprintPdfSignatures(rawValueDocument),
  );
  signatureField(rawValueDocument).delete(PDFName.of('V'));
  const rawValueAfter = onlySignature(
    await fingerprintPdfSignatures(rawValueDocument),
  );
  assert.equal(rawValueAfter.identity, rawValueBefore.identity);
  assert.equal(rawValueAfter.signedFieldAttachments.length, 0);
  assert.notEqual(rawValueAfter.fingerprint, rawValueBefore.fingerprint);
});

void test('canonicalizes dictionary keys and specification-defined sets only', async () => {
  const ordered = onlySignature(
    await fingerprintPdfSignatures(
      await signatureFixture({
        method: 'UR3',
        attachField: false,
        permissionOrder: ['Create', 'Modify'],
      }),
    ),
  );
  const reordered = onlySignature(
    await fingerprintPdfSignatures(
      await signatureFixture({
        method: 'UR3',
        attachField: false,
        permissionOrder: ['Modify', 'Create'],
        reverseDictionaryInsertion: true,
      }),
    ),
  );
  assert.equal(reordered.fingerprint, ordered.fingerprint);
  assert.deepEqual(ordered.roles, ['ur3']);
  assert.match(
    ordered.referenceCanonical ?? '',
    /"TransformParams".*"Annots".*"Document".*"EF".*"Form".*"Msg".*"P".*"Signature".*"V"/u,
  );

  const fieldsOrdered = onlySignature(
    await fingerprintPdfSignatures(
      await signatureFixture({
        method: 'FieldMDP',
        catalogPermsKey: null,
        fieldNames: ['alpha', 'beta'],
      }),
    ),
  );
  const fieldsReordered = onlySignature(
    await fingerprintPdfSignatures(
      await signatureFixture({
        method: 'FieldMDP',
        catalogPermsKey: null,
        fieldNames: ['beta', 'alpha'],
        reverseDictionaryInsertion: true,
      }),
    ),
  );
  assert.equal(fieldsReordered.fingerprint, fieldsOrdered.fingerprint);
  assert.match(fieldsOrdered.referenceCanonical ?? '', /"Action".*"Fields"/u);

  const referenceOrder = onlySignature(
    await fingerprintPdfSignatures(
      await signatureFixture({
        referenceMethods: ['Identity', 'DocMDP'],
        catalogPermsKey: 'DocMDP',
      }),
    ),
  );
  const referenceReordered = onlySignature(
    await fingerprintPdfSignatures(
      await signatureFixture({
        referenceMethods: ['DocMDP', 'Identity'],
        catalogPermsKey: 'DocMDP',
      }),
    ),
  );
  assert.notEqual(referenceReordered.fingerprint, referenceOrder.fingerprint);
});

void test('returns issues and no fingerprint for cycles, unknown objects, lookup failures, and budgets', async () => {
  const cycleDocument = await signatureFixture();
  const cycleSignature = signatureDictionary(cycleDocument);
  const cycleReference = cycleSignature.context.lookup(
    cycleSignature.get(PDFName.of('Reference')),
  );
  assert.ok(cycleReference instanceof PDFArray);
  cycleReference.push(cycleReference);
  const cycleSnapshot = await fingerprintPdfSignatures(cycleDocument);
  assert.equal(cycleSnapshot.inconclusive, true);
  assert.equal(cycleSnapshot.signatures[0].fingerprint, null);
  assert.ok(
    cycleSnapshot.issues.some(
      (issue) =>
        issue.includes('canonical_direct_cycle') ||
        issue === 'physical_object_cycle',
    ),
  );

  const unknownDocument = await signatureFixture();
  firstReference(signatureDictionary(unknownDocument)).set(
    PDFName.of('VendorPayload'),
    unknownDocument.context.stream('opaque'),
  );
  const unknownSnapshot = await fingerprintPdfSignatures(unknownDocument);
  assert.equal(unknownSnapshot.inconclusive, true);
  assert.ok(
    unknownSnapshot.issues.some((issue) =>
      issue.includes('canonical_stream_unsupported'),
    ),
  );

  const missingDocument = await signatureFixture();
  firstReference(signatureDictionary(missingDocument)).set(
    PDFName.of('DigestValue'),
    PDFRef.of(65_000, 0),
  );
  const missingSnapshot = await fingerprintPdfSignatures(missingDocument);
  assert.equal(missingSnapshot.inconclusive, true);
  assert.ok(
    missingSnapshot.issues.some((issue) =>
      issue.includes('canonical_reference_lookup_failed'),
    ),
  );

  const budgetSnapshot = await fingerprintPdfSignatures(
    await signatureFixture(),
    { maxCanonicalNodes: 4 },
  );
  assert.equal(budgetSnapshot.inconclusive, true);
  assert.equal(budgetSnapshot.signatures[0].fingerprint, null);
  assert.ok(
    budgetSnapshot.issues.some((issue) =>
      issue.includes('canonical_node_limit_exceeded'),
    ),
  );
});
