import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  StandardFonts,
  rgb,
} from 'pdf-lib';

import type { PdfEngineErrorCode, PdfFieldValue } from '../lib/pdf-engine';

const { applyApprovedValues, inspectPdf, PdfEngineError } = (await import(
  new URL('../lib/pdf-engine.ts', import.meta.url).href
)) as typeof import('../lib/pdf-engine');

const FIELD = {
  legalName: 'frm.q7f1',
  email: 'frm.p0x4',
  contact: 'frm.m2k9',
  consent: 'frm.c8v3',
  housing: 'frm.r4d6',
  caseId: 'frm.s1u2',
  support: 'frm.l9n5',
  notes: 'frm.t3w8',
  witness: 'frm.h6b0',
  status: 'frm.f2e4',
  signature: 'frm.z5a7',
} as const;

const CHOICE_FIELD = {
  multiDropdown: 'choice.multi-dropdown',
  singleDropdown: 'choice.single-dropdown',
  optionList: 'choice.option-list',
  singleOptionList: 'choice.single-option-list',
  radio: 'choice.radio',
} as const;

interface ChoicePair {
  value: string;
  label: string;
}

function setPairedChoices(
  field: PDFDropdown | PDFOptionList,
  choices: readonly ChoicePair[],
): void {
  field.acroField.setOptions(
    choices.map(({ value, label }) => ({
      value: PDFHexString.fromText(value),
      display: PDFHexString.fromText(label),
    })),
  );
}

function setCanonicalChoiceValues(
  field: PDFDropdown | PDFOptionList,
  choices: readonly ChoicePair[],
  values: readonly string[],
): void {
  const dictionary = field.acroField.dict;
  const encoded = values.map((value) => PDFHexString.fromText(value));

  if (encoded.length === 0) {
    dictionary.delete(PDFName.of('V'));
    dictionary.delete(PDFName.of('I'));
  } else if (encoded.length === 1) {
    dictionary.set(PDFName.of('V'), encoded[0]);
    dictionary.delete(PDFName.of('I'));
  } else {
    dictionary.set(PDFName.of('V'), dictionary.context.obj(encoded));
    const indices = values
      .map((value) => choices.findIndex((choice) => choice.value === value))
      .sort((left, right) => left - right);
    dictionary.set(PDFName.of('I'), dictionary.context.obj(indices));
  }
}

async function choiceCompatibilityBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const dropdownChoices = [
    { value: 'north', label: 'North district' },
    { value: 'south', label: 'South district' },
    { value: 'west', label: 'West district' },
  ] as const;
  const listChoices = [
    { value: 'red', label: 'Red priority' },
    { value: 'green', label: 'Green priority' },
    { value: 'blue', label: 'Blue priority' },
  ] as const;

  const multiDropdown = form.createDropdown(CHOICE_FIELD.multiDropdown);
  setPairedChoices(multiDropdown, dropdownChoices);
  multiDropdown.enableMultiselect();
  multiDropdown.select(['North district', 'West district']);
  multiDropdown.addToPage(page, {
    x: 40,
    y: 700,
    width: 220,
    height: 24,
    font,
  });

  const singleDropdown = form.createDropdown(CHOICE_FIELD.singleDropdown);
  setPairedChoices(singleDropdown, dropdownChoices);
  singleDropdown.select('North district');
  singleDropdown.addToPage(page, {
    x: 300,
    y: 700,
    width: 220,
    height: 24,
    font,
  });

  const optionList = form.createOptionList(CHOICE_FIELD.optionList);
  setPairedChoices(optionList, listChoices);
  optionList.enableMultiselect();
  optionList.select(['Red priority', 'Blue priority']);
  optionList.addToPage(page, {
    x: 40,
    y: 580,
    width: 220,
    height: 90,
    font,
  });

  const singleOptionList = form.createOptionList(CHOICE_FIELD.singleOptionList);
  setPairedChoices(singleOptionList, listChoices);
  singleOptionList.select('Green priority');
  singleOptionList.addToPage(page, {
    x: 300,
    y: 520,
    width: 220,
    height: 90,
    font,
  });

  const radio = form.createRadioGroup(CHOICE_FIELD.radio);
  radio.addOptionToPage('ground', page, {
    x: 300,
    y: 640,
    width: 18,
    height: 18,
    borderColor: rgb(0.25, 0.31, 0.42),
  });
  radio.addOptionToPage('air', page, {
    x: 360,
    y: 640,
    width: 18,
    height: 18,
    borderColor: rgb(0.25, 0.31, 0.42),
  });
  radio.select('ground');

  form.updateFieldAppearances(font);
  setCanonicalChoiceValues(multiDropdown, dropdownChoices, ['north', 'west']);
  setCanonicalChoiceValues(singleDropdown, dropdownChoices, ['north']);
  setCanonicalChoiceValues(optionList, listChoices, ['red', 'blue']);
  setCanonicalChoiceValues(singleOptionList, listChoices, ['green']);

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

const ENCRYPTED_PDF_BASE64 =
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDM1YzY5Y2I1ZTA+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA3MiA3MiBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1YgMgovUiAzCi9MZW5ndGggMTI4Ci9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDBlNTIyOTI1YTNlNGU4NzRjM2NmYWNiZWY1MTFhNzNhYzRlYzJiZDg2NWRjZDNkNDYyNzYxNDkxN2FiZmQ3ZTQ+Ci9VIDxiNjIzNzAzMjY3YTBjODJlMzliYmIwMTc0YTVlODUzNDI4YmY0ZTVlNGU3NThhNDE2NDAwNGU1NmZmZmEwMTA4Pgo+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNTkgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAowMDAwMDAwMTY3IDAwMDAwIG4gCjAwMDAwMDAyNTkgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDw2NDY2NjM2MTY2MzUzNDMyMzczOTMwMzMzMjMwMzY2NDY0MzEzMTM0MzQzMTY0MzA2MjM1NjI2MTM5MzYzMTYyPiA8NjQ2NjM2MTY2MzUzNDMyMzczOTMwMzMzMjMwMzY2NDY0MzEzMTM0MzQzMTY0MzA2MjM1NjI2MTM5MzYzMTYyPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzQKJSVFT0YK';

async function demoBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(new URL('../public/demo-form.pdf', import.meta.url)),
  );
}

async function expectEngineError(
  operation: Promise<unknown>,
  code: PdfEngineErrorCode,
  fieldName?: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof PdfEngineError);
    assert.equal(error.code, code);
    assert.equal(error.fieldName, fieldName);
    return true;
  });
}

void test('inspects canonical AcroForm fields, widgets, geometry, and policies', async () => {
  const inspection = await inspectPdf(await demoBytes());

  assert.match(inspection.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal(inspection.pageCount, 2);
  assert.equal(inspection.fieldCount, 11);
  assert.equal(inspection.widgetCount, 13);

  const fields = new Map(inspection.fields.map((field) => [field.name, field]));
  assert.deepEqual([...fields.keys()], Object.values(FIELD));

  assert.deepEqual(
    {
      type: fields.get(FIELD.legalName)?.type,
      required: fields.get(FIELD.legalName)?.required,
      maxLength: fields.get(FIELD.legalName)?.maxLength,
      page: fields.get(FIELD.legalName)?.page,
      tooltip: fields.get(FIELD.legalName)?.tooltip,
    },
    {
      type: 'text',
      required: true,
      maxLength: 64,
      page: 1,
      tooltip: 'Legal name',
    },
  );
  assert.deepEqual(fields.get(FIELD.contact)?.options, [
    'Email',
    'Phone',
    'Text message',
  ]);
  assert.deepEqual(fields.get(FIELD.contact)?.choices, [
    { value: 'Email', label: 'Email' },
    { value: 'Phone', label: 'Phone' },
    { value: 'Text message', label: 'Text message' },
  ]);
  assert.equal(fields.get(FIELD.contact)?.multiSelect, false);
  assert.deepEqual(fields.get(FIELD.housing)?.options, [
    'rent',
    'own',
    'other',
  ]);
  assert.deepEqual(fields.get(FIELD.housing)?.choices, [
    { value: 'rent', label: 'rent' },
    { value: 'own', label: 'own' },
    { value: 'other', label: 'other' },
  ]);
  assert.equal(fields.get(FIELD.housing)?.multiSelect, false);
  assert.equal(fields.get(FIELD.housing)?.widgetCount, 3);
  assert.ok(
    fields
      .get(FIELD.housing)
      ?.widgets.every((widget) => widget.page === 1 && widget.hasAppearance),
  );
  assert.deepEqual(fields.get(FIELD.support)?.options, [
    'Rent assistance',
    'Utilities',
    'Food access',
    'Transportation',
  ]);
  assert.equal(fields.get(FIELD.support)?.multiSelect, true);
  assert.equal(fields.get(FIELD.support)?.page, 2);
  assert.equal(fields.get(FIELD.caseId)?.readOnly, true);
  assert.equal(fields.get(FIELD.status)?.readOnly, true);
  assert.equal(fields.get(FIELD.witness)?.humanOnly, true);
  assert.equal(fields.get(FIELD.signature)?.type, 'signature');
  assert.equal(fields.get(FIELD.signature)?.humanOnly, true);
  assert.equal(fields.get(FIELD.signature)?.widgets[0]?.hasAppearance, false);
  assert.ok(
    inspection.warnings.some(
      (warning) =>
        warning.code === 'SIGNATURE_FIELD_HUMAN_ONLY' &&
        warning.fieldName === FIELD.signature,
    ),
  );
});

void test('preserves export values for paired choices and writes multiselect arrays', async () => {
  const source = await choiceCompatibilityBytes();
  const initial = await inspectPdf(source);
  const initialFields = new Map(
    initial.fields.map((field) => [field.name, field]),
  );

  assert.deepEqual(initialFields.get(CHOICE_FIELD.multiDropdown)?.current, [
    'north',
    'west',
  ]);
  assert.deepEqual(initialFields.get(CHOICE_FIELD.multiDropdown)?.options, [
    'north',
    'south',
    'west',
  ]);
  assert.deepEqual(initialFields.get(CHOICE_FIELD.multiDropdown)?.choices, [
    { value: 'north', label: 'North district' },
    { value: 'south', label: 'South district' },
    { value: 'west', label: 'West district' },
  ]);
  assert.equal(
    initialFields.get(CHOICE_FIELD.multiDropdown)?.multiSelect,
    true,
  );
  assert.equal(
    initialFields.get(CHOICE_FIELD.singleDropdown)?.current,
    'north',
  );
  assert.equal(
    initialFields.get(CHOICE_FIELD.singleDropdown)?.multiSelect,
    false,
  );
  assert.deepEqual(initialFields.get(CHOICE_FIELD.optionList)?.current, [
    'red',
    'blue',
  ]);
  assert.deepEqual(initialFields.get(CHOICE_FIELD.optionList)?.choices, [
    { value: 'red', label: 'Red priority' },
    { value: 'green', label: 'Green priority' },
    { value: 'blue', label: 'Blue priority' },
  ]);
  assert.equal(initialFields.get(CHOICE_FIELD.optionList)?.multiSelect, true);
  assert.equal(
    initialFields.get(CHOICE_FIELD.singleOptionList)?.current,
    'green',
  );
  assert.equal(
    initialFields.get(CHOICE_FIELD.singleOptionList)?.multiSelect,
    false,
  );
  assert.deepEqual(initialFields.get(CHOICE_FIELD.radio)?.choices, [
    { value: 'ground', label: 'ground' },
    { value: 'air', label: 'air' },
  ]);
  assert.equal(initialFields.get(CHOICE_FIELD.radio)?.multiSelect, false);

  const result = await applyApprovedValues(source, {
    [CHOICE_FIELD.multiDropdown]: ['south', 'west'],
    [CHOICE_FIELD.singleDropdown]: 'south',
    [CHOICE_FIELD.optionList]: ['green', 'blue'],
    [CHOICE_FIELD.singleOptionList]: 'red',
    [CHOICE_FIELD.radio]: 'air',
  });
  const output = await inspectPdf(result.bytes);
  const outputFields = new Map(
    output.fields.map((field) => [field.name, field]),
  );

  assert.deepEqual(outputFields.get(CHOICE_FIELD.multiDropdown)?.current, [
    'south',
    'west',
  ]);
  assert.equal(outputFields.get(CHOICE_FIELD.singleDropdown)?.current, 'south');
  assert.deepEqual(outputFields.get(CHOICE_FIELD.optionList)?.current, [
    'green',
    'blue',
  ]);
  assert.equal(outputFields.get(CHOICE_FIELD.singleOptionList)?.current, 'red');
  assert.equal(outputFields.get(CHOICE_FIELD.radio)?.current, 'air');
  assert.deepEqual(
    outputFields.get(CHOICE_FIELD.singleDropdown)?.choices,
    initialFields.get(CHOICE_FIELD.singleDropdown)?.choices,
  );
  assert.ok(result.verifiedFields.every((field) => field.appearanceVerified));

  const reopened = await PDFDocument.load(result.bytes, {
    updateMetadata: false,
  });
  const reopenedForm = reopened.getForm();
  assert.deepEqual(
    reopenedForm
      .getDropdown(CHOICE_FIELD.multiDropdown)
      .acroField.getValues()
      .map((value) => value.decodeText()),
    ['south', 'west'],
  );
  assert.deepEqual(
    reopenedForm
      .getDropdown(CHOICE_FIELD.singleDropdown)
      .acroField.getValues()
      .map((value) => value.decodeText()),
    ['south'],
  );
  assert.deepEqual(
    reopenedForm
      .getOptionList(CHOICE_FIELD.optionList)
      .acroField.getValues()
      .map((value) => value.decodeText()),
    ['green', 'blue'],
  );
  assert.deepEqual(
    reopenedForm
      .getOptionList(CHOICE_FIELD.singleOptionList)
      .acroField.getValues()
      .map((value) => value.decodeText()),
    ['red'],
  );
  assert.equal(
    reopenedForm.getRadioGroup(CHOICE_FIELD.radio).getSelected(),
    'air',
  );
});

void test('normalizes empty and single choice values from field multiplicity', async () => {
  const source = await choiceCompatibilityBytes();
  const cleared = await applyApprovedValues(source, {
    [CHOICE_FIELD.multiDropdown]: null,
    [CHOICE_FIELD.singleDropdown]: null,
    [CHOICE_FIELD.optionList]: null,
    [CHOICE_FIELD.singleOptionList]: null,
  });
  const clearedInspection = await inspectPdf(cleared.bytes);
  const clearedFields = new Map(
    clearedInspection.fields.map((field) => [field.name, field]),
  );
  const clearedVerified = new Map(
    cleared.verifiedFields.map((field) => [field.name, field]),
  );

  assert.deepEqual(clearedFields.get(CHOICE_FIELD.multiDropdown)?.current, []);
  assert.deepEqual(clearedFields.get(CHOICE_FIELD.optionList)?.current, []);
  assert.equal(clearedFields.get(CHOICE_FIELD.singleDropdown)?.current, null);
  assert.equal(clearedFields.get(CHOICE_FIELD.singleOptionList)?.current, null);
  assert.deepEqual(clearedVerified.get(CHOICE_FIELD.multiDropdown)?.value, []);
  assert.deepEqual(clearedVerified.get(CHOICE_FIELD.optionList)?.value, []);

  const selected = await applyApprovedValues(source, {
    [CHOICE_FIELD.multiDropdown]: ['south'],
    [CHOICE_FIELD.singleDropdown]: 'south',
    [CHOICE_FIELD.optionList]: ['green'],
    [CHOICE_FIELD.singleOptionList]: 'green',
  });
  const selectedInspection = await inspectPdf(selected.bytes);
  const selectedFields = new Map(
    selectedInspection.fields.map((field) => [field.name, field]),
  );

  assert.deepEqual(selectedFields.get(CHOICE_FIELD.multiDropdown)?.current, [
    'south',
  ]);
  assert.deepEqual(selectedFields.get(CHOICE_FIELD.optionList)?.current, [
    'green',
  ]);
  assert.equal(
    selectedFields.get(CHOICE_FIELD.singleDropdown)?.current,
    'south',
  );
  assert.equal(
    selectedFields.get(CHOICE_FIELD.singleOptionList)?.current,
    'green',
  );
});

void test('enforces choice input shape and export values from multiplicity', async () => {
  const source = await choiceCompatibilityBytes();

  await expectEngineError(
    applyApprovedValues(source, {
      [CHOICE_FIELD.singleDropdown]: 'South district',
    }),
    'FIELD_OPTION_INVALID',
    CHOICE_FIELD.singleDropdown,
  );
  await expectEngineError(
    applyApprovedValues(source, {
      [CHOICE_FIELD.singleDropdown]: ['north'],
    }),
    'FIELD_VALUE_TYPE_INVALID',
    CHOICE_FIELD.singleDropdown,
  );
  await expectEngineError(
    applyApprovedValues(source, {
      [CHOICE_FIELD.singleOptionList]: ['red'],
    }),
    'FIELD_VALUE_TYPE_INVALID',
    CHOICE_FIELD.singleOptionList,
  );
  await expectEngineError(
    applyApprovedValues(source, {
      [CHOICE_FIELD.multiDropdown]: 'south',
    }),
    'FIELD_VALUE_TYPE_INVALID',
    CHOICE_FIELD.multiDropdown,
  );
  await expectEngineError(
    applyApprovedValues(source, {
      [CHOICE_FIELD.optionList]: 'green',
    }),
    'FIELD_VALUE_TYPE_INVALID',
    CHOICE_FIELD.optionList,
  );
});

void test('applies only approved values to a fresh interactive copy and reopens it', async () => {
  const source = await demoBytes();
  const sourceSnapshot = Uint8Array.from(source);
  const original = await inspectPdf(source);
  const values: Record<string, PdfFieldValue> = {
    [FIELD.legalName]: 'Ada Lovelace',
    [FIELD.email]: 'ada@example.test',
    [FIELD.contact]: 'Phone',
    [FIELD.consent]: true,
    [FIELD.housing]: 'rent',
    [FIELD.support]: ['Utilities', 'Transportation'],
    [FIELD.notes]: 'Needs a follow-up call.',
  };

  const result = await applyApprovedValues(source, values);
  const output = await inspectPdf(result.bytes);
  const reopenedDocument = await PDFDocument.load(result.bytes, {
    updateMetadata: false,
  });
  const reopenedForm = reopenedDocument.getForm();
  const outputFields = new Map(
    output.fields.map((field) => [field.name, field]),
  );

  assert.deepEqual(
    source,
    sourceSnapshot,
    'source bytes must never be mutated',
  );
  assert.equal(result.sourceHash, original.sourceHash);
  assert.equal(result.outputHash, output.sourceHash);
  assert.notEqual(result.outputHash, result.sourceHash);
  assert.equal(result.fieldCount, 11);
  assert.equal(result.widgetCount, 13);
  assert.equal(result.verifiedFields.length, Object.keys(values).length);
  assert.ok(result.verifiedFields.every((field) => field.appearanceVerified));
  assert.equal(outputFields.get(FIELD.legalName)?.current, 'Ada Lovelace');
  assert.equal(outputFields.get(FIELD.email)?.current, 'ada@example.test');
  assert.equal(outputFields.get(FIELD.contact)?.current, 'Phone');
  assert.equal(outputFields.get(FIELD.consent)?.current, true);
  assert.equal(outputFields.get(FIELD.housing)?.current, 'rent');
  assert.deepEqual(outputFields.get(FIELD.support)?.current, [
    'Utilities',
    'Transportation',
  ]);
  assert.equal(
    outputFields.get(FIELD.notes)?.current,
    'Needs a follow-up call.',
  );
  assert.equal(outputFields.get(FIELD.caseId)?.current, 'FP-DEMO-2042');
  assert.equal(
    outputFields.get(FIELD.status)?.current,
    'AWAITING HUMAN REVIEW',
  );
  assert.equal(outputFields.get(FIELD.witness)?.current, '');
  assert.equal(outputFields.get(FIELD.signature)?.type, 'signature');
  assert.equal(outputFields.get(FIELD.signature)?.current, null);
  for (const [fieldName, fontSize] of [
    [FIELD.legalName, 10],
    [FIELD.email, 10],
    [FIELD.contact, 10],
    [FIELD.support, 9],
    [FIELD.notes, 9],
  ] as const) {
    assert.match(
      reopenedForm.getField(fieldName).acroField.getDefaultAppearance() ?? '',
      new RegExp(`\\s${fontSize}\\s+Tf\\b`),
      `${fieldName} must preserve its source font size`,
    );
  }
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === 'SIGNATURE_FIELD_HUMAN_ONLY' &&
        warning.fieldName === FIELD.signature,
    ),
  );
});

void test('returns the exact source copy when no fields are approved', async () => {
  const source = await demoBytes();
  const result = await applyApprovedValues(source, {});

  assert.deepEqual(result.bytes, source);
  assert.equal(result.sourceHash, result.outputHash);
  assert.deepEqual(result.verifiedFields, []);
});

void test('rejects unsafe or invalid changes with stable field-scoped codes', async () => {
  const source = await demoBytes();
  const cases: Array<{
    values: Record<string, PdfFieldValue>;
    code: PdfEngineErrorCode;
    fieldName: string;
  }> = [
    {
      values: { 'frm.does-not-exist': 'value' },
      code: 'FIELD_NOT_FOUND',
      fieldName: 'frm.does-not-exist',
    },
    {
      values: { [FIELD.caseId]: 'changed' },
      code: 'FIELD_READ_ONLY',
      fieldName: FIELD.caseId,
    },
    {
      values: { [FIELD.witness]: 'AL' },
      code: 'FIELD_HUMAN_ONLY',
      fieldName: FIELD.witness,
    },
    {
      values: { [FIELD.signature]: 'Ada Lovelace' },
      code: 'FIELD_SIGNATURE_UNSUPPORTED',
      fieldName: FIELD.signature,
    },
    {
      values: { [FIELD.consent]: 'yes' },
      code: 'FIELD_VALUE_TYPE_INVALID',
      fieldName: FIELD.consent,
    },
    {
      values: { [FIELD.contact]: 'Carrier pigeon' },
      code: 'FIELD_OPTION_INVALID',
      fieldName: FIELD.contact,
    },
    {
      values: { [FIELD.housing]: 'hotel' },
      code: 'FIELD_OPTION_INVALID',
      fieldName: FIELD.housing,
    },
    {
      values: { [FIELD.legalName]: 'x'.repeat(65) },
      code: 'FIELD_VALUE_TOO_LONG',
      fieldName: FIELD.legalName,
    },
    {
      values: { [FIELD.legalName]: '李小龙' },
      code: 'FIELD_GLYPH_UNSUPPORTED',
      fieldName: FIELD.legalName,
    },
  ];

  for (const item of cases) {
    await expectEngineError(
      applyApprovedValues(source, item.values),
      item.code,
      item.fieldName,
    );
  }
});

void test('validates every requested change before mutating the fresh copy', async () => {
  const source = await demoBytes();
  const before = await inspectPdf(source);

  await expectEngineError(
    applyApprovedValues(source, {
      [FIELD.legalName]: 'Grace Hopper',
      [FIELD.contact]: 'Invalid option',
    }),
    'FIELD_OPTION_INVALID',
    FIELD.contact,
  );

  const after = await inspectPdf(source);
  assert.deepEqual(after, before);
});

void test('rejects XFA and encrypted PDFs before inspection or mutation', async () => {
  const source = await demoBytes();
  const document = await PDFDocument.load(source, { updateMetadata: false });
  document
    .getForm()
    .acroForm.dict.set(PDFName.of('XFA'), PDFHexString.fromText('unsupported'));
  const xfaBytes = await document.save({ updateFieldAppearances: false });

  await expectEngineError(inspectPdf(xfaBytes), 'PDF_XFA_UNSUPPORTED');

  const encrypted = Uint8Array.from(
    Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'),
  );
  await expectEngineError(inspectPdf(encrypted), 'PDF_ENCRYPTED');
});

void test('inspects a blank signature as a human-only field', async () => {
  const inspection = await inspectPdf(await demoBytes());
  const signature = inspection.fields.find(
    (field) => field.name === FIELD.signature,
  );

  assert.equal(signature?.type, 'signature');
  assert.equal(signature?.current, null);
  assert.equal(signature?.humanOnly, true);
});

void test('rejects a signed document during inspection and apply', async () => {
  const source = await demoBytes();
  const document = await PDFDocument.load(source, { updateMetadata: false });
  const signature = document.getForm().getSignature(FIELD.signature);
  const signatureValue = document.context.obj({ Type: 'Sig' }) as PDFDict;
  signature.acroField.dict.set(PDFName.of('V'), signatureValue);
  const signedBytes = await document.save({ updateFieldAppearances: false });

  await expectEngineError(
    inspectPdf(signedBytes),
    'PDF_SIGNED_UNSUPPORTED',
    FIELD.signature,
  );
  await expectEngineError(
    applyApprovedValues(signedBytes, { [FIELD.legalName]: 'Ada Lovelace' }),
    'PDF_SIGNED_UNSUPPORTED',
    FIELD.signature,
  );
});
