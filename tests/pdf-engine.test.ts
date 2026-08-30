import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFStream,
  PDFString,
  StandardFonts,
  rgb,
} from 'pdf-lib';

import type { PdfEngineErrorCode, PdfFieldValue } from '../lib/pdf-engine';

const {
  applyApprovedValues,
  applyConfirmedDerivativeValues,
  inspectPdf,
  PdfEngineError,
} = (await import(
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

function normalAppearanceFingerprint(
  document: PDFDocument,
  fieldName: string,
): unknown {
  return document
    .getForm()
    .getField(fieldName)
    .acroField.getWidgets()
    .map((widget) => {
      const normal = widget.getAppearances()?.normal;
      if (normal instanceof PDFStream) {
        return Buffer.from(normal.getContents()).toString('base64');
      }
      if (!(normal instanceof PDFDict)) return null;
      return normal
        .keys()
        .map((key) => {
          const stream = document.context.lookup(normal.get(key));
          assert.ok(stream instanceof PDFStream);
          return [
            key.decodeText(),
            Buffer.from(stream.getContents()).toString('base64'),
          ];
        })
        .sort(([left], [right]) => left.localeCompare(right));
    });
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

async function choiceNormalizationBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const choices = [
    { value: ' ', label: 'Blank sentinel' },
    { value: 'CA', label: '   ' },
    { value: 'CA', label: 'Duplicate California' },
    { value: 'NY', label: 'New York' },
    { value: ' CA ', label: 'Padded but nonblank' },
  ] as const;

  const dropdown = form.createDropdown('normalization.dropdown');
  setPairedChoices(dropdown, choices);
  dropdown.select('Blank sentinel');
  dropdown.addToPage(page, {
    x: 40,
    y: 700,
    width: 220,
    height: 24,
    font,
  });

  const optionList = form.createOptionList('normalization.option-list');
  setPairedChoices(optionList, choices);
  optionList.enableMultiselect();
  optionList.select(['Blank sentinel', 'New York']);
  optionList.addToPage(page, {
    x: 40,
    y: 570,
    width: 220,
    height: 90,
    font,
  });

  form.updateFieldAppearances(font);
  setCanonicalChoiceValues(dropdown, choices, [' ']);
  setCanonicalChoiceValues(optionList, choices, [' ', 'NY', 'NY']);

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function signatureTextFieldsBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const signatures = [
    'Signature of Employee',
    'Signature of Preparer or Translator 0',
    'Signature of Preparer or Translator 1',
    'Signature of Preparer or Translator 2',
    'Signature of Preparer or Translator 3',
    'Signature of Emp Rep 0',
    'Signature of Emp Rep 1',
    'Signature of Emp Rep 2',
    'Signature of Employer or AR',
  ];
  const signatureDates = [
    "Today's Date mmddyyyy",
    'Sig Date mmddyyyy 0',
    'Signature Date mmddyyyy',
    'Applicant Signature Date',
  ];

  for (const [index, name] of [
    ...signatures,
    'Applicant Signature',
    ...signatureDates,
  ].entries()) {
    const field = form.createTextField(name);
    const tooltip = signatures.includes(name)
      ? `Enter Signature of ${name.replace(/^Signature of /, '')}.`
      : name === 'Applicant Signature'
        ? 'Applicant ink entry'
        : name === "Today's Date mmddyyyy"
          ? 'Enter Signature of Employer for this date.'
          : 'Enter Date of Signature as month, day, and year.';
    field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tooltip));
    field.addToPage(page, {
      x: 40,
      y: 740 - index * 44,
      width: 260,
      height: 20,
      font,
    });
  }

  form.updateFieldAppearances(font);
  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

function renameCheckBoxWidgetOnState(
  field: PDFCheckBox,
  widgetIndex: number,
  option: string,
): void {
  const widget = field.acroField.getWidgets()[widgetIndex];
  const normal = widget?.getAppearances()?.normal;
  assert.ok(widget);
  assert.ok(normal instanceof PDFDict);
  const appearance = normal.get(PDFName.of('Yes'));
  assert.ok(appearance);
  normal.delete(PDFName.of('Yes'));
  normal.set(PDFName.of(option), appearance);
}

async function recoveredRadioCheckBoxBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const field = form.createCheckBox('malformed.selection');
  const options = ['Book', 'Card', 'Both'];

  for (const [index] of options.entries()) {
    field.addToPage(page, {
      x: 40 + index * 60,
      y: 700,
      width: 18,
      height: 18,
    });
  }
  for (const [index, option] of options.entries()) {
    renameCheckBoxWidgetOnState(field, index, option);
  }

  field.acroField.dict.set(PDFName.of('V'), PDFName.of('Card'));
  for (const [index, widget] of field.acroField.getWidgets().entries()) {
    widget.setAppearanceState(PDFName.of(index === 1 ? 'Card' : 'Off'));
  }

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function sharedStateCheckBoxBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const field = form.createCheckBox('ordinary.shared-checkbox');
  field.addToPage(page, { x: 40, y: 700, width: 18, height: 18 });
  field.addToPage(page, { x: 80, y: 700, width: 18, height: 18 });
  field.check();

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function activeContentBytes(
  options: {
    highRisk?: boolean;
    orphan?: boolean;
  } = {},
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const form = document.getForm();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const field = form.createTextField('active.name');
  field.addToPage(page, {
    x: 40,
    y: 700,
    width: 220,
    height: 24,
    font,
  });
  form.updateFieldAppearances(font);

  const actionType = options.highRisk ? 'Launch' : 'JavaScript';
  const action = document.context.obj({
    S: actionType,
    JS: PDFString.of('validateWithoutExecuting();'),
    F: PDFString.of('untrusted-program'),
  }) as PDFDict;
  const actionRef = document.context.register(action);
  const additionalActions = document.context.obj({ K: actionRef }) as PDFDict;
  const additionalActionsRef = document.context.register(additionalActions);

  if (!options.orphan) {
    field.acroField.dict.set(PDFName.of('AA'), additionalActionsRef);
    document.catalog.set(PDFName.of('OpenAction'), actionRef);
    if (!options.highRisk) {
      const uri = document.context.obj({
        S: 'URI',
        URI: PDFString.of('https://example.test/'),
      }) as PDFDict;
      field.acroField.dict.set(PDFName.of('A'), document.context.register(uri));
    }
  }

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function resetFormActionBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.load(
    await activeContentBytes({ orphan: true }),
    {
      updateMetadata: false,
    },
  );
  const field = document.getForm().getTextField('active.name');
  const action = document.context.obj({ S: 'ResetForm' }) as PDFDict;
  field.acroField.dict.set(PDFName.of('A'), document.context.register(action));

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function unknownActionBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.load(
    await activeContentBytes({ orphan: true }),
    { updateMetadata: false },
  );
  const field = document.getForm().getTextField('active.name');
  const action = document.context.obj({
    Type: 'Action',
    S: 'VendorDanger',
    Payload: PDFString.of('opaque'),
  }) as PDFDict;
  field.acroField.dict.set(PDFName.of('A'), document.context.register(action));

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function actionLikeMetadataBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.load(
    await activeContentBytes({ orphan: true }),
    { updateMetadata: false },
  );
  const metadata = document.context.obj({
    Type: 'Metadata',
    S: 'Launch',
    Payload: PDFString.of('not an action'),
  }) as PDFDict;
  document.catalog.set(
    PDFName.of('VendorMetadata'),
    document.context.register(metadata),
  );

  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

function detachedSignatureDictionary(
  document: PDFDocument,
  options: {
    transformMethod?: 'UR3' | 'DocMDP';
    docMdpPermission?: 1 | 2 | 3;
  } = {},
): PDFDict {
  const signature = document.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 1, 2, 3],
    Contents: PDFHexString.of('00'),
  }) as PDFDict;

  if (options.transformMethod) {
    const transformParameters = document.context.obj({
      Type: 'TransformParams',
      V: options.transformMethod === 'UR3' ? '2.2' : '1.2',
      P:
        options.transformMethod === 'DocMDP' ? options.docMdpPermission : false,
      Form: options.transformMethod === 'UR3' ? ['FillIn'] : undefined,
    }) as PDFDict;
    const reference = document.context.obj({
      Type: 'SigRef',
      TransformMethod: options.transformMethod,
      TransformParams: transformParameters,
    }) as PDFDict;
    signature.set(PDFName.of('Reference'), document.context.obj([reference]));
  }

  return signature;
}

async function saveWithStableSignatureByteRanges(
  document: PDFDocument,
): Promise<Uint8Array> {
  let bytes = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    let signatureCount = 0;
    for (const [, object] of reopened.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      const type = reopened.context.lookup(object.get(PDFName.of('Type')));
      if (!(type instanceof PDFName) || type.decodeText() !== 'Sig') continue;
      object.set(
        PDFName.of('ByteRange'),
        reopened.context.obj([0, 1, 2, Math.max(1, bytes.byteLength - 2)]),
      );
      signatureCount += 1;
    }
    assert.ok(signatureCount > 0);
    const next = await reopened.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: false,
    });
    if (next.byteLength === bytes.byteLength) return next;
    bytes = next;
  }

  throw new Error('Synthetic signature ByteRange size did not stabilize.');
}

async function usageRightsBytes(
  options: {
    xfa?: boolean;
    omitFilter?: boolean;
    unknownTransformParameter?: boolean;
    hiddenReference?: boolean;
    sigFlags?: number;
  } = {},
): Promise<Uint8Array> {
  const document = await PDFDocument.load(await demoBytes(), {
    updateMetadata: false,
  });
  const acroForm = document.getForm().acroForm.dict;
  const signature = detachedSignatureDictionary(document, {
    transformMethod: 'UR3',
  });
  if (options.omitFilter) signature.delete(PDFName.of('Filter'));
  if (options.unknownTransformParameter) {
    const references = document.context.lookup(
      signature.get(PDFName.of('Reference')),
    );
    const reference =
      references instanceof PDFArray ? references.lookup(0) : undefined;
    const transformParameters =
      reference instanceof PDFDict
        ? document.context.lookup(reference.get(PDFName.of('TransformParams')))
        : undefined;
    assert.ok(transformParameters instanceof PDFDict);
    transformParameters.set(PDFName.of('FutureProtection'), PDFName.of('On'));
  }
  if (options.hiddenReference) {
    const references = document.context.lookup(
      signature.get(PDFName.of('Reference')),
    );
    assert.ok(references instanceof PDFArray);
    references.push(PDFString.of('hidden malformed reference'));
  }
  const signatureRef = document.context.register(signature);
  const permsRef = document.context.register(
    document.context.obj({ UR3: signatureRef }) as PDFDict,
  );
  document.catalog.set(PDFName.of('Perms'), permsRef);
  acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(options.sigFlags ?? 3));

  if (options.xfa) {
    const xfaRef = document.context.register(
      document.context.flateStream(
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"/>',
        { Type: 'EmbeddedFile' },
      ),
    );
    acroForm.set(
      PDFName.of('XFA'),
      document.context.obj([PDFString.of('template'), xfaRef]),
    );
  }

  return saveWithStableSignatureByteRanges(document);
}

async function approvalSignatureBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await demoBytes(), {
    updateMetadata: false,
  });
  const signatureRef = document.context.register(
    detachedSignatureDictionary(document),
  );
  const form = document.getForm();
  form
    .getSignature(FIELD.signature)
    .acroField.dict.set(PDFName.of('V'), signatureRef);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  return saveWithStableSignatureByteRanges(document);
}

async function docMdpBytes(permission: 1 | 2 | 3): Promise<Uint8Array> {
  const document = await PDFDocument.load(await demoBytes(), {
    updateMetadata: false,
  });
  const signatureRef = document.context.register(
    detachedSignatureDictionary(document, {
      transformMethod: 'DocMDP',
      docMdpPermission: permission,
    }),
  );
  const permsRef = document.context.register(
    document.context.obj({ DocMDP: signatureRef }) as PDFDict,
  );
  document.catalog.set(PDFName.of('Perms'), permsRef);
  document.getForm().acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  return saveWithStableSignatureByteRanges(document);
}

async function malformedDocumentSignatureBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await demoBytes(), {
    updateMetadata: false,
  });
  const signature = detachedSignatureDictionary(document);
  signature.delete(PDFName.of('ByteRange'));
  const signatureRef = document.context.register(signature);
  document
    .getForm()
    .getSignature(FIELD.signature)
    .acroField.dict.set(PDFName.of('V'), signatureRef);
  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

async function signatureReferenceVariantBytes(
  kind: 'unknown_method' | 'missing_method' | 'non_name_method',
): Promise<Uint8Array> {
  const document = await PDFDocument.load(await demoBytes(), {
    updateMetadata: false,
  });
  const signature = detachedSignatureDictionary(document);
  const reference = document.context.obj({
    Type: 'SigRef',
    TransformParams: document.context.obj({
      Type: 'TransformParams',
      V: '1.2',
      P: 2,
    }),
  }) as PDFDict;
  if (kind === 'unknown_method') {
    reference.set(PDFName.of('TransformMethod'), PDFName.of('VendorLock'));
  } else if (kind === 'non_name_method') {
    reference.set(PDFName.of('TransformMethod'), PDFString.of('DocMDP'));
  }
  signature.set(PDFName.of('Reference'), document.context.obj([reference]));
  const signatureRef = document.context.register(signature);
  const form = document.getForm();
  form
    .getSignature(FIELD.signature)
    .acroField.dict.set(PDFName.of('V'), signatureRef);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  return saveWithStableSignatureByteRanges(document);
}

async function malformedDocMdpProtectionBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await docMdpBytes(2), {
    updateMetadata: false,
  });
  const perms = document.context.lookup(
    document.catalog.get(PDFName.of('Perms')),
  );
  assert.ok(perms instanceof PDFDict);
  const signature = document.context.lookup(perms.get(PDFName.of('DocMDP')));
  assert.ok(signature instanceof PDFDict);
  const references = document.context.lookup(
    signature.get(PDFName.of('Reference')),
  );
  assert.ok(references instanceof PDFArray);
  const reference = references.lookup(0);
  assert.ok(reference instanceof PDFDict);
  reference.set(PDFName.of('Type'), PDFName.of('VendorSigRef'));
  const parameters = document.context.lookup(
    reference.get(PDFName.of('TransformParams')),
  );
  assert.ok(parameters instanceof PDFDict);
  parameters.set(PDFName.of('Type'), PDFName.of('VendorParams'));
  parameters.set(PDFName.of('FutureLock'), PDFName.of('On'));
  return saveWithStableSignatureByteRanges(document);
}

async function fieldMdpBytes(invalidAction: boolean): Promise<Uint8Array> {
  const document = await PDFDocument.load(await demoBytes(), {
    updateMetadata: false,
  });
  const root = document.context.trailerInfo.Root;
  assert.notEqual(root, undefined);
  const signature = detachedSignatureDictionary(document);
  const reference = document.context.obj({
    Type: 'SigRef',
    TransformMethod: 'FieldMDP',
    TransformParams: document.context.obj({
      Type: 'TransformParams',
      V: '1.2',
      Action: invalidAction ? 'VendorAction' : 'All',
    }),
    Data: root,
  }) as PDFDict;
  signature.set(PDFName.of('Reference'), document.context.obj([reference]));
  const signatureRef = document.context.register(signature);
  const form = document.getForm();
  form
    .getSignature(FIELD.signature)
    .acroField.dict.set(PDFName.of('V'), signatureRef);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  return saveWithStableSignatureByteRanges(document);
}

async function duplicateDocMdpBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await docMdpBytes(2), {
    updateMetadata: false,
  });
  const second = document.context.register(
    detachedSignatureDictionary(document, {
      transformMethod: 'DocMDP',
      docMdpPermission: 2,
    }),
  );
  document
    .getForm()
    .getSignature(FIELD.signature)
    .acroField.dict.set(PDFName.of('V'), second);
  return saveWithStableSignatureByteRanges(document);
}

async function singleTextFieldBytes(options: {
  readOnly?: boolean;
  sigFlags?: number;
}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  const form = document.getForm();
  const field = form.createTextField('only.text');
  if (options.readOnly) field.enableReadOnly();
  field.addToPage(page, { x: 20, y: 100, width: 120, height: 20 });
  if (options.sigFlags !== undefined) {
    form.acroForm.dict.set(
      PDFName.of('SigFlags'),
      PDFNumber.of(options.sigFlags),
    );
  }
  return document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}

type UnknownPermsKind =
  | 'empty'
  | 'not_dictionary'
  | 'unknown_key'
  | 'malformed_ur3';

async function unknownPermsBytes(kind: UnknownPermsKind): Promise<Uint8Array> {
  const document = await PDFDocument.load(await demoBytes(), {
    updateMetadata: false,
  });

  if (kind === 'not_dictionary') {
    document.catalog.set(PDFName.of('Perms'), PDFString.of('malformed'));
  } else {
    const perms =
      kind === 'empty'
        ? (document.context.obj({}) as PDFDict)
        : kind === 'unknown_key'
          ? (document.context.obj({ VendorLock: true }) as PDFDict)
          : (document.context.obj({
              UR3: PDFString.of('malformed'),
            }) as PDFDict);
    document.catalog.set(PDFName.of('Perms'), perms);
  }

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
  assert.deepEqual(inspection.protection, {
    protectionType: 'none',
    allowedMutations: [
      'inspect_fields',
      'stage_field_values',
      'create_fill_package',
      'create_filled_pdf',
    ],
    exportStrategies: ['filled_pdf', 'fill_package'],
    signatureImpact: 'none',
    requiresHumanConfirmation: false,
    evidence: {
      catalogPermsPresent: false,
      permsKeys: [],
      usageRightsKeys: [],
      byteRangeEntryCount: 0,
      malformedByteRangeCount: 0,
      byteRanges: [],
      byteRangesCoverWholeFile: null,
      signatureDictionaryCount: 0,
      usageRightsSignatureCount: 0,
      documentSignatureCount: 0,
      unclassifiedSignatureDictionaryCount: 0,
      unreachableSignatureDictionaryCount: 0,
      signatureFieldCount: 1,
      signedSignatureFieldCount: 0,
      docMdpPresent: false,
      docMdpSignatureDictionaryCount: 0,
      docMdpPermission: null,
      fieldMdpPresent: false,
      adbeExtension: null,
      xfaPresent: false,
      sigFlags: 1,
      unknownStructures: [],
      cmsIntegrity: 'not_applicable',
      signerTrust: 'not_applicable',
    },
  });

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

void test('normalizes blank and duplicate choice sentinels at the PDF boundary', async () => {
  const source = await choiceNormalizationBytes();
  const inspection = await inspectPdf(source);
  const fields = new Map(inspection.fields.map((field) => [field.name, field]));
  const expectedChoices = [
    { value: 'CA', label: 'CA' },
    { value: 'NY', label: 'New York' },
    { value: ' CA ', label: 'Padded but nonblank' },
  ];

  assert.equal(fields.get('normalization.dropdown')?.current, null);
  assert.deepEqual(
    fields.get('normalization.dropdown')?.choices,
    expectedChoices,
  );
  assert.deepEqual(fields.get('normalization.dropdown')?.options, [
    'CA',
    'NY',
    ' CA ',
  ]);
  assert.deepEqual(fields.get('normalization.option-list')?.current, ['NY']);
  assert.deepEqual(
    fields.get('normalization.option-list')?.choices,
    expectedChoices,
  );

  const initialDocument = await PDFDocument.load(source, {
    updateMetadata: false,
  });
  assert.equal(
    initialDocument
      .getForm()
      .getDropdown('normalization.dropdown')
      .isEditable(),
    false,
  );

  const applied = await applyApprovedValues(source, {
    'normalization.dropdown': 'CA',
    'normalization.option-list': ['NY', ' CA '],
  });
  const appliedInspection = await inspectPdf(applied.bytes);
  const appliedFields = new Map(
    appliedInspection.fields.map((field) => [field.name, field]),
  );
  assert.equal(appliedFields.get('normalization.dropdown')?.current, 'CA');
  assert.deepEqual(appliedFields.get('normalization.option-list')?.current, [
    'NY',
    ' CA ',
  ]);

  const appliedDocument = await PDFDocument.load(applied.bytes, {
    updateMetadata: false,
  });
  assert.equal(
    appliedDocument
      .getForm()
      .getDropdown('normalization.dropdown')
      .isEditable(),
    false,
  );
  const optionList = appliedDocument
    .getForm()
    .getOptionList('normalization.option-list');
  const rawIndices = appliedDocument.context.lookup(
    optionList.acroField.dict.get(PDFName.of('I')),
  );
  assert.ok(rawIndices instanceof PDFArray);
  assert.deepEqual(
    Array.from({ length: rawIndices.size() }, (_, index) => {
      const item = appliedDocument.context.lookup(rawIndices.get(index));
      assert.ok(item instanceof PDFNumber);
      return item.asNumber();
    }),
    [3, 4],
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

void test('does not regenerate appearances for unstaged fields', async () => {
  const source = await demoBytes();
  const beforeDocument = await PDFDocument.load(source, {
    updateMetadata: false,
  });
  const before = normalAppearanceFingerprint(beforeDocument, FIELD.consent);

  const result = await applyApprovedValues(source, {
    [FIELD.legalName]: 'Ada Lovelace',
  });
  const afterDocument = await PDFDocument.load(result.bytes, {
    updateMetadata: false,
  });

  assert.deepEqual(
    normalAppearanceFingerprint(afterDocument, FIELD.consent),
    before,
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

void test('requires human confirmation before creating a plain usage-rights derivative', async () => {
  const source = await usageRightsBytes();
  const sourceSnapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);

  assert.deepEqual(inspection.protection, {
    protectionType: 'usage_rights',
    allowedMutations: [
      'inspect_fields',
      'stage_field_values',
      'create_fill_package',
      'create_plain_derivative_pdf',
    ],
    exportStrategies: ['confirmed_plain_derivative_pdf', 'fill_package'],
    signatureImpact: 'usage_rights_removed_in_plain_derivative',
    requiresHumanConfirmation: true,
    evidence: {
      catalogPermsPresent: true,
      permsKeys: ['UR3'],
      usageRightsKeys: ['UR3'],
      byteRangeEntryCount: 1,
      malformedByteRangeCount: 0,
      byteRanges: [[0, 1, 2, source.byteLength - 2]],
      byteRangesCoverWholeFile: true,
      signatureDictionaryCount: 1,
      usageRightsSignatureCount: 1,
      documentSignatureCount: 0,
      unclassifiedSignatureDictionaryCount: 0,
      unreachableSignatureDictionaryCount: 0,
      signatureFieldCount: 1,
      signedSignatureFieldCount: 0,
      docMdpPresent: false,
      docMdpSignatureDictionaryCount: 0,
      docMdpPermission: null,
      fieldMdpPresent: false,
      adbeExtension: null,
      xfaPresent: false,
      sigFlags: 3,
      unknownStructures: [],
      cmsIntegrity: 'not_verified_in_browser',
      signerTrust: 'not_verified',
    },
  });
  assert.ok(
    inspection.warnings.some(
      (warning) => warning.code === 'USAGE_RIGHTS_DETECTED',
    ),
  );

  await expectEngineError(
    applyApprovedValues(source, { [FIELD.legalName]: 'Ada Lovelace' }),
    'PDF_DERIVATIVE_CONFIRMATION_REQUIRED',
  );
  await expectEngineError(
    applyConfirmedDerivativeValues(
      source,
      { [FIELD.legalName]: 'Ada Lovelace' },
      { humanConfirmedProtectionLoss: false },
    ),
    'PDF_DERIVATIVE_CONFIRMATION_REQUIRED',
  );

  const result = await applyConfirmedDerivativeValues(
    source,
    { [FIELD.legalName]: 'Ada Lovelace' },
    { humanConfirmedProtectionLoss: true },
  );
  assert.equal(result.exportStrategy, 'confirmed_plain_derivative_pdf');
  assert.equal(result.sourceProtection.protectionType, 'usage_rights');
  assert.equal(result.outputProtection.protectionType, 'none');
  assert.deepEqual(result.verifiedFields, [
    {
      name: FIELD.legalName,
      type: 'text',
      value: 'Ada Lovelace',
      widgetCount: 1,
      appearanceVerified: true,
    },
  ]);

  const outputInspection = await inspectPdf(result.bytes);
  assert.equal(outputInspection.protection.protectionType, 'none');
  assert.equal(
    outputInspection.fields.find((field) => field.name === FIELD.legalName)
      ?.current,
    'Ada Lovelace',
  );
  const reopened = await PDFDocument.load(result.bytes, {
    updateMetadata: false,
  });
  assert.equal(reopened.catalog.has(PDFName.of('Perms')), false);
  assert.equal(reopened.catalog.AcroForm()?.has(PDFName.of('SigFlags')), false);
  assert.deepEqual(
    source,
    sourceSnapshot,
    'source bytes must remain unchanged',
  );
});

void test('keeps usage-rights XFA inspectable and fill-package-only', async () => {
  const source = await usageRightsBytes({ xfa: true });
  const sourceSnapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'usage_rights');
  assert.equal(inspection.protection.evidence.xfaPresent, true);
  assert.deepEqual(inspection.protection.allowedMutations, [
    'inspect_fields',
    'stage_field_values',
    'create_fill_package',
  ]);
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
  assert.equal(
    inspection.protection.signatureImpact,
    'rewrite_would_invalidate_usage_rights',
  );
  assert.equal(inspection.protection.requiresHumanConfirmation, false);
  assert.ok(inspection.fieldCount > 0);
  assert.ok(
    inspection.warnings.some(
      (warning) => warning.code === 'USAGE_RIGHTS_DETECTED',
    ),
  );
  assert.ok(
    inspection.warnings.some(
      (warning) => warning.code === 'XFA_PRESENT_INSPECTION_ONLY',
    ),
  );

  await expectEngineError(
    applyApprovedValues(source, { [FIELD.legalName]: 'Must not be written' }),
    'PDF_XFA_UNSUPPORTED',
  );
  await expectEngineError(
    applyConfirmedDerivativeValues(
      source,
      { [FIELD.legalName]: 'Must not be written' },
      { humanConfirmedProtectionLoss: true },
    ),
    'PDF_XFA_UNSUPPORTED',
  );
  assert.deepEqual(
    source,
    sourceSnapshot,
    'source bytes must remain unchanged',
  );
});

void test('rejects encrypted PDFs before inspection', async () => {
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

void test('reserves explicit text signatures without blocking signature dates', async () => {
  const source = await signatureTextFieldsBytes();
  const inspection = await inspectPdf(source);
  const signatureFields = inspection.fields.filter((field) =>
    field.name.startsWith('Signature of '),
  );
  const applicantSignature = inspection.fields.find(
    (field) => field.name === 'Applicant Signature',
  );
  const dateFields = inspection.fields.filter((field) =>
    /date/i.test(field.name),
  );

  assert.equal(signatureFields.length, 9);
  assert.ok(signatureFields.every((field) => field.humanOnly));
  assert.equal(applicantSignature?.humanOnly, true);
  assert.ok(dateFields.every((field) => !field.humanOnly));
  assert.equal(
    inspection.warnings.filter(
      (warning) => warning.code === 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY',
    ).length,
    10,
  );

  await expectEngineError(
    applyApprovedValues(source, {
      'Applicant Signature': 'Synthetic Applicant',
    }),
    'FIELD_HUMAN_ONLY',
    'Applicant Signature',
  );

  await expectEngineError(
    applyApprovedValues(source, {
      'Signature of Employee': 'Synthetic Applicant',
    }),
    'FIELD_HUMAN_ONLY',
    'Signature of Employee',
  );

  const dated = await applyApprovedValues(source, {
    'Signature Date mmddyyyy': '08/29/2026',
  });
  assert.equal(
    (await inspectPdf(dated.bytes)).fields.find(
      (field) => field.name === 'Signature Date mmddyyyy',
    )?.current,
    '08/29/2026',
  );
});

void test('recovers multi-state checkbox widgets as exact radio semantics', async () => {
  const source = await recoveredRadioCheckBoxBytes();
  const initial = await inspectPdf(source);
  const descriptor = initial.fields.find(
    (field) => field.name === 'malformed.selection',
  );

  assert.deepEqual(
    {
      type: descriptor?.type,
      current: descriptor?.current,
      options: descriptor?.options,
      choices: descriptor?.choices,
      multiSelect: descriptor?.multiSelect,
    },
    {
      type: 'radio',
      current: 'Card',
      options: ['Book', 'Card', 'Both'],
      choices: [
        { value: 'Book', label: 'Book' },
        { value: 'Card', label: 'Card' },
        { value: 'Both', label: 'Both' },
      ],
      multiSelect: false,
    },
  );

  await expectEngineError(
    applyApprovedValues(source, { 'malformed.selection': true }),
    'FIELD_VALUE_TYPE_INVALID',
    'malformed.selection',
  );

  const selected = await applyApprovedValues(source, {
    'malformed.selection': 'Book',
  });
  assert.deepEqual(selected.verifiedFields, [
    {
      name: 'malformed.selection',
      type: 'radio',
      value: 'Book',
      widgetCount: 3,
      appearanceVerified: true,
    },
  ]);
  const selectedDocument = await PDFDocument.load(selected.bytes, {
    updateMetadata: false,
  });
  const selectedField = selectedDocument
    .getForm()
    .getCheckBox('malformed.selection');
  assert.equal(selectedField.acroField.getValue().decodeText(), 'Book');
  assert.deepEqual(
    selectedField.acroField
      .getWidgets()
      .map((widget) => widget.getAppearanceState()?.decodeText()),
    ['Book', 'Off', 'Off'],
  );
  assert.deepEqual(
    selectedField.acroField.getWidgets().map((widget) => {
      const normal = widget.getAppearances()?.normal;
      assert.ok(normal instanceof PDFDict);
      return normal.keys().map((key) => key.decodeText());
    }),
    [
      ['Off', 'Book'],
      ['Off', 'Card'],
      ['Off', 'Both'],
    ],
  );

  const cleared = await applyApprovedValues(source, {
    'malformed.selection': null,
  });
  const clearedDocument = await PDFDocument.load(cleared.bytes, {
    updateMetadata: false,
  });
  const clearedField = clearedDocument
    .getForm()
    .getCheckBox('malformed.selection');
  assert.equal(clearedField.acroField.getValue().decodeText(), 'Off');
  assert.ok(
    clearedField.acroField
      .getWidgets()
      .every((widget) => widget.getAppearanceState()?.decodeText() === 'Off'),
  );
});

void test('keeps shared-state multi-widget checkboxes boolean', async () => {
  const source = await sharedStateCheckBoxBytes();
  const initial = (await inspectPdf(source)).fields[0];
  assert.equal(initial?.type, 'checkbox');
  assert.equal(initial?.current, true);
  assert.deepEqual(initial?.options, []);

  const cleared = await applyApprovedValues(source, {
    'ordinary.shared-checkbox': false,
  });
  const output = (await inspectPdf(cleared.bytes)).fields[0];
  assert.equal(output?.type, 'checkbox');
  assert.equal(output?.current, false);
});

void test('reports reachable active content without exposing or executing scripts', async () => {
  const source = await activeContentBytes();
  const inspection = await inspectPdf(source);

  assert.deepEqual(inspection.activeContent, {
    javascriptActionCount: 1,
    additionalActionDictionaryCount: 1,
    openActionCount: 1,
    externalActionCount: 1,
    highRiskActionCount: 0,
    otherActionCount: 0,
  });
  assert.ok(
    inspection.warnings.some(
      (warning) =>
        warning.code === 'ACTIVE_CONTENT_PRESERVED' &&
        /preserved/i.test(warning.message) &&
        /does not execute or validate/i.test(warning.message),
    ),
  );
  assert.ok(
    inspection.warnings.some(
      (warning) =>
        warning.code === 'JAVASCRIPT_UNVALIDATED' &&
        /preserved/i.test(warning.message) &&
        /does not execute or semantically validate/i.test(warning.message),
    ),
  );
  assert.doesNotMatch(JSON.stringify(inspection), /validateWithoutExecuting/);

  const result = await applyApprovedValues(source, {
    'active.name': 'Synthetic Applicant',
  });
  assert.deepEqual(result.activeContent, inspection.activeContent);
  assert.deepEqual(
    (await inspectPdf(result.bytes)).activeContent,
    inspection.activeContent,
  );
});

void test('reports but refuses to export native high-risk PDF actions', async () => {
  const source = await activeContentBytes({ highRisk: true });
  const inspection = await inspectPdf(source);

  assert.deepEqual(inspection.activeContent, {
    javascriptActionCount: 0,
    additionalActionDictionaryCount: 1,
    openActionCount: 1,
    externalActionCount: 1,
    highRiskActionCount: 1,
    otherActionCount: 0,
  });
  await expectEngineError(
    applyApprovedValues(source, { 'active.name': 'Must not be written' }),
    'PDF_HIGH_RISK_ACTION_UNSUPPORTED',
  );
  await expectEngineError(
    applyApprovedValues(source, {}),
    'PDF_HIGH_RISK_ACTION_UNSUPPORTED',
  );
});

void test('ignores unreachable actions but fails closed for an unreachable signature object', async () => {
  const source = await activeContentBytes({ highRisk: true, orphan: true });
  const document = await PDFDocument.load(source, { updateMetadata: false });
  document.context.register(
    document.context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [
        PDFNumber.of(0),
        PDFNumber.of(1),
        PDFNumber.of(2),
        PDFNumber.of(3),
      ],
      Contents: PDFHexString.of('00'),
    }) as PDFDict,
  );
  const withOrphans = await document.save({
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  const sourceSnapshot = Uint8Array.from(withOrphans);
  const inspection = await inspectPdf(withOrphans);

  assert.deepEqual(inspection.activeContent, {
    javascriptActionCount: 0,
    additionalActionDictionaryCount: 0,
    openActionCount: 0,
    externalActionCount: 0,
    highRiskActionCount: 0,
    otherActionCount: 0,
  });
  assert.ok(
    !inspection.warnings.some(
      (warning) => warning.code === 'ACTIVE_CONTENT_PRESERVED',
    ),
  );
  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.documentSignatureCount, 0);
  assert.equal(
    inspection.protection.evidence.unreachableSignatureDictionaryCount,
    1,
  );
  assert.equal(inspection.protection.evidence.byteRangeEntryCount, 1);
  assert.equal(inspection.protection.evidence.malformedByteRangeCount, 0);
  assert.equal(inspection.protection.evidence.byteRangesCoverWholeFile, false);
  assert.ok(
    inspection.protection.evidence.unknownStructures.includes(
      'historical_or_unreachable_signature_structure',
    ),
  );
  await expectEngineError(
    applyApprovedValues(withOrphans, {
      'active.name': 'Must not be written',
    }),
    'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );
  assert.deepEqual(
    withOrphans,
    sourceSnapshot,
    'inspection and mutation must not mutate the source buffer',
  );
});

void test('reports and preserves standard native PDF actions', async () => {
  const source = await resetFormActionBytes();
  const inspection = await inspectPdf(source);

  assert.deepEqual(inspection.activeContent, {
    javascriptActionCount: 0,
    additionalActionDictionaryCount: 0,
    openActionCount: 0,
    externalActionCount: 0,
    highRiskActionCount: 0,
    otherActionCount: 1,
  });
  assert.ok(
    inspection.warnings.some(
      (warning) => warning.code === 'ACTIVE_CONTENT_PRESERVED',
    ),
  );

  const result = await applyApprovedValues(source, {
    'active.name': 'Synthetic Applicant',
  });
  assert.deepEqual(result.activeContent, inspection.activeContent);
  assert.deepEqual(
    (await inspectPdf(result.bytes)).activeContent,
    inspection.activeContent,
  );
});

void test('blocks unrecognized actions referenced by form fields', async () => {
  const source = await unknownActionBytes();
  const inspection = await inspectPdf(source);

  assert.deepEqual(inspection.activeContent, {
    javascriptActionCount: 0,
    additionalActionDictionaryCount: 0,
    openActionCount: 0,
    externalActionCount: 0,
    highRiskActionCount: 1,
    otherActionCount: 0,
  });
  assert.ok(
    inspection.warnings.some(
      (warning) => warning.code === 'ACTIVE_CONTENT_PRESERVED',
    ),
  );
  await expectEngineError(
    applyApprovedValues(source, { 'active.name': 'Must not be written' }),
    'PDF_HIGH_RISK_ACTION_UNSUPPORTED',
  );
});

void test('does not classify untriggered metadata as an action', async () => {
  const source = await actionLikeMetadataBytes();
  const inspection = await inspectPdf(source);

  assert.deepEqual(inspection.activeContent, {
    javascriptActionCount: 0,
    additionalActionDictionaryCount: 0,
    openActionCount: 0,
    externalActionCount: 0,
    highRiskActionCount: 0,
    otherActionCount: 0,
  });
  const result = await applyApprovedValues(source, {
    'active.name': 'Synthetic Applicant',
  });
  assert.deepEqual(result.verifiedFields, [
    {
      name: 'active.name',
      type: 'text',
      value: 'Synthetic Applicant',
      widgetCount: 1,
      appearanceVerified: true,
    },
  ]);
});

void test('inspects an approval signature but blocks both PDF rewrite strategies', async () => {
  const source = await approvalSignatureBytes();
  const sourceSnapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);

  assert.deepEqual(inspection.protection, {
    protectionType: 'document_signature',
    allowedMutations: [
      'inspect_fields',
      'stage_field_values',
      'create_fill_package',
    ],
    exportStrategies: ['fill_package'],
    signatureImpact: 'rewrite_blocked_to_preserve_document_signature',
    requiresHumanConfirmation: false,
    evidence: {
      catalogPermsPresent: false,
      permsKeys: [],
      usageRightsKeys: [],
      byteRangeEntryCount: 1,
      malformedByteRangeCount: 0,
      byteRanges: [[0, 1, 2, source.byteLength - 2]],
      byteRangesCoverWholeFile: true,
      signatureDictionaryCount: 1,
      usageRightsSignatureCount: 0,
      documentSignatureCount: 1,
      unclassifiedSignatureDictionaryCount: 0,
      unreachableSignatureDictionaryCount: 0,
      signatureFieldCount: 1,
      signedSignatureFieldCount: 1,
      docMdpPresent: false,
      docMdpSignatureDictionaryCount: 0,
      docMdpPermission: null,
      fieldMdpPresent: false,
      adbeExtension: null,
      xfaPresent: false,
      sigFlags: 3,
      unknownStructures: [],
      cmsIntegrity: 'not_verified_in_browser',
      signerTrust: 'not_verified',
    },
  });
  assert.ok(
    inspection.warnings.some(
      (warning) => warning.code === 'DOCUMENT_SIGNATURE_PROTECTED',
    ),
  );

  await expectEngineError(
    applyApprovedValues(source, { [FIELD.legalName]: 'Must not be written' }),
    'PDF_SIGNED_UNSUPPORTED',
  );
  await expectEngineError(
    applyConfirmedDerivativeValues(
      source,
      { [FIELD.legalName]: 'Must not be written' },
      { humanConfirmedProtectionLoss: true },
    ),
    'PDF_SIGNED_UNSUPPORTED',
  );
  assert.deepEqual(
    source,
    sourceSnapshot,
    'source bytes must remain unchanged',
  );
});

void test('reports every DocMDP permission and blocks both PDF rewrite strategies', async () => {
  for (const permission of [1, 2, 3] as const) {
    const source = await docMdpBytes(permission);
    const sourceSnapshot = Uint8Array.from(source);
    const inspection = await inspectPdf(source);

    assert.equal(inspection.protection.protectionType, 'doc_mdp');
    assert.deepEqual(inspection.protection.allowedMutations, [
      'inspect_fields',
      'stage_field_values',
      'create_fill_package',
    ]);
    assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
    assert.equal(
      inspection.protection.signatureImpact,
      'rewrite_blocked_to_preserve_certification',
    );
    assert.equal(inspection.protection.requiresHumanConfirmation, false);
    assert.deepEqual(inspection.protection.evidence.permsKeys, ['DocMDP']);
    assert.deepEqual(inspection.protection.evidence.usageRightsKeys, []);
    assert.deepEqual(inspection.protection.evidence.byteRanges, [
      [0, 1, 2, source.byteLength - 2],
    ]);
    assert.equal(inspection.protection.evidence.byteRangesCoverWholeFile, true);
    assert.equal(inspection.protection.evidence.documentSignatureCount, 0);
    assert.equal(inspection.protection.evidence.docMdpPermission, permission);
    assert.deepEqual(inspection.protection.evidence.unknownStructures, []);
    assert.ok(
      inspection.warnings.some(
        (warning) => warning.code === 'DOC_MDP_PROTECTED',
      ),
    );

    await expectEngineError(
      applyApprovedValues(source, {
        [FIELD.legalName]: 'Must not be written',
      }),
      'PDF_CERTIFIED_UNSUPPORTED',
    );
    await expectEngineError(
      applyConfirmedDerivativeValues(
        source,
        { [FIELD.legalName]: 'Must not be written' },
        { humanConfirmedProtectionLoss: true },
      ),
      'PDF_CERTIFIED_UNSUPPORTED',
    );
    assert.deepEqual(
      source,
      sourceSnapshot,
      `DocMDP P=${permission} source bytes must remain unchanged`,
    );
  }
});

void test('reports unknown Perms variants and refuses every export strategy', async () => {
  const cases: Array<{
    kind: UnknownPermsKind;
    permsKeys: string[];
    unknownStructures: string[];
  }> = [
    {
      kind: 'empty',
      permsKeys: [],
      unknownStructures: ['catalog_perms_empty'],
    },
    {
      kind: 'not_dictionary',
      permsKeys: [],
      unknownStructures: ['catalog_perms_not_dictionary'],
    },
    {
      kind: 'unknown_key',
      permsKeys: ['VendorLock'],
      unknownStructures: ['catalog_perms_VendorLock'],
    },
    {
      kind: 'malformed_ur3',
      permsKeys: ['UR3'],
      unknownStructures: ['ur3_structure_unrecognized'],
    },
  ];

  for (const item of cases) {
    const source = await unknownPermsBytes(item.kind);
    const sourceSnapshot = Uint8Array.from(source);
    const inspection = await inspectPdf(source);

    assert.equal(inspection.protection.protectionType, 'unknown');
    assert.deepEqual(inspection.protection.allowedMutations, [
      'inspect_fields',
      'stage_field_values',
    ]);
    assert.deepEqual(inspection.protection.exportStrategies, []);
    assert.equal(
      inspection.protection.signatureImpact,
      'rewrite_blocked_for_unknown_protection',
    );
    assert.equal(inspection.protection.requiresHumanConfirmation, false);
    assert.equal(inspection.protection.evidence.catalogPermsPresent, true);
    assert.deepEqual(inspection.protection.evidence.permsKeys, item.permsKeys);
    assert.deepEqual(
      inspection.protection.evidence.unknownStructures,
      item.unknownStructures,
    );
    assert.ok(
      inspection.warnings.some(
        (warning) => warning.code === 'UNKNOWN_PROTECTION',
      ),
    );

    await expectEngineError(
      applyApprovedValues(source, {
        [FIELD.legalName]: 'Must not be written',
      }),
      'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
    );
    await expectEngineError(
      applyConfirmedDerivativeValues(
        source,
        { [FIELD.legalName]: 'Must not be written' },
        { humanConfirmedProtectionLoss: true },
      ),
      'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
    );
    assert.deepEqual(
      source,
      sourceSnapshot,
      `${item.kind} source bytes must remain unchanged`,
    );
  }
});

void test('fails closed for a UR3 dictionary missing its Adobe signature filter', async () => {
  const source = await usageRightsBytes({ omitFilter: true });
  const sourceSnapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.deepEqual(inspection.protection.exportStrategies, []);
  assert.ok(
    inspection.protection.evidence.unknownStructures.includes(
      'ur3_structure_unrecognized',
    ),
  );
  await expectEngineError(
    applyApprovedValues(source, { [FIELD.legalName]: 'Must not be written' }),
    'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );
  assert.deepEqual(source, sourceSnapshot);
});

void test('fails closed for unknown UR3 transform parameters and reserved signature flags', async () => {
  const source = await usageRightsBytes({
    unknownTransformParameter: true,
    sigFlags: 4,
  });
  const sourceSnapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.deepEqual(inspection.protection.exportStrategies, []);
  assert.ok(
    inspection.protection.evidence.unknownStructures.includes(
      'ur3_transform_params_unrecognized',
    ),
  );
  assert.ok(
    inspection.protection.evidence.unknownStructures.includes(
      'sig_flags_unrecognized',
    ),
  );
  await expectEngineError(
    applyConfirmedDerivativeValues(
      source,
      { [FIELD.legalName]: 'Must not be written' },
      { humanConfirmedProtectionLoss: true },
    ),
    'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );
  assert.deepEqual(source, sourceSnapshot);
});

void test('fails closed when a UR3 Reference array hides a non-dictionary item', async () => {
  const source = await usageRightsBytes({ hiddenReference: true });
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.deepEqual(inspection.protection.exportStrategies, []);
  assert.ok(
    inspection.protection.evidence.unknownStructures.includes(
      'signature_reference_structure_unrecognized',
    ),
  );
  await expectEngineError(
    applyConfirmedDerivativeValues(
      source,
      { [FIELD.legalName]: 'Must not be written' },
      { humanConfirmedProtectionLoss: true },
    ),
    'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );
});

void test('fails closed for unknown, missing, or non-name signature transform methods', async () => {
  for (const kind of [
    'unknown_method',
    'missing_method',
    'non_name_method',
  ] as const) {
    const source = await signatureReferenceVariantBytes(kind);
    const inspection = await inspectPdf(source);

    assert.equal(inspection.protection.protectionType, 'unknown', kind);
    assert.deepEqual(inspection.protection.exportStrategies, [], kind);
    assert.ok(
      inspection.protection.evidence.unknownStructures.includes(
        'signature_transform_method_unrecognized',
      ),
      kind,
    );
  }
});

void test('fails closed for malformed DocMDP and FieldMDP transform parameters', async () => {
  const cases = [
    {
      source: await malformedDocMdpProtectionBytes(),
      marker: 'doc_mdp_transform_params_unrecognized',
    },
    {
      source: await fieldMdpBytes(true),
      marker: 'field_mdp_transform_params_unrecognized',
    },
  ];

  for (const { source, marker } of cases) {
    const inspection = await inspectPdf(source);
    assert.equal(inspection.protection.protectionType, 'unknown');
    assert.deepEqual(inspection.protection.exportStrategies, []);
    assert.ok(
      inspection.protection.evidence.unknownStructures.includes(marker),
    );
  }
});

void test('reports a standard FieldMDP signature but never rewrites it', async () => {
  const source = await fieldMdpBytes(false);
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'document_signature');
  assert.equal(inspection.protection.evidence.fieldMdpPresent, true);
  assert.deepEqual(inspection.protection.evidence.unknownStructures, []);
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);
  await expectEngineError(
    applyApprovedValues(source, { [FIELD.legalName]: 'Must not be written' }),
    'PDF_SIGNED_UNSUPPORTED',
  );
});

void test('fails closed for multiple DocMDP certification signatures', async () => {
  const source = await duplicateDocMdpBytes();
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(
    inspection.protection.evidence.docMdpSignatureDictionaryCount,
    2,
  );
  assert.ok(
    inspection.protection.evidence.unknownStructures.includes(
      'multiple_doc_mdp_signatures',
    ),
  );
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed for inconsistent signature flags without signature context', async () => {
  for (const sigFlags of [1, 2, 3]) {
    const source = await singleTextFieldBytes({ sigFlags });
    const inspection = await inspectPdf(source);

    assert.equal(inspection.protection.protectionType, 'unknown');
    assert.deepEqual(inspection.protection.exportStrategies, []);
    assert.ok(
      inspection.protection.evidence.unknownStructures.some((marker) =>
        marker.startsWith('sig_flags_'),
      ),
    );
  }
});

void test('does not advertise staging or export when every field is read-only', async () => {
  const inspection = await inspectPdf(
    await singleTextFieldBytes({ readOnly: true }),
  );

  assert.equal(inspection.protection.protectionType, 'none');
  assert.deepEqual(inspection.protection.allowedMutations, ['inspect_fields']);
  assert.deepEqual(inspection.protection.exportStrategies, []);
});

void test('fails closed for a malformed signature dictionary without ByteRange', async () => {
  const source = await malformedDocumentSignatureBytes();
  const sourceSnapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);

  assert.equal(inspection.protection.protectionType, 'unknown');
  assert.equal(inspection.protection.evidence.documentSignatureCount, 0);
  assert.deepEqual(inspection.protection.exportStrategies, []);
  assert.ok(
    inspection.protection.evidence.unknownStructures.includes(
      'signature_structure_unrecognized',
    ),
  );
  await expectEngineError(
    applyApprovedValues(source, { [FIELD.legalName]: 'Must not be written' }),
    'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
  );
  assert.deepEqual(source, sourceSnapshot);
});
