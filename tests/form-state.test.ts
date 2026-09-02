import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
} from 'pdf-lib';

import {
  approveDraftFromUi,
  correctDraftFieldFromUi,
  createFormFieldDefinitionFromPdf,
  createFormState,
  discardDraft,
  discardDraftFields,
  exportApprovedDerivativePdfFromUi,
  exportApprovedPdfFromUi,
  exportFillPackageFromUi,
  getArtifactReviewFieldNames,
  getEffectiveFieldValue,
  getExportGate,
  getFormContext,
  getReleaseGate,
  getVerificationGate,
  importFillPackageFromUi,
  MAX_FILL_PACKAGE_BYTES,
  MAX_PLAN_PROVENANCE_ITEMS,
  MAX_PLAN_PROVENANCE_UTF8_BYTES,
  MAX_PROVENANCE_EVIDENCE_ITEMS,
  MAX_PROVENANCE_TEXT_LENGTH,
  recordExportOutput,
  recordOutputVerification,
  stageFieldUpdates,
  validateDraft,
  type FieldProvenance,
  type FormFieldDefinition,
  type FormFieldValue,
  type FormState,
  type SourceMetadata,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/form-state.ts';
import type { PdfFieldDescriptor } from '../lib/pdf-engine';

const { applyApprovedValues, inspectPdf } = (await import(
  new URL('../lib/pdf-engine.ts', import.meta.url).href
)) as typeof import('../lib/pdf-engine');

const SOURCE: SourceMetadata = {
  fileName: 'benefits-form.pdf',
  sourceHash: 'sha256:source-a',
  byteLength: 8_192,
  pageCount: 2,
  loadedAt: '2026-08-29T18:00:00.000Z',
};

function fields(): FormFieldDefinition[] {
  return [
    {
      name: 'full_name',
      label: 'Full name',
      type: 'text',
      required: true,
      readOnly: false,
      humanOnly: false,
      maxLength: 80,
      sourceValue: '',
    },
    {
      name: 'region',
      label: 'Region',
      type: 'dropdown',
      required: true,
      readOnly: false,
      humanOnly: false,
      options: ['CA', 'NY'],
      sourceValue: 'CA',
    },
    {
      name: 'programs',
      label: 'Programs',
      type: 'option-list',
      required: false,
      readOnly: false,
      humanOnly: false,
      options: ['Health', 'Dental'],
      sourceValue: [],
    },
    {
      name: 'case_id',
      label: 'Case ID',
      type: 'text',
      required: false,
      readOnly: true,
      humanOnly: false,
      sourceValue: 'A-100',
    },
    {
      name: 'attestation',
      label: 'Attestation',
      type: 'checkbox',
      required: true,
      readOnly: false,
      humanOnly: true,
      sourceValue: false,
    },
    {
      name: 'signature',
      label: 'Signature',
      type: 'signature',
      required: false,
      readOnly: false,
      humanOnly: true,
      sourceValue: null,
    },
  ];
}

const USER_PROVENANCE: FieldProvenance = {
  kind: 'user_instruction',
  confidence: 0.99,
  evidence: ['current chat turn'],
};

async function initialState(): Promise<FormState> {
  return createFormState({ ...SOURCE }, fields());
}

void test('maps inspected PDF fields through the shared UI and eval contract', () => {
  const optionList: PdfFieldDescriptor = {
    name: 'benefits',
    type: 'option_list',
    current: ['Housing'],
    options: ['Housing', 'Utilities'],
    choices: [
      {
        value: 'Housing',
        label: 'Housing support',
        labelSource: 'acroform',
      },
      {
        value: 'Utilities',
        label: 'Utility support',
        labelSource: 'acroform',
      },
    ],
    multiSelect: true,
    required: true,
    readOnly: false,
    humanOnly: true,
    page: 1,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    maxLength: null,
    tooltip: '[HUMAN_ONLY] Benefits — choose all that apply',
    widgetCount: 1,
    widgets: [],
  };
  const mapped = createFormFieldDefinitionFromPdf(optionList);
  assert.deepEqual(mapped, {
    name: 'benefits',
    label: 'Benefits',
    type: 'option-list',
    required: true,
    readOnly: false,
    humanOnly: true,
    multiSelect: true,
    options: ['Housing', 'Utilities'],
    sourceValue: ['Housing'],
  });
  assert.notEqual(mapped.options, optionList.options);
  assert.notEqual(mapped.sourceValue, optionList.current);

  for (const tooltip of ['undefined', ' NULL ']) {
    const fieldName = `sentinel:${tooltip.trim().toLowerCase()}`;
    assert.equal(
      createFormFieldDefinitionFromPdf({
        ...optionList,
        name: fieldName,
        tooltip,
      }).label,
      fieldName,
    );
  }

  const longTooltipFieldName = 'DS11.ApplicantName';
  assert.equal(
    createFormFieldDefinitionFromPdf({
      ...optionList,
      name: longTooltipFieldName,
      tooltip: 'Detailed PDF instruction '.repeat(10),
    }).label,
    longTooltipFieldName,
  );

  assert.deepEqual(
    createFormFieldDefinitionFromPdf({
      ...optionList,
      name: 'legacy',
      type: 'unsupported',
      current: null,
      options: [],
      choices: [],
      multiSelect: false,
      required: false,
      humanOnly: false,
      tooltip: null,
    }),
    {
      name: 'legacy',
      label: 'legacy',
      type: 'text',
      required: false,
      readOnly: true,
      humanOnly: true,
      sourceValue: null,
    },
  );
});

void test('degrades only malformed inspected PDF fields to read-only text', async () => {
  const source = await createPdfWithInvalidFieldConfigurations();
  const inspection = await inspectPdf(source);
  const state = await createFormState(
    {
      fileName: 'invalid-fields.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );

  const degradedValues = new Map<string, string>([
    ['invalid_dropdown', 'C'],
    ['overlong_text', 'toolongvalue'],
    ['no_options_dropdown', ''],
    ['empty_radio', ''],
    ['invalid_radio', 'Maybe'],
    ['invalid_option_list', 'x, zzz'],
  ]);
  for (const [fieldName, sourceValue] of degradedValues) {
    const field = state.fields[fieldName];
    assert.ok(field, `${fieldName} was not inspected`);
    assert.equal(field.type, 'text', fieldName);
    assert.equal(field.readOnly, true, fieldName);
    assert.equal(field.humanOnly, true, fieldName);
    assert.equal(field.sourceValue, sourceValue, fieldName);
  }
  assert.equal(state.fields.invalid_dropdown.required, true);

  assert.deepEqual(state.fields.safe, {
    name: 'safe',
    label: 'safe',
    type: 'text',
    required: false,
    readOnly: false,
    humanOnly: false,
    sourceValue: 'unchanged',
  });
});

void test('degrades inspected PDF values with bidi controls to inert read-only text', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([320, 180]);
  const pdfField = document.getForm().createTextField('unsafe_source');
  pdfField.addToPage(page, { x: 40, y: 80, width: 240, height: 28 });
  pdfField.acroField.dict.set(
    PDFName.of('V'),
    PDFHexString.fromText('abc\u202edef'),
  );
  const source = Uint8Array.from(
    await document.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: false,
    }),
  );

  const inspection = await inspectPdf(source);
  assert.equal(inspection.fields[0].current, 'abc\u202edef');
  const state = await createFormState(
    {
      fileName: 'unsafe-source.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const field = state.fields.unsafe_source;
  assert.equal(field.type, 'text');
  assert.equal(field.readOnly, true);
  assert.equal(field.humanOnly, true);
  assert.equal(field.sourceValue, 'abcdef');
  assert.doesNotMatch(
    String(field.sourceValue),
    /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u,
  );

  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: field.name,
        value: 'replacement',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, false);
  if (staged.ok) throw new Error('degraded PDF field was staged');
  assert.equal(
    staged.errors.some(({ code }) => code === 'read_only'),
    true,
  );
});

void test('degrades PDF choices containing bidi controls instead of rejecting the form', async () => {
  const definition = createFormFieldDefinitionFromPdf({
    name: 'unsafe_options',
    type: 'dropdown',
    current: 'Safe',
    options: ['Safe', 'Unsafe\u202e'],
    choices: [],
    multiSelect: false,
    required: false,
    readOnly: false,
    humanOnly: false,
    page: 1,
    rect: null,
    maxLength: null,
    tooltip: null,
    widgetCount: 1,
    widgets: [],
  });
  const state = await createFormState(SOURCE, [definition]);
  assert.deepEqual(state.fields.unsafe_options, {
    name: 'unsafe_options',
    label: 'unsafe_options',
    type: 'text',
    required: false,
    readOnly: true,
    humanOnly: true,
    sourceValue: 'Safe',
  });
});

async function createTextFormPdf(fieldName: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([320, 180]);
  const field = document.getForm().createTextField(fieldName);
  field.addToPage(page, { x: 40, y: 80, width: 240, height: 28 });
  return Uint8Array.from(
    await document.save({ addDefaultPage: false, useObjectStreams: false }),
  );
}

async function createPdfWithInvalidFieldConfigurations(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([520, 720]);
  const form = document.getForm();
  const font = await document.embedFont(StandardFonts.Helvetica);

  const safe = form.createTextField('safe');
  safe.setText('unchanged');
  safe.addToPage(page, { x: 40, y: 650, width: 200, height: 24, font });

  const invalidDropdown = form.createDropdown('invalid_dropdown');
  invalidDropdown.addOptions(['A', 'B']);
  invalidDropdown.enableRequired();
  invalidDropdown.addToPage(page, {
    x: 40,
    y: 600,
    width: 200,
    height: 24,
    font,
  });

  const overlongText = form.createTextField('overlong_text');
  overlongText.setMaxLength(5);
  overlongText.addToPage(page, {
    x: 40,
    y: 550,
    width: 200,
    height: 24,
    font,
  });

  const noOptionsDropdown = form.createDropdown('no_options_dropdown');
  noOptionsDropdown.addOptions('placeholder');
  noOptionsDropdown.addToPage(page, {
    x: 40,
    y: 500,
    width: 200,
    height: 24,
    font,
  });

  form.createRadioGroup('empty_radio');

  const invalidRadio = form.createRadioGroup('invalid_radio');
  invalidRadio.addOptionToPage('Yes', page, {
    x: 40,
    y: 450,
    width: 18,
    height: 18,
  });

  const invalidOptionList = form.createOptionList('invalid_option_list');
  invalidOptionList.addOptions(['x', 'y']);
  invalidOptionList.enableMultiselect();
  invalidOptionList.addToPage(page, {
    x: 40,
    y: 330,
    width: 200,
    height: 80,
    font,
  });

  form.updateFieldAppearances(font);
  invalidDropdown.acroField.dict.set(PDFName.of('V'), PDFString.of('C'));
  overlongText.acroField.dict.set(
    PDFName.of('V'),
    PDFString.of('toolongvalue'),
  );
  noOptionsDropdown.acroField.dict.delete(PDFName.of('Opt'));
  invalidRadio.acroField.dict.set(PDFName.of('V'), PDFName.of('Maybe'));
  invalidOptionList.acroField.dict.set(
    PDFName.of('V'),
    document.context.obj([PDFString.of('x'), PDFString.of('zzz')]),
  );

  return Uint8Array.from(
    await document.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: false,
    }),
  );
}

async function createClearableFormPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 220]);
  const form = document.getForm();
  const font = await document.embedFont(StandardFonts.Helvetica);

  const text = form.createTextField('clear_text');
  text.setText('Original text');
  text.addToPage(page, {
    x: 40,
    y: 140,
    width: 340,
    height: 28,
    font,
  });

  const choices = form.createDropdown('clear_choices');
  choices.addOptions(['north', 'south']);
  choices.enableMultiselect();
  choices.select(['north', 'south']);
  choices.addToPage(page, {
    x: 40,
    y: 80,
    width: 340,
    height: 28,
    font,
  });

  form.updateFieldAppearances(font);
  return Uint8Array.from(
    await document.save({ addDefaultPage: false, useObjectStreams: false }),
  );
}

function usageRightsSignature(document: PDFDocument): PDFDict {
  const transformParameters = document.context.obj({
    Type: 'TransformParams',
    V: '2.2',
    P: false,
  }) as PDFDict;
  const reference = document.context.obj({
    Type: 'SigRef',
    TransformMethod: 'UR3',
    TransformParams: transformParameters,
  }) as PDFDict;
  return document.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 1, 2, 3],
    Contents: PDFHexString.of('00'),
    Reference: [reference],
  }) as PDFDict;
}

async function saveWithStableSignatureByteRange(
  document: PDFDocument,
): Promise<Uint8Array> {
  let bytes = await document.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    let found = false;
    for (const [, object] of reopened.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      const type = reopened.context.lookup(object.get(PDFName.of('Type')));
      if (!(type instanceof PDFName) || type.decodeText() !== 'Sig') continue;
      object.set(
        PDFName.of('ByteRange'),
        reopened.context.obj([0, 1, 2, bytes.byteLength - 2]),
      );
      found = true;
    }
    assert.equal(found, true);
    const next = await reopened.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: false,
    });
    if (next.byteLength === bytes.byteLength) return Uint8Array.from(next);
    bytes = next;
  }
  throw new Error('Synthetic usage-rights ByteRange size did not stabilize.');
}

async function createProtectedFormPdf(
  options: {
    xfa?: boolean;
    unknownProtection?: boolean;
    requiredOpaque?: boolean;
  } = {},
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 240]);
  const form = document.getForm();

  const semantic = form.createTextField('formproof.applicant_name');
  semantic.setText('Original applicant');
  semantic.acroField.dict.set(PDFName.of('TU'), PDFString.of('Applicant name'));
  semantic.addToPage(page, { x: 40, y: 150, width: 340, height: 28 });

  const opaque = form.createTextField('opaque.f1_02');
  opaque.setText(options.requiredOpaque ? '' : 'Original opaque value');
  if (options.requiredOpaque) opaque.enableRequired();
  opaque.addToPage(page, { x: 40, y: 90, width: 340, height: 28 });

  const acroForm = form.acroForm.dict;
  if (options.unknownProtection) {
    const permsRef = document.context.register(
      document.context.obj({ VendorProtection: true }) as PDFDict,
    );
    document.catalog.set(PDFName.of('Perms'), permsRef);
  } else {
    const signatureRef = document.context.register(
      usageRightsSignature(document),
    );
    const permsRef = document.context.register(
      document.context.obj({ UR3: signatureRef }) as PDFDict,
    );
    document.catalog.set(PDFName.of('Perms'), permsRef);
    acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(2));
  }

  if (options.xfa !== false) {
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

  if (!options.unknownProtection) {
    return saveWithStableSignatureByteRange(document);
  }
  return Uint8Array.from(
    await document.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: false,
    }),
  );
}

const OPAQUE_FIELD_PROVENANCE: FieldProvenance = {
  kind: 'agent_inference',
  confidence: 0.9,
  evidence: ['visible page 1 field at the inspected rectangle'],
  rationale: 'The exact field name has no semantic tooltip.',
};

async function stagedProtectedForm(
  options: { xfa?: boolean; unknownProtection?: boolean } = {},
) {
  const source = await createProtectedFormPdf(options);
  const sourceSnapshot = Uint8Array.from(source);
  const inspection = await inspectPdf(source);
  const state = await createFormState(
    {
      fileName: 'protected-hybrid.pdf',
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
        fieldName: 'formproof.applicant_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'opaque.f1_02',
        value: 'Synthetic opaque value',
        provenance: OPAQUE_FIELD_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('protected form staging failed');
  return { source, sourceSnapshot, inspection, state: staged.state };
}

async function stageRequiredValues(inputState?: FormState): Promise<FormState> {
  const state = inputState ?? (await initialState());
  const agentResult = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(agentResult.ok, true);
  if (!agentResult.ok) throw new Error('agent staging failed');

  const humanResult = await stageFieldUpdates(agentResult.state, {
    expectedStateVersion: agentResult.state.stateVersion,
    expectedSourceHash: agentResult.state.source.sourceHash,
    actor: 'human',
    updates: [
      {
        fieldName: 'attestation',
        value: true,
        provenance: { kind: 'human_entry', confidence: 1 },
      },
    ],
  });
  assert.equal(humanResult.ok, true);
  if (!humanResult.ok) throw new Error('human staging failed');
  return humanResult.state;
}

void test('copies and freezes source metadata, field definitions, and values', async () => {
  const source = { ...SOURCE };
  const inputFields = fields();
  const state = await createFormState(source, inputFields);

  source.fileName = 'swapped.pdf';
  (inputFields[1].options as string[]).push('TX');
  (inputFields[2].sourceValue as string[]).push('Health');

  assert.equal(state.source.fileName, 'benefits-form.pdf');
  assert.deepEqual(state.fields.region.options, ['CA', 'NY']);
  assert.deepEqual(state.fields.programs.sourceValue, []);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.source), true);
  assert.equal(Object.isFrozen(state.fields.region.options), true);
  assert.throws(() => {
    (state.source as { fileName: string }).fileName = 'mutated.pdf';
  }, TypeError);
});

void test('creates a deterministic source-bound plan hash and validation report', async () => {
  const left = await initialState();
  const right = await createFormState({ ...SOURCE }, [...fields()].reverse());

  assert.match(left.planHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(left.planHash, right.planHash);
  assert.match(left.documentSessionId, /^[a-f0-9]{32}$/u);
  assert.match(right.documentSessionId, /^[a-f0-9]{32}$/u);
  assert.notEqual(left.documentSessionId, right.documentSessionId);
  assert.deepEqual(
    validateDraft(left).issues.map(({ code, fieldName }) => [code, fieldName]),
    [
      ['human_completion_required', 'attestation'],
      ['required_missing', 'full_name'],
    ],
  );
});

void test('reports PDF-required coverage without claiming full-form completeness', async () => {
  const ds11LikeFields: FormFieldDefinition[] = [
    {
      name: 'DS11.ApplicantName',
      label: 'Applicant name',
      type: 'text',
      required: false,
      readOnly: false,
      humanOnly: false,
      sourceValue: '',
    },
    {
      name: 'DS11.MailingAddress',
      label: 'Mailing address',
      type: 'text',
      required: false,
      readOnly: false,
      humanOnly: false,
      sourceValue: '',
    },
  ];
  const initial = await createFormState(SOURCE, ds11LikeFields);
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'DS11.ApplicantName',
        value: 'Synthetic Applicant',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('optional DS-11-like field failed to stage');

  const partialReport = validateDraft(staged.state);
  assert.equal(partialReport.blockerCount, 0);
  assert.equal(partialReport.structurallyValid, true);
  assert.equal(partialReport.completionStatus, 'unknown');
  assert.equal(partialReport.ruleCoverage, 'pdf_required_flags_only');
  assert.equal(partialReport.formCompletenessAssessed, false);
  assert.equal(partialReport.canApprove, true);

  const requiredState = await createFormState(SOURCE, [
    { ...ds11LikeFields[0], required: true },
  ]);
  const incompleteReport = validateDraft(requiredState);
  assert.equal(incompleteReport.blockerCount, 1);
  assert.equal(incompleteReport.structurallyValid, false);
  assert.equal(incompleteReport.completionStatus, 'incomplete');
  assert.equal(incompleteReport.ruleCoverage, 'pdf_required_flags_only');
  assert.equal(incompleteReport.formCompletenessAssessed, false);
  assert.equal(incompleteReport.canApprove, false);

  const humanCompletionState = await createFormState(SOURCE, [
    {
      ...ds11LikeFields[0],
      name: 'DS11.Signature',
      label: 'Signature',
      required: true,
      humanOnly: true,
    },
  ]);
  const humanCompletionReport = validateDraft(humanCompletionState);
  assert.equal(humanCompletionReport.blockerCount, 0);
  assert.equal(humanCompletionReport.structurallyValid, true);
  assert.equal(humanCompletionReport.completionStatus, 'incomplete');
  assert.equal(humanCompletionReport.canApprove, true);
});

void test('stages a batch atomically with CAS and document-hash checks', async () => {
  const state = await initialState();
  const stale = await stageFieldUpdates(state, {
    expectedStateVersion: 1,
    expectedSourceHash: 'sha256:other',
    actor: 'agent',
    updates: [
      { fieldName: 'full_name', value: 'Ada', provenance: USER_PROVENANCE },
    ],
  });
  assert.equal(stale.ok, false);
  if (stale.ok) throw new Error('stale staging unexpectedly succeeded');
  assert.equal(stale.state, state);
  assert.deepEqual(
    stale.errors.map(({ code }) => code),
    ['stale_state', 'source_mismatch'],
  );

  const atomicFailure = await stageFieldUpdates(state, {
    expectedStateVersion: 0,
    expectedSourceHash: SOURCE.sourceHash,
    actor: 'agent',
    updates: [
      { fieldName: 'full_name', value: 'Ada', provenance: USER_PROVENANCE },
      { fieldName: 'region', value: 'WA', provenance: USER_PROVENANCE },
    ],
  });
  assert.equal(atomicFailure.ok, false);
  if (atomicFailure.ok) throw new Error('invalid batch unexpectedly succeeded');
  assert.equal(atomicFailure.state, state);
  assert.equal(atomicFailure.state.draft.full_name, undefined);
  assert.equal(
    atomicFailure.errors.some(({ code }) => code === 'invalid_option'),
    true,
  );

  const success = await stageFieldUpdates(state, {
    expectedStateVersion: 0,
    expectedSourceHash: SOURCE.sourceHash,
    actor: 'agent',
    updates: [
      { fieldName: 'full_name', value: 'Ada', provenance: USER_PROVENANCE },
      {
        fieldName: 'programs',
        value: ['Health', 'Dental'],
        provenance: {
          kind: 'source_document',
          confidence: 0.95,
          evidence: ['page 2, benefits table'],
        },
      },
    ],
  });
  assert.equal(success.ok, true);
  if (!success.ok) throw new Error('valid batch failed');
  assert.equal(success.state.stateVersion, 1);
  assert.notEqual(success.state.planHash, state.planHash);
  assert.deepEqual(success.changedFields, ['full_name', 'programs']);
  assert.equal(success.state.draft.programs.provenance.confidence, 0.95);

  const explicitClear = await stageFieldUpdates(success.state, {
    expectedStateVersion: success.state.stateVersion,
    expectedSourceHash: SOURCE.sourceHash,
    actor: 'agent',
    updates: [
      { fieldName: 'region', value: null, provenance: USER_PROVENANCE },
    ],
  });
  assert.equal(explicitClear.ok, true);
  if (!explicitClear.ok) throw new Error('explicit clear failed');
  assert.equal(getEffectiveFieldValue(explicitClear.state, 'region'), null);
  assert.equal(
    explicitClear.state.validation.issues.some(
      ({ code, fieldName }) =>
        code === 'required_missing' && fieldName === 'region',
    ),
    true,
  );
});

void test('discards selected staged proposals atomically with source and version checks', async () => {
  const initial = await initialState();
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'programs',
        value: ['Health'],
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('discard fixture failed to stage');
  const state = staged.state;

  const stale = await discardDraftFields(state, {
    expectedStateVersion: state.stateVersion - 1,
    expectedSourceHash: 'sha256:other',
    fieldNames: ['full_name'],
  });
  assert.equal(stale.ok, false);
  if (stale.ok) throw new Error('stale discard unexpectedly succeeded');
  assert.equal(stale.state, state);
  assert.deepEqual(
    stale.errors.map(({ code }) => code),
    ['stale_state', 'source_mismatch'],
  );

  const empty = await discardDraftFields(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    fieldNames: [],
  });
  assert.equal(empty.ok, false);
  if (empty.ok) throw new Error('empty discard unexpectedly succeeded');
  assert.equal(empty.state, state);
  assert.equal(empty.errors[0].code, 'invalid_request');

  const duplicate = await discardDraftFields(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    fieldNames: ['full_name', 'full_name'],
  });
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) throw new Error('duplicate discard unexpectedly succeeded');
  assert.equal(duplicate.state, state);
  assert.equal(duplicate.errors[0].code, 'duplicate_update');
  assert.deepEqual(Object.keys(duplicate.state.draft).sort(), [
    'full_name',
    'programs',
  ]);

  const mixed = await discardDraftFields(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    fieldNames: ['full_name', 'region'],
  });
  assert.equal(mixed.ok, false);
  if (mixed.ok) throw new Error('mixed discard unexpectedly succeeded');
  assert.equal(mixed.state, state);
  assert.equal(mixed.errors[0].code, 'invalid_request');
  assert.equal(mixed.errors[0].fieldName, 'region');
  assert.deepEqual(Object.keys(mixed.state.draft).sort(), [
    'full_name',
    'programs',
  ]);

  const single = await discardDraftFields(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    fieldNames: ['full_name'],
  });
  assert.equal(single.ok, true);
  if (!single.ok) throw new Error('single discard failed');
  assert.equal(single.state.stateVersion, state.stateVersion + 1);
  assert.notEqual(single.state.planHash, state.planHash);
  assert.deepEqual(Object.keys(single.state.draft), ['programs']);
  assert.equal(single.state.validation.stateVersion, single.state.stateVersion);
  assert.equal(
    single.state.validation.issues.some(
      ({ code, fieldName }) =>
        code === 'required_missing' && fieldName === 'full_name',
    ),
    true,
  );
  assert.equal(Object.isFrozen(single), true);
  assert.equal(Object.isFrozen(single.state), true);
  assert.equal(Object.isFrozen(single.state.draft), true);

  const last = await discardDraftFields(single.state, {
    expectedStateVersion: single.state.stateVersion,
    expectedSourceHash: single.state.source.sourceHash,
    fieldNames: ['programs'],
  });
  assert.equal(last.ok, true);
  if (!last.ok) throw new Error('last discard failed');
  assert.equal(last.state.stateVersion, single.state.stateVersion + 1);
  assert.deepEqual(Object.keys(last.state.draft), []);
  assert.equal(Object.getPrototypeOf(last.state.draft), null);
  assert.equal(last.state.planHash, initial.planHash);
  assert.equal(last.state.validation.stateVersion, last.state.stateVersion);
});

void test('discarding a staged proposal invalidates approval and released output', async () => {
  const source = await createTextFormPdf('legal_name');
  const inspection = await inspectPdf(source);
  const initial = await createFormState(
    {
      fileName: 'identity.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    [
      {
        name: 'legal_name',
        label: 'Legal name',
        type: 'text',
        required: true,
        readOnly: false,
        humanOnly: false,
        sourceValue: '',
      },
    ],
  );
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'legal_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('release fixture failed to stage');
  const approved = approveDraftFromUi(staged.state, {
    expectedStateVersion: staged.state.stateVersion,
    expectedSourceHash: staged.state.source.sourceHash,
    expectedPlanHash: staged.state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['legal_name'],
  });
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error('release fixture approval failed');
  const released = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(released.ok, true);
  if (!released.ok) throw new Error('release fixture export failed');
  assert.notEqual(released.state.approval, null);
  assert.notEqual(released.state.output, null);
  assert.notEqual(released.state.verification, null);

  const discarded = await discardDraftFields(released.state, {
    expectedStateVersion: released.state.stateVersion,
    expectedSourceHash: released.state.source.sourceHash,
    fieldNames: ['legal_name'],
  });
  assert.equal(discarded.ok, true);
  if (!discarded.ok) throw new Error('released proposal discard failed');
  assert.deepEqual(Object.keys(discarded.state.draft), []);
  assert.equal(discarded.state.approval, null);
  assert.equal(discarded.state.output, null);
  assert.equal(discarded.state.verification, null);
  assert.equal(getReleaseGate(discarded.state).open, false);
});

void test('pins an empty UI correction and clears released workflow state', async () => {
  const source = await createTextFormPdf('legal_name');
  const inspection = await inspectPdf(source);
  const initial = await createFormState(
    {
      fileName: 'corrected-identity.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    [
      {
        name: 'legal_name',
        label: 'Legal name',
        type: 'text',
        required: true,
        readOnly: false,
        humanOnly: false,
        sourceValue: '',
      },
    ],
  );
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'legal_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('correction fixture failed to stage');
  const approved = approveDraftFromUi(staged.state, {
    expectedStateVersion: staged.state.stateVersion,
    expectedSourceHash: staged.state.source.sourceHash,
    expectedPlanHash: staged.state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['legal_name'],
  });
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error('correction fixture approval failed');
  const released = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(released.ok, true);
  if (!released.ok) throw new Error('correction fixture export failed');
  assert.notEqual(released.state.approval, null);
  assert.notEqual(released.state.output, null);
  assert.notEqual(released.state.verification, null);

  const corrected = await correctDraftFieldFromUi(released.state, {
    expectedStateVersion: released.state.stateVersion,
    expectedSourceHash: released.state.source.sourceHash,
    expectedPlanHash: released.state.planHash,
    fieldName: 'legal_name',
    value: '',
  });
  assert.equal(corrected.ok, true);
  if (!corrected.ok) throw new Error('human correction failed');
  assert.equal(corrected.state.stateVersion, released.state.stateVersion + 1);
  assert.notEqual(corrected.state.planHash, released.state.planHash);
  assert.deepEqual(corrected.changedFields, ['legal_name']);
  assert.deepEqual(corrected.state.draft.legal_name, {
    fieldName: 'legal_name',
    value: '',
    actor: 'human',
    provenance: { kind: 'human_entry', confidence: 1 },
  });
  assert.equal(getEffectiveFieldValue(corrected.state, 'legal_name'), '');
  assert.equal(
    corrected.state.validation.issues.some(
      ({ code, fieldName }) =>
        code === 'required_missing' && fieldName === 'legal_name',
    ),
    true,
  );
  assert.equal(corrected.state.approval, null);
  assert.equal(corrected.state.output, null);
  assert.equal(corrected.state.verification, null);
  assert.equal(Object.isFrozen(corrected.state.draft.legal_name), true);

  const agentOverwrite = await stageFieldUpdates(corrected.state, {
    expectedStateVersion: corrected.state.stateVersion,
    expectedSourceHash: corrected.state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'legal_name',
        value: 'Grace Hopper',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(agentOverwrite.ok, false);
  if (agentOverwrite.ok) throw new Error('agent replaced a human correction');
  assert.equal(agentOverwrite.state, corrected.state);
  assert.equal(
    agentOverwrite.errors.some(
      ({ code, fieldName }) =>
        code === 'human_pinned' && fieldName === 'legal_name',
    ),
    true,
  );
});

void test('rejects stale or ineligible UI corrections without changing the draft', async () => {
  const initial = await initialState();
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('correction rejection fixture failed');
  const state = staged.state;

  const cases = [
    {
      request: {
        expectedStateVersion: state.stateVersion - 1,
        expectedSourceHash: 'sha256:other',
        expectedPlanHash: 'sha256:other-plan',
        fieldName: 'full_name',
        value: 'Grace Hopper',
      },
      codes: ['stale_state', 'source_mismatch', 'plan_mismatch'],
    },
    {
      request: {
        expectedStateVersion: state.stateVersion,
        expectedSourceHash: state.source.sourceHash,
        expectedPlanHash: state.planHash,
        fieldName: 'missing',
        value: 'Grace Hopper',
      },
      codes: ['unknown_field', 'invalid_request'],
    },
    {
      request: {
        expectedStateVersion: state.stateVersion,
        expectedSourceHash: state.source.sourceHash,
        expectedPlanHash: state.planHash,
        fieldName: 'region',
        value: 'NY',
      },
      codes: ['invalid_request'],
    },
    {
      request: {
        expectedStateVersion: state.stateVersion,
        expectedSourceHash: state.source.sourceHash,
        expectedPlanHash: state.planHash,
        fieldName: 'case_id',
        value: 'B-200',
      },
      codes: ['read_only', 'invalid_request'],
    },
    {
      request: {
        expectedStateVersion: state.stateVersion,
        expectedSourceHash: state.source.sourceHash,
        expectedPlanHash: state.planHash,
        fieldName: 'attestation',
        value: true,
      },
      codes: ['human_only', 'invalid_request'],
    },
    {
      request: {
        expectedStateVersion: state.stateVersion,
        expectedSourceHash: state.source.sourceHash,
        expectedPlanHash: state.planHash,
        fieldName: 'signature',
        value: null,
      },
      codes: ['human_only', 'signature_locked', 'invalid_request'],
    },
  ] as const;

  for (const { request, codes } of cases) {
    const result = await correctDraftFieldFromUi(state, request);
    assert.equal(result.ok, false, request.fieldName);
    if (result.ok) throw new Error('ineligible correction succeeded');
    assert.equal(result.state, state, request.fieldName);
    const actualCodes = new Set(result.errors.map(({ code }) => code));
    for (const code of codes) {
      assert.equal(
        actualCodes.has(code),
        true,
        `${request.fieldName}: ${code}`,
      );
    }
  }
});

void test('atomically blocks every agent batch that touches a human pin until discard', async () => {
  const initial = await initialState();
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('human pin fixture failed to stage');
  const corrected = await correctDraftFieldFromUi(staged.state, {
    expectedStateVersion: staged.state.stateVersion,
    expectedSourceHash: staged.state.source.sourceHash,
    expectedPlanHash: staged.state.planHash,
    fieldName: 'full_name',
    value: 'Ada Lovelace',
  });
  assert.equal(corrected.ok, true);
  if (!corrected.ok) throw new Error('same-value human correction failed');
  assert.equal(corrected.state.draft.full_name.actor, 'human');
  assert.equal(corrected.state.stateVersion, staged.state.stateVersion + 1);

  const recorrection = await correctDraftFieldFromUi(corrected.state, {
    expectedStateVersion: corrected.state.stateVersion,
    expectedSourceHash: corrected.state.source.sourceHash,
    expectedPlanHash: corrected.state.planHash,
    fieldName: 'full_name',
    value: 'Grace Hopper',
  });
  assert.equal(recorrection.ok, false);
  if (recorrection.ok) throw new Error('human pin was corrected in place');
  assert.equal(recorrection.state, corrected.state);
  assert.deepEqual(
    recorrection.errors.map(({ code }) => code),
    ['invalid_request'],
  );

  const blocked = await stageFieldUpdates(corrected.state, {
    expectedStateVersion: corrected.state.stateVersion,
    expectedSourceHash: corrected.state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'region',
        value: 'NY',
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'full_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(blocked.ok, false);
  if (blocked.ok) throw new Error('agent overwrote a human pin');
  assert.equal(blocked.state, corrected.state);
  assert.deepEqual(
    blocked.errors.map(({ code, fieldName }) => ({ code, fieldName })),
    [{ code: 'human_pinned', fieldName: 'full_name' }],
  );
  assert.equal(blocked.state.draft.region, undefined);

  const discarded = await discardDraftFields(corrected.state, {
    expectedStateVersion: corrected.state.stateVersion,
    expectedSourceHash: corrected.state.source.sourceHash,
    fieldNames: ['full_name'],
  });
  assert.equal(discarded.ok, true);
  if (!discarded.ok) throw new Error('human pin discard failed');
  assert.equal(discarded.state.draft.full_name, undefined);

  const reproposed = await stageFieldUpdates(discarded.state, {
    expectedStateVersion: discarded.state.stateVersion,
    expectedSourceHash: discarded.state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Grace Hopper',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(reproposed.ok, true);
  if (!reproposed.ok)
    throw new Error('agent could not repropose after discard');
  assert.equal(reproposed.state.draft.full_name.actor, 'agent');
  assert.equal(reproposed.state.draft.full_name.value, 'Grace Hopper');
});

void test('rejects duplicate, unknown, read-only, human-only, signature, type, and provenance violations', async () => {
  const state = await initialState();
  const result = await stageFieldUpdates(state, {
    expectedStateVersion: 0,
    expectedSourceHash: SOURCE.sourceHash,
    actor: 'agent',
    updates: [
      { fieldName: 'full_name', value: 'Ada', provenance: USER_PROVENANCE },
      { fieldName: 'full_name', value: 'Grace', provenance: USER_PROVENANCE },
      { fieldName: 'missing', value: 'x', provenance: USER_PROVENANCE },
      { fieldName: 'case_id', value: 'B-200', provenance: USER_PROVENANCE },
      { fieldName: 'attestation', value: true, provenance: USER_PROVENANCE },
      { fieldName: 'signature', value: 'signed', provenance: USER_PROVENANCE },
      { fieldName: 'region', value: true, provenance: USER_PROVENANCE },
      {
        fieldName: 'programs',
        value: ['Vision'],
        provenance: { kind: 'human_entry', confidence: 2 },
      },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unsafe batch unexpectedly succeeded');
  const codes = new Set(result.errors.map(({ code }) => code));
  for (const expected of [
    'duplicate_update',
    'unknown_field',
    'read_only',
    'human_only',
    'signature_locked',
    'invalid_type',
    'invalid_option',
    'invalid_provenance',
  ]) {
    assert.equal(codes.has(expected as never), true, `missing ${expected}`);
  }
  assert.equal(result.state, state);
});

void test('rejects unsupported text and choice control characters', async () => {
  const state = await initialState();
  for (const value of [
    'Ada\u0000Lovelace',
    'Ada\u202eLovelace',
    'Ada\u200fLovelace',
  ]) {
    const result = await stageFieldUpdates(state, {
      expectedStateVersion: state.stateVersion,
      expectedSourceHash: state.source.sourceHash,
      actor: 'agent',
      updates: [
        {
          fieldName: 'full_name',
          value,
          provenance: USER_PROVENANCE,
        },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unsupported control character was staged');
    assert.equal(result.errors[0].code, 'invalid_type');
  }

  const optionListResult = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'programs',
        value: ['Health\u202e'],
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(optionListResult.ok, false);
  if (optionListResult.ok) {
    throw new Error('option-list control character was staged');
  }
  assert.equal(optionListResult.errors[0].code, 'invalid_type');

  const dropdownResult = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'region',
        value: 'CA\u202e',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(dropdownResult.ok, false);
  if (dropdownResult.ok) throw new Error('dropdown bidi control was staged');
  assert.equal(dropdownResult.errors[0].code, 'invalid_type');

  const multiSelectResult = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'programs',
        value: ['Health\u061c'],
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(multiSelectResult.ok, false);
  if (multiSelectResult.ok) {
    throw new Error('multi-select bidi control was staged');
  }
  assert.equal(multiSelectResult.errors[0].code, 'invalid_type');
});

void test('accepts multiline text and counts maxLength in code points', async () => {
  const state = await createFormState(SOURCE, [
    {
      name: 'bounded_text',
      label: 'Bounded text',
      type: 'text',
      required: false,
      readOnly: false,
      humanOnly: false,
      maxLength: 2,
      sourceValue: '',
    },
    {
      name: 'multiline_text',
      label: 'Multiline text',
      type: 'text',
      required: false,
      readOnly: false,
      humanOnly: false,
      sourceValue: '',
    },
  ]);
  const result = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'bounded_text',
        value: '🙂🙂',
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'multiline_text',
        value: 'Line one\nLine two',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('valid Unicode text was rejected');
  assert.equal(result.state.draft.bounded_text.value, '🙂🙂');
  assert.equal(result.state.draft.multiline_text.value, 'Line one\nLine two');
});

void test('treats whitespace-only required text as missing', async () => {
  const state = await initialState();
  const result = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: '   ',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('whitespace staging unexpectedly failed');
  assert.equal(result.state.validation.canApprove, false);
  assert.ok(
    result.state.validation.issues.some(
      ({ code, fieldName }) =>
        code === 'required_missing' && fieldName === 'full_name',
    ),
  );
});

void test('returns invalid_provenance for malformed runtime provenance', async () => {
  const state = await initialState();
  const malformed = [
    {
      kind: 'source_document',
      confidence: 1,
      evidence: 42,
    } as unknown as FieldProvenance,
    null as unknown as FieldProvenance,
  ];

  for (const provenance of malformed) {
    const result = await stageFieldUpdates(state, {
      expectedStateVersion: state.stateVersion,
      expectedSourceHash: state.source.sourceHash,
      actor: 'agent',
      updates: [
        {
          fieldName: 'full_name',
          value: 'Ada Lovelace',
          provenance,
        },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('malformed provenance was staged');
    assert.equal(result.errors[0].code, 'invalid_provenance');
    assert.equal(result.state, state);
  }
});

void test('rejects control characters in provenance with exact paths', async () => {
  const state = await initialState();
  for (const [provenance, path] of [
    [
      {
        kind: 'user_instruction',
        confidence: 0.9,
        evidence: ['safe', 'unsafe\u202e'],
      },
      'updates[0].provenance.evidence[1]',
    ],
    [
      {
        kind: 'user_instruction',
        confidence: 0.9,
        rationale: 'unsafe\u200f',
      },
      'updates[0].provenance.rationale',
    ],
  ] as const) {
    const result = await stageFieldUpdates(state, {
      expectedStateVersion: state.stateVersion,
      expectedSourceHash: state.source.sourceHash,
      actor: 'agent',
      updates: [
        {
          fieldName: 'full_name',
          value: 'Ada Lovelace',
          provenance,
        },
      ],
    });
    assert.equal(result.ok, false, path);
    if (result.ok) throw new Error(`${path} was staged`);
    assert.deepEqual(result.errors[0], {
      code: 'invalid_provenance',
      fieldName: 'full_name',
      path,
      message: `${path} contains unsupported control characters.`,
    });
  }
});

void test('enforces per-field and cumulative provenance budgets atomically', async () => {
  const oneField = await createFormState(SOURCE, [
    {
      name: 'evidence',
      label: 'Evidence',
      type: 'text',
      required: false,
      readOnly: false,
      humanOnly: false,
      sourceValue: '',
    },
  ]);
  const maximumEvidence = Array.from(
    { length: MAX_PROVENANCE_EVIDENCE_ITEMS },
    (_, index) => `${index}${'x'.repeat(MAX_PROVENANCE_TEXT_LENGTH - 1)}`,
  );
  const accepted = await stageFieldUpdates(oneField, {
    expectedStateVersion: oneField.stateVersion,
    expectedSourceHash: oneField.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'evidence',
        value: 'accepted',
        provenance: {
          kind: 'source_document',
          confidence: 1,
          evidence: maximumEvidence,
        },
      },
    ],
  });
  assert.equal(accepted.ok, true);

  for (const [label, evidence] of [
    ['six items', [...maximumEvidence, 'sixth']],
    ['long item', ['x'.repeat(MAX_PROVENANCE_TEXT_LENGTH + 1)]],
    ['duplicate item', ['same', 'same']],
  ] as const) {
    const rejected = await stageFieldUpdates(oneField, {
      expectedStateVersion: oneField.stateVersion,
      expectedSourceHash: oneField.source.sourceHash,
      actor: 'agent',
      updates: [
        {
          fieldName: 'evidence',
          value: label,
          provenance: {
            kind: 'source_document',
            confidence: 1,
            evidence,
          },
        },
      ],
    });
    assert.equal(rejected.ok, false, label);
    if (rejected.ok) throw new Error(`${label} provenance was accepted`);
    assert.equal(rejected.errors[0].code, 'invalid_provenance', label);
    assert.equal(rejected.state, oneField, label);
  }

  const aggregateFieldCount = Math.ceil(
    MAX_PLAN_PROVENANCE_UTF8_BYTES /
      (MAX_PROVENANCE_EVIDENCE_ITEMS * MAX_PROVENANCE_TEXT_LENGTH),
  );
  assert.ok(
    aggregateFieldCount * MAX_PROVENANCE_EVIDENCE_ITEMS <=
      MAX_PLAN_PROVENANCE_ITEMS,
  );
  const aggregateFields = Array.from(
    { length: aggregateFieldCount },
    (_, index): FormFieldDefinition => ({
      name: `field_${index}`,
      label: `Field ${index}`,
      type: 'text',
      required: false,
      readOnly: false,
      humanOnly: false,
      sourceValue: '',
    }),
  );
  const aggregateState = await createFormState(SOURCE, aggregateFields);
  const aggregate = await stageFieldUpdates(aggregateState, {
    expectedStateVersion: aggregateState.stateVersion,
    expectedSourceHash: aggregateState.source.sourceHash,
    actor: 'agent',
    updates: aggregateFields.map((field, fieldIndex) => ({
      fieldName: field.name,
      value: 'candidate',
      provenance: {
        kind: 'source_document' as const,
        confidence: 1,
        evidence: Array.from(
          { length: MAX_PROVENANCE_EVIDENCE_ITEMS },
          (_, evidenceIndex) =>
            `${fieldIndex}:${evidenceIndex}:`.padEnd(
              MAX_PROVENANCE_TEXT_LENGTH,
              'x',
            ),
        ),
      },
    })),
  });
  assert.equal(aggregate.ok, false);
  if (aggregate.ok) throw new Error('aggregate provenance was accepted');
  assert.equal(aggregate.errors[0].code, 'invalid_provenance');
  assert.equal(aggregate.state, aggregateState);
  assert.equal(aggregateState.stateVersion, 0);
  assert.equal(Object.keys(aggregateState.draft).length, 0);
});

void test('rejects null for optional checkboxes at configuration and staging boundaries', async () => {
  const optionalCheckbox: FormFieldDefinition = {
    name: 'optional_checkbox',
    label: 'Optional checkbox',
    type: 'checkbox',
    required: false,
    readOnly: false,
    humanOnly: false,
    sourceValue: false,
  };
  const state = await createFormState(SOURCE, [optionalCheckbox]);
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: optionalCheckbox.name,
        value: null,
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, false);
  if (staged.ok) throw new Error('null checkbox value was staged');
  assert.equal(staged.state, state);
  assert.equal(staged.errors[0].code, 'invalid_type');

  await assert.rejects(
    createFormState(SOURCE, [{ ...optionalCheckbox, sourceValue: null }]),
    /optional_checkbox requires a boolean/,
  );
});

void test('enforces and preserves choice multiplicity for dropdowns and option lists', async () => {
  const definitions: FormFieldDefinition[] = [
    {
      name: 'multi_dropdown',
      label: 'Multi dropdown',
      type: 'dropdown',
      required: false,
      readOnly: false,
      humanOnly: false,
      options: ['north', 'south'],
      multiSelect: true,
      sourceValue: [],
    },
    {
      name: 'single_option_list',
      label: 'Single option list',
      type: 'option-list',
      required: false,
      readOnly: false,
      humanOnly: false,
      options: ['red', 'blue'],
      multiSelect: false,
      sourceValue: null,
    },
  ];
  const state = await createFormState(SOURCE, definitions);
  assert.equal(state.fields.multi_dropdown.multiSelect, true);
  assert.equal(state.fields.single_option_list.multiSelect, false);
  assert.equal(
    getFormContext(state).fields.find(
      ({ definition }) => definition.name === 'single_option_list',
    )?.definition.multiSelect,
    false,
  );

  const wrongMultiplicity = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'multi_dropdown',
        value: 'north',
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'single_option_list',
        value: ['red'],
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(wrongMultiplicity.ok, false);
  if (wrongMultiplicity.ok) {
    throw new Error('invalid choice multiplicity was staged');
  }
  assert.equal(
    wrongMultiplicity.errors.filter(({ code }) => code === 'invalid_type')
      .length,
    2,
  );
  assert.equal(wrongMultiplicity.state, state);

  const valid = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'multi_dropdown',
        value: ['north', 'south'],
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'single_option_list',
        value: 'red',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(valid.ok, true);
  if (!valid.ok) throw new Error('valid choice multiplicity was rejected');
  assert.deepEqual(valid.state.draft.multi_dropdown.value, ['north', 'south']);
  assert.equal(valid.state.draft.single_option_list.value, 'red');

  const cleared = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'multi_dropdown',
        value: null,
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'single_option_list',
        value: null,
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) throw new Error('choice clears were rejected');
  assert.deepEqual(cleared.state.draft.multi_dropdown.value, []);
  assert.equal(cleared.state.draft.single_option_list.value, null);

  const sameShapeDifferentMultiplicity = await Promise.all([
    createFormState(SOURCE, [
      { ...definitions[1], multiSelect: false, sourceValue: null },
    ]),
    createFormState(SOURCE, [
      { ...definitions[1], multiSelect: true, sourceValue: null },
    ]),
  ]);
  assert.notEqual(
    sameShapeDifferentMultiplicity[0].planHash,
    sameShapeDifferentMultiplicity[1].planHash,
  );
});

void test('surfaces inference and low confidence exactly once in the review queue', async () => {
  const state = await initialState();
  const result = await stageFieldUpdates(state, {
    expectedStateVersion: 0,
    expectedSourceHash: SOURCE.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Possibly Ada',
        provenance: {
          kind: 'agent_inference',
          confidence: 0.6,
          rationale: 'Name inferred from the salutation.',
        },
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('inference staging failed');
  const report = validateDraft(result.state);
  assert.deepEqual(report.reviewFieldNames, ['attestation', 'full_name']);
  assert.equal(report.reviewCount, 3);
  assert.equal(report.canApprove, true);
});

void test('requires human review for every agent claim regardless of claimed basis', async () => {
  const state = await initialState();
  const result = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Ada Lovelace',
        provenance: { kind: 'user_instruction', confidence: 1 },
      },
      {
        fieldName: 'region',
        value: 'NY',
        provenance: {
          kind: 'source_document',
          confidence: 1,
          evidence: ['Page 1, region field'],
        },
      },
      {
        fieldName: 'programs',
        value: ['Health'],
        provenance: {
          kind: 'agent_inference',
          confidence: 1,
          rationale: 'Inferred from the supplied benefits description.',
        },
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('agent claim staging failed');

  const report = validateDraft(result.state);
  assert.deepEqual(
    report.issues
      .filter(({ code }) => code === 'agent_assertion_requires_review')
      .map(({ fieldName }) => fieldName)
      .sort(),
    ['full_name', 'programs', 'region'],
  );
  assert.equal(report.canApprove, true);
});

void test('allows confirmed post-export human completion without letting the agent stage it', async () => {
  const completionFields = fields().map((field) => {
    if (field.name === 'full_name') {
      return { ...field, sourceValue: 'Ada Lovelace' };
    }
    if (field.name === 'signature') {
      return { ...field, required: true };
    }
    return field;
  });
  let state = await createFormState(SOURCE, completionFields);
  const report = validateDraft(state);
  assert.equal(report.blockerCount, 0);
  assert.equal(report.canApprove, true);
  assert.deepEqual(report.reviewFieldNames, ['attestation', 'signature']);
  assert.deepEqual(
    report.issues
      .filter(({ code }) => code === 'human_completion_required')
      .map(({ fieldName }) => fieldName),
    ['attestation', 'signature'],
  );

  const agentAttempt = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'attestation',
        value: true,
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'signature',
        value: 'agent signature',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(agentAttempt.ok, false);
  if (agentAttempt.ok) throw new Error('agent changed a human-only field');
  assert.equal(agentAttempt.state, state);
  assert.equal(
    agentAttempt.errors.some(({ code }) => code === 'human_only'),
    true,
  );
  assert.equal(
    agentAttempt.errors.some(({ code }) => code === 'signature_locked'),
    true,
  );

  const unconfirmed = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: [],
  });
  assert.equal(unconfirmed.ok, false);
  if (unconfirmed.ok) throw new Error('unconfirmed human work was approved');
  assert.equal(
    unconfirmed.errors.some(({ code }) => code === 'review_unconfirmed'),
    true,
  );

  const approved = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['attestation', 'signature'],
  });
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error('confirmed human completion was blocked');
  state = approved.state;
  assert.equal(getExportGate(state).open, true);
});

void test('human approval is bound to source, plan, version, and explicit review confirmations', async () => {
  let state = await stageRequiredValues();
  const inference = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'region',
        value: 'NY',
        provenance: {
          kind: 'agent_inference',
          confidence: 0.9,
          rationale: 'Mailing address appears to be in New York.',
        },
      },
    ],
  });
  assert.equal(inference.ok, true);
  if (!inference.ok) throw new Error('inference staging failed');
  state = inference.state;

  const unconfirmed = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: [],
  });
  assert.equal(unconfirmed.ok, false);
  if (unconfirmed.ok)
    throw new Error('unconfirmed review unexpectedly approved');
  assert.equal(unconfirmed.errors[0].code, 'review_unconfirmed');

  const approved = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    approvedAt: '2026-08-29T18:10:00.000Z',
    confirmedFieldNames: ['attestation', 'full_name', 'region'],
  });
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error('approval failed');
  state = approved.state;
  assert.deepEqual(
    {
      sourceHash: state.approval?.sourceHash,
      planHash: state.approval?.planHash,
      stateVersion: state.approval?.stateVersion,
    },
    {
      sourceHash: state.source.sourceHash,
      planHash: state.planHash,
      stateVersion: state.stateVersion,
    },
  );
  assert.equal(getExportGate(state).open, true);

  const changed = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Ada Byron',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(changed.ok, true);
  if (!changed.ok) throw new Error('restaging failed');
  assert.equal(changed.state.approval, null);
  assert.equal(getExportGate(changed.state).open, false);
});

void test('exports a deterministic source-bound fill package for protected hybrid XFA fields', async () => {
  const { source, sourceSnapshot, inspection, state } =
    await stagedProtectedForm();
  assert.equal(inspection.protection.protectionType, 'usage_rights');
  assert.equal(inspection.protection.evidence.xfaPresent, true);
  assert.deepEqual(inspection.protection.exportStrategies, ['fill_package']);

  const incomplete = await exportFillPackageFromUi(state, source, {
    confirmedFieldNames: ['formproof.applicant_name'],
    createdAt: '2026-08-29T18:15:00.000Z',
  });
  assert.equal(incomplete.ok, false);
  if (incomplete.ok) throw new Error('incompletely confirmed package exported');
  assert.equal(incomplete.state, state);
  assert.equal(incomplete.errors[0].code, 'review_unconfirmed');
  assert.match(incomplete.errors[0].message, /opaque\.f1_02/u);

  const request = {
    confirmedFieldNames: ['opaque.f1_02', 'formproof.applicant_name'],
    createdAt: '2026-08-29T18:15:00.000Z',
  } as const;
  const first = await exportFillPackageFromUi(state, source, request);
  const second = await exportFillPackageFromUi(state, source, request);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    throw new Error('confirmed protected fill package failed');
  }
  assert.equal(first.state, state);
  assert.deepEqual(first.result.bytes, second.result.bytes);
  assert.equal(first.result.outputHash, second.result.outputHash);
  assert.deepEqual(first.result.manifest, second.result.manifest);
  assert.equal(first.result.roundTripVerified, true);

  const manifest = first.result.manifest;
  const parsed = JSON.parse(
    new TextDecoder().decode(first.result.bytes),
  ) as typeof manifest;
  assert.deepEqual(parsed, manifest);
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.createdAt, request.createdAt);
  assert.equal(manifest.sourcePdfModified, false);
  assert.deepEqual(manifest.source, {
    fileName: state.source.fileName,
    sourceHash: state.source.sourceHash,
    byteLength: state.source.byteLength,
    pageCount: state.source.pageCount,
  });
  assert.equal(manifest.plan.stateVersion, state.stateVersion);
  assert.equal(manifest.plan.planHash, state.planHash);
  assert.deepEqual(manifest.plan.confirmedFieldNames, [
    'formproof.applicant_name',
    'opaque.f1_02',
  ]);

  const descriptors = new Map(
    inspection.fields.map((field) => [field.name, field] as const),
  );
  const semanticDescriptor = descriptors.get('formproof.applicant_name');
  const opaqueDescriptor = descriptors.get('opaque.f1_02');
  assert.notEqual(semanticDescriptor, undefined);
  assert.notEqual(opaqueDescriptor, undefined);
  if (semanticDescriptor === undefined || opaqueDescriptor === undefined) {
    throw new Error('protected fixture descriptors disappeared');
  }
  const packageFields = new Map(
    manifest.plan.stagedFields.map(
      (field) => [field.fieldName, field] as const,
    ),
  );
  assert.deepEqual(packageFields.get('formproof.applicant_name'), {
    fieldName: 'formproof.applicant_name',
    label: 'Applicant name',
    semanticLabelAvailable: true,
    type: 'text',
    required: false,
    multiSelect: semanticDescriptor.multiSelect,
    choices: semanticDescriptor.choices,
    widgets: semanticDescriptor.widgets,
    page: semanticDescriptor.page,
    rect: semanticDescriptor.rect,
    sourceValue: 'Original applicant',
    proposedValue: 'Ada Lovelace',
    provenance: USER_PROVENANCE,
  });
  assert.deepEqual(packageFields.get('opaque.f1_02'), {
    fieldName: 'opaque.f1_02',
    label: 'opaque.f1_02',
    semanticLabelAvailable: false,
    type: 'text',
    required: false,
    multiSelect: opaqueDescriptor.multiSelect,
    choices: opaqueDescriptor.choices,
    widgets: opaqueDescriptor.widgets,
    page: opaqueDescriptor.page,
    rect: opaqueDescriptor.rect,
    sourceValue: 'Original opaque value',
    proposedValue: 'Synthetic opaque value',
    provenance: OPAQUE_FIELD_PROVENANCE,
  });
  assert.notEqual(
    packageFields.get('opaque.f1_02')?.rect,
    opaqueDescriptor.rect,
  );
  assert.deepEqual(manifest.plan.humanSteps, [
    {
      fieldName: 'formproof.applicant_name',
      label: 'Applicant name',
      type: 'text',
      required: false,
      multiSelect: false,
      sourceValue: 'Original applicant',
      choices: semanticDescriptor.choices,
      widgets: semanticDescriptor.widgets,
      page: semanticDescriptor.page,
      rect: semanticDescriptor.rect,
      reason: 'review_required',
    },
    {
      fieldName: 'opaque.f1_02',
      label: 'opaque.f1_02',
      type: 'text',
      required: false,
      multiSelect: false,
      sourceValue: 'Original opaque value',
      choices: opaqueDescriptor.choices,
      widgets: opaqueDescriptor.widgets,
      page: opaqueDescriptor.page,
      rect: opaqueDescriptor.rect,
      reason: 'review_required',
    },
  ]);

  assert.deepEqual(manifest.protection, inspection.protection);
  assert.notEqual(manifest.protection, inspection.protection);
  assert.equal(manifest.protection.protectionType, 'usage_rights');
  assert.deepEqual(manifest.protection.allowedMutations, [
    'inspect_fields',
    'stage_field_values',
    'create_fill_package',
  ]);
  assert.equal(
    manifest.protection.signatureImpact,
    'rewrite_would_invalidate_usage_rights',
  );
  assert.deepEqual(manifest.protection.evidence.usageRightsKeys, ['UR3']);
  assert.equal(manifest.protection.evidence.xfaPresent, true);
  assert.equal(
    manifest.limitations.some((item) =>
      item.includes('no bounded semantic label'),
    ),
    true,
  );
  assert.equal(
    manifest.limitations.some((item) =>
      item.includes(
        'AcroForm fallback field names, choice values, choice-to-widget mappings, appearance states, and geometry remain authoritative',
      ),
    ),
    true,
  );
  assert.equal(
    manifest.limitations.some((item) =>
      item.includes(
        'bounded static XFA exclGroup caption is used only when its full SOM name and complete choice value set match exactly',
      ),
    ),
    true,
  );
  assert.equal(
    manifest.limitations.some((item) =>
      item.includes(
        'XFA scripts, calculations, validation, dynamic choices, and layout are not executed',
      ),
    ),
    true,
  );
  assert.equal(
    manifest.limitations.some((item) => item.includes('XFA choices')),
    false,
  );

  const serializedManifest = JSON.stringify(parsed);
  assert.doesNotMatch(
    serializedManifest,
    /"(?:appearanceVerified|normalAppearancePresent|appearancesPresent|fieldValuesMatch|signatureIntegrityPreserved|verifiedFields)"/u,
  );
  assert.equal(state.output, null);
  assert.equal(state.verification, null);
  assert.deepEqual(source, sourceSnapshot, 'source PDF bytes were modified');
});

void test('refuses to export a fill package that a fresh state could not import', async () => {
  const source = await createTextFormPdf('large_value');
  const inspection = await inspectPdf(source);
  const state = await createFormState(
    {
      fileName: 'large-value.pdf',
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
        fieldName: 'large_value',
        value: 'x'.repeat(MAX_FILL_PACKAGE_BYTES),
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('large fill-package fixture did not stage');

  const exported = await exportFillPackageFromUi(staged.state, source, {
    confirmedFieldNames: ['large_value'],
    createdAt: '2026-08-30T12:00:00.000Z',
  });
  assert.equal(exported.ok, false);
  if (exported.ok) throw new Error('oversized fill package was exported');
  assert.equal(exported.errors[0].code, 'package_too_large');
  assert.equal(exported.state, staged.state);
});

void test('restores a source-bound fill package as untrusted proposals without restoring approval', async () => {
  const { source, sourceSnapshot, inspection, state } =
    await stagedProtectedForm();
  const corrected = await correctDraftFieldFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    fieldName: 'formproof.applicant_name',
    value: 'Grace Hopper',
  });
  assert.equal(corrected.ok, true);
  if (!corrected.ok) throw new Error('fill-package correction failed');
  const confirmedFieldNames = getArtifactReviewFieldNames(corrected.state);
  const exported = await exportFillPackageFromUi(corrected.state, source, {
    confirmedFieldNames,
    createdAt: '2026-08-30T12:00:00.000Z',
  });
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('restorable fill package failed');

  const fresh = await createFormState(
    {
      fileName: 'renamed-protected-hybrid.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const imported = await importFillPackageFromUi(
    fresh,
    source,
    exported.result.bytes,
    inspection,
  );
  assert.equal(imported.ok, true);
  if (!imported.ok) throw new Error('fill-package import failed');

  assert.deepEqual(imported.receipt, {
    packageHash: exported.result.outputHash,
    sourceHash: fresh.source.sourceHash,
    recordedPlanHash: corrected.state.planHash,
    restoredPlanHash: corrected.state.planHash,
    sourceHashVerified: true,
    planHashVerified: true,
    authenticityVerified: false,
    packageDisplayMetadataUsed: false,
    sourcePdfModified: false,
    importedFieldNames: ['formproof.applicant_name', 'opaque.f1_02'],
  });
  assert.equal(imported.state.stateVersion, fresh.stateVersion + 1);
  assert.equal(imported.state.planHash, corrected.state.planHash);
  assert.equal(imported.state.documentSessionId, fresh.documentSessionId);
  assert.notEqual(
    imported.state.documentSessionId,
    corrected.state.documentSessionId,
  );
  assert.equal(imported.state.approval, null);
  assert.equal(imported.state.output, null);
  assert.equal(imported.state.verification, null);
  assert.deepEqual(imported.state.importedProposalFieldNames, [
    'formproof.applicant_name',
    'opaque.f1_02',
  ]);
  assert.equal(imported.state.draft['formproof.applicant_name'].actor, 'human');
  assert.equal(
    imported.state.draft['formproof.applicant_name'].provenance.kind,
    'human_entry',
  );
  assert.equal(
    imported.state.validation.issues.some(
      ({ code, fieldName }) =>
        code === 'agent_assertion_requires_review' &&
        fieldName === 'formproof.applicant_name',
    ),
    true,
  );
  assert.equal(imported.state.draft['opaque.f1_02'].actor, 'agent');
  const importedHumanContext = getFormContext(imported.state).fields.find(
    ({ definition }) => definition.name === 'formproof.applicant_name',
  );
  assert.equal(importedHumanContext?.importedProposal, true);
  assert.equal(Object.hasOwn(importedHumanContext ?? {}, 'humanPinned'), false);
  assert.deepEqual(
    getFormContext(imported.state)
      .fields.filter(({ importedProposal }) => importedProposal)
      .map(({ definition }) => definition.name),
    ['formproof.applicant_name', 'opaque.f1_02'],
  );
  assert.deepEqual(
    source,
    sourceSnapshot,
    'fill-package import changed PDF bytes',
  );

  const agentOverwrite = await stageFieldUpdates(imported.state, {
    expectedStateVersion: imported.state.stateVersion,
    expectedSourceHash: imported.state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'formproof.applicant_name',
        value: 'Katherine Johnson',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(agentOverwrite.ok, true);
  if (!agentOverwrite.ok) {
    throw new Error('agent could not replace an untrusted imported proposal');
  }
  assert.equal(
    agentOverwrite.state.draft['formproof.applicant_name'].actor,
    'agent',
  );
  assert.deepEqual(agentOverwrite.state.importedProposalFieldNames, [
    'opaque.f1_02',
  ]);

  const humanCorrection = await correctDraftFieldFromUi(imported.state, {
    expectedStateVersion: imported.state.stateVersion,
    expectedSourceHash: imported.state.source.sourceHash,
    expectedPlanHash: imported.state.planHash,
    fieldName: 'formproof.applicant_name',
    value: 'Margaret Hamilton',
  });
  assert.equal(humanCorrection.ok, true);
  if (!humanCorrection.ok) {
    throw new Error(
      'imported human-authored proposal could not be re-reviewed',
    );
  }
  assert.equal(
    humanCorrection.state.draft['formproof.applicant_name'].actor,
    'human',
  );
  assert.deepEqual(humanCorrection.state.importedProposalFieldNames, [
    'opaque.f1_02',
  ]);
});

void test('ignores package display claims and rejects malformed or tampered actionable content', async () => {
  const { source, inspection, state } = await stagedProtectedForm();
  const confirmedFieldNames = getArtifactReviewFieldNames(state);
  const exported = await exportFillPackageFromUi(state, source, {
    confirmedFieldNames,
    createdAt: '2026-08-30T12:10:00.000Z',
  });
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('adversarial fill package failed');

  const freshState = () =>
    createFormState(
      {
        fileName: 'protected-hybrid.pdf',
        sourceHash: inspection.sourceHash,
        byteLength: source.byteLength,
        pageCount: inspection.pageCount,
      },
      inspection.fields.map(createFormFieldDefinitionFromPdf),
    );
  const parsed = () =>
    JSON.parse(new TextDecoder().decode(exported.result.bytes)) as {
      schemaVersion: number;
      source: { sourceHash: string };
      protection: { protectionType: string };
      plan: {
        planHash: string;
        stagedFields: Array<{
          fieldName: string;
          label: string;
          page: number | null;
          proposedValue: FormFieldValue;
          provenance: {
            kind: string;
            confidence: number;
            evidence?: string[];
            rationale?: string;
          };
        }>;
      };
    };
  const encode = (value: unknown) =>
    new TextEncoder().encode(`${JSON.stringify(value)}\n`);

  const forgedDisplay = parsed();
  forgedDisplay.protection.protectionType = 'none';
  forgedDisplay.plan.stagedFields[0].label = 'Forged package label';
  forgedDisplay.plan.stagedFields[0].page = 999;
  const displayImport = await importFillPackageFromUi(
    await freshState(),
    source,
    encode(forgedDisplay),
    inspection,
  );
  assert.equal(displayImport.ok, true);
  if (!displayImport.ok)
    throw new Error('ignored display claims blocked import');
  assert.equal(displayImport.receipt.packageDisplayMetadataUsed, false);
  assert.equal(
    displayImport.state.fields[forgedDisplay.plan.stagedFields[0].fieldName]
      .label,
    inspection.fields.find(
      ({ name }) => name === forgedDisplay.plan.stagedFields[0].fieldName,
    )?.tooltip,
  );

  const cases: Array<{
    name: string;
    mutate(value: ReturnType<typeof parsed>): void;
    expectedCode: string;
  }> = [
    {
      name: 'tampered value',
      mutate(value) {
        value.plan.stagedFields[0].proposedValue = 'Tampered value';
      },
      expectedCode: 'plan_mismatch',
    },
    {
      name: 'source swap',
      mutate(value) {
        value.source.sourceHash = 'f'.repeat(64);
      },
      expectedCode: 'source_mismatch',
    },
    {
      name: 'duplicate field',
      mutate(value) {
        value.plan.stagedFields[1] = structuredClone(
          value.plan.stagedFields[0],
        );
      },
      expectedCode: 'duplicate_update',
    },
    {
      name: 'unknown field',
      mutate(value) {
        value.plan.stagedFields[0].fieldName = '__missing_field__';
      },
      expectedCode: 'unknown_field',
    },
    {
      name: 'invalid provenance',
      mutate(value) {
        value.plan.stagedFields[0].provenance.confidence = 2;
      },
      expectedCode: 'invalid_provenance',
    },
    {
      name: 'too many provenance evidence items',
      mutate(value) {
        value.plan.stagedFields[0].provenance.evidence = Array.from(
          { length: MAX_PROVENANCE_EVIDENCE_ITEMS + 1 },
          (_, index) => `evidence ${index}`,
        );
      },
      expectedCode: 'invalid_provenance',
    },
    {
      name: 'oversized provenance evidence item',
      mutate(value) {
        value.plan.stagedFields[0].provenance.evidence = [
          'x'.repeat(MAX_PROVENANCE_TEXT_LENGTH + 1),
        ];
      },
      expectedCode: 'invalid_provenance',
    },
    {
      name: 'unsupported schema',
      mutate(value) {
        value.schemaVersion = 3;
      },
      expectedCode: 'unsupported_package_schema',
    },
  ];
  for (const testCase of cases) {
    const { name, expectedCode } = testCase;
    const candidate = parsed();
    testCase.mutate(candidate);
    const cleanState = await freshState();
    const result = await importFillPackageFromUi(
      cleanState,
      source,
      encode(candidate),
      inspection,
    );
    assert.equal(result.ok, false, name);
    if (result.ok) throw new Error(`${name} unexpectedly imported`);
    assert.equal(result.state, cleanState, name);
    assert.equal(
      result.errors.some(({ code }) => code === expectedCode),
      true,
      name,
    );
  }

  const oversized = await importFillPackageFromUi(
    await freshState(),
    source,
    new Uint8Array(MAX_FILL_PACKAGE_BYTES + 1),
    inspection,
  );
  assert.equal(oversized.ok, false);
  if (oversized.ok) throw new Error('oversized package imported');
  assert.equal(oversized.errors[0].code, 'package_too_large');

  for (const invalidBytes of [
    new Uint8Array([0xff]),
    new TextEncoder().encode('{not-json'),
  ]) {
    const invalid = await importFillPackageFromUi(
      await freshState(),
      source,
      invalidBytes,
      inspection,
    );
    assert.equal(invalid.ok, false);
    if (invalid.ok) throw new Error('invalid JSON package imported');
    assert.equal(invalid.errors[0].code, 'invalid_package');
  }

  const mergeAttempt = await importFillPackageFromUi(
    state,
    source,
    exported.result.bytes,
    inspection,
  );
  assert.equal(mergeAttempt.ok, false);
  if (mergeAttempt.ok) throw new Error('package merged over a live draft');
  assert.equal(mergeAttempt.errors[0].code, 'invalid_request');
});

void test('puts every unstaged required blocker into the actionable fill-package steps', async () => {
  const source = await createProtectedFormPdf({ requiredOpaque: true });
  const inspection = await inspectPdf(source);
  const initial = await createFormState(
    {
      fileName: 'required-protected.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const staged = await stageFieldUpdates(initial, {
    expectedStateVersion: initial.stateVersion,
    expectedSourceHash: initial.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'formproof.applicant_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('required protected staging failed');
  assert.ok(
    staged.state.validation.issues.some(
      ({ code, fieldName }) =>
        code === 'required_missing' && fieldName === 'opaque.f1_02',
    ),
  );

  const unconfirmed = await exportFillPackageFromUi(staged.state, source, {
    confirmedFieldNames: ['formproof.applicant_name'],
    createdAt: '2026-08-29T18:15:30.000Z',
  });
  assert.equal(unconfirmed.ok, false);
  if (unconfirmed.ok) throw new Error('required blocker was not confirmed');
  assert.equal(unconfirmed.errors[0].code, 'review_unconfirmed');
  assert.match(unconfirmed.errors[0].message, /opaque\.f1_02/u);

  const exported = await exportFillPackageFromUi(staged.state, source, {
    confirmedFieldNames: ['formproof.applicant_name', 'opaque.f1_02'],
    createdAt: '2026-08-29T18:15:30.000Z',
  });
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('required blocker fill package failed');
  const descriptor = inspection.fields.find(
    ({ name }) => name === 'opaque.f1_02',
  );
  assert.notEqual(descriptor, undefined);
  assert.deepEqual(
    exported.result.manifest.plan.humanSteps.find(
      ({ fieldName }) => fieldName === 'opaque.f1_02',
    ),
    {
      fieldName: 'opaque.f1_02',
      label: 'opaque.f1_02',
      type: 'text',
      required: true,
      multiSelect: false,
      sourceValue: '',
      choices: descriptor?.choices,
      widgets: descriptor?.widgets,
      page: descriptor?.page,
      rect: descriptor?.rect,
      reason: 'required_missing',
    },
  );
});

void test('rejects caller-supplied fill-package evidence that was not derived from the source bytes', async () => {
  const { source, state } = await stagedProtectedForm();
  const forgedState = {
    ...state,
    fields: {
      ...state.fields,
      'formproof.applicant_name': {
        ...state.fields['formproof.applicant_name'],
        label: 'Caller-forged label',
      },
    },
  } as FormState;
  const exported = await exportFillPackageFromUi(forgedState, source, {
    confirmedFieldNames: ['formproof.applicant_name', 'opaque.f1_02'],
    createdAt: '2026-08-29T18:15:45.000Z',
  });
  assert.equal(exported.ok, false);
  if (exported.ok) throw new Error('forged fill-package evidence was accepted');
  assert.deepEqual(
    exported.errors.map(({ code }) => code),
    ['plan_mismatch'],
  );
});

void test('keeps stale fill packages plan-bound and rejects mismatched or unknown protection', async () => {
  const { source, sourceSnapshot, state } = await stagedProtectedForm();
  const confirmedFieldNames = [
    'formproof.applicant_name',
    'opaque.f1_02',
  ] as const;
  const originalPackage = await exportFillPackageFromUi(state, source, {
    confirmedFieldNames,
    createdAt: '2026-08-29T18:16:00.000Z',
  });
  assert.equal(originalPackage.ok, true);
  if (!originalPackage.ok) throw new Error('original fill package failed');

  const restaged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'opaque.f1_02',
        value: 'Restaged opaque value',
        provenance: OPAQUE_FIELD_PROVENANCE,
      },
    ],
  });
  assert.equal(restaged.ok, true);
  if (!restaged.ok) throw new Error('protected field restaging failed');
  assert.notEqual(restaged.state.planHash, state.planHash);
  assert.equal(originalPackage.result.manifest.plan.planHash, state.planHash);
  assert.notEqual(
    originalPackage.result.manifest.plan.planHash,
    restaged.state.planHash,
  );

  const currentPackage = await exportFillPackageFromUi(restaged.state, source, {
    confirmedFieldNames,
    createdAt: '2026-08-29T18:16:00.000Z',
  });
  assert.equal(currentPackage.ok, true);
  if (!currentPackage.ok) throw new Error('restaged fill package failed');
  assert.equal(
    currentPackage.result.manifest.plan.planHash,
    restaged.state.planHash,
  );
  assert.notEqual(
    currentPackage.result.outputHash,
    originalPackage.result.outputHash,
  );

  const differentSource = await createProtectedFormPdf({ xfa: false });
  const mismatched = await exportFillPackageFromUi(state, differentSource, {
    confirmedFieldNames,
  });
  assert.equal(mismatched.ok, false);
  if (mismatched.ok) throw new Error('mismatched inspection package exported');
  assert.equal(mismatched.state, state);
  assert.deepEqual(
    mismatched.errors.map(({ code }) => code),
    ['source_mismatch'],
  );
  assert.deepEqual(source, sourceSnapshot, 'source PDF bytes were modified');

  const unknown = await stagedProtectedForm({ unknownProtection: true });
  assert.equal(unknown.inspection.protection.protectionType, 'unknown');
  assert.deepEqual(unknown.inspection.protection.exportStrategies, []);
  const unavailable = await exportFillPackageFromUi(
    unknown.state,
    unknown.source,
    { confirmedFieldNames },
  );
  assert.equal(unavailable.ok, false);
  if (unavailable.ok) throw new Error('unknown-protection package exported');
  assert.equal(unavailable.state, unknown.state);
  assert.deepEqual(
    unavailable.errors.map(({ code }) => code),
    ['artifact_unavailable'],
  );
  assert.deepEqual(
    unknown.source,
    unknown.sourceSnapshot,
    'unknown-protection source bytes were modified',
  );
});

void test('refuses a usage-rights derivative without explicit human confirmation', async () => {
  const { source, sourceSnapshot, inspection, state } =
    await stagedProtectedForm({ xfa: false });
  assert.deepEqual(inspection.protection.exportStrategies, [
    'confirmed_plain_derivative_pdf',
    'fill_package',
  ]);
  assert.equal(inspection.protection.requiresHumanConfirmation, true);
  const approval = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['formproof.applicant_name', 'opaque.f1_02'],
  });
  assert.equal(approval.ok, true);
  if (!approval.ok) throw new Error('derivative plan approval failed');

  const rejected = await exportApprovedDerivativePdfFromUi(
    approval.state,
    source,
    { humanConfirmedProtectionLoss: false },
  );
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error('unconfirmed derivative was exported');
  assert.equal(rejected.state, approval.state);
  assert.deepEqual(
    rejected.errors.map(({ code }) => code),
    ['review_unconfirmed'],
  );
  assert.equal(rejected.state.output, null);
  assert.equal(rejected.state.verification, null);
  assert.deepEqual(source, sourceSnapshot, 'source PDF bytes were modified');
});

void test('returns verification_failed when the PDF engine rejects an approved value', async () => {
  const source = await createTextFormPdf('legal_name');
  const inspection = await inspectPdf(source);
  const state = await createFormState(
    {
      fileName: 'unsupported-glyph.pdf',
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
        fieldName: 'legal_name',
        value: '漢字',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('CJK value failed to stage');
  const approved = approveDraftFromUi(staged.state, {
    expectedStateVersion: staged.state.stateVersion,
    expectedSourceHash: staged.state.source.sourceHash,
    expectedPlanHash: staged.state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['legal_name'],
  });
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error('CJK value failed approval');

  const exported = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(exported.ok, false);
  if (exported.ok) throw new Error('unsupported glyph PDF was exported');
  assert.equal(exported.state, approved.state);
  assert.deepEqual(
    exported.errors.map(({ code, fieldName }) => ({ code, fieldName })),
    [{ code: 'verification_failed', fieldName: 'legal_name' }],
  );
});

void test('rejects a forged Grace export and releases only the exact approved Ada PDF', async () => {
  const source = await createTextFormPdf('legal_name');
  const inspection = await inspectPdf(source);
  let state = await createFormState(
    {
      fileName: 'identity.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    [
      {
        name: 'legal_name',
        label: 'Legal name',
        type: 'text',
        required: true,
        readOnly: false,
        humanOnly: false,
        sourceValue: '',
      },
    ],
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'legal_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('Ada staging failed');
  const approval = approveDraftFromUi(staged.state, {
    expectedStateVersion: staged.state.stateVersion,
    expectedSourceHash: staged.state.source.sourceHash,
    expectedPlanHash: staged.state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['legal_name'],
  });
  assert.equal(approval.ok, true);
  if (!approval.ok) throw new Error('Ada approval failed');
  state = approval.state;

  const gracePdf = await applyApprovedValues(source, {
    legal_name: 'Grace Hopper',
  });
  const forgedRecord = {
    documentSessionId: state.documentSessionId,
    sourceHash: state.source.sourceHash,
    planHash: state.planHash,
    stateVersion: state.stateVersion,
    outputHash: gracePdf.outputHash,
    createdAt: '2026-08-29T18:20:00.000Z',
  };
  const structurallyForgedState: FormState = {
    ...state,
    output: forgedRecord,
    verification: {
      ...forgedRecord,
      verifiedAt: '2026-08-29T18:21:00.000Z',
      fieldValuesMatch: true,
      appearancesPresent: true,
      signatureImpact: 'none',
    },
  };
  assert.equal(getReleaseGate(structurallyForgedState).open, false);

  const forgedOutput = recordExportOutput(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    outputHash: gracePdf.outputHash,
  });
  assert.equal(forgedOutput.ok, false);
  if (forgedOutput.ok) throw new Error('forged Grace output was recorded');
  assert.equal(forgedOutput.state, state);
  assert.equal(forgedOutput.errors[0].code, 'trusted_export_required');

  const forgedVerification = recordOutputVerification(forgedOutput.state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    outputHash: gracePdf.outputHash,
    fieldValuesMatch: true,
    appearancesPresent: true,
    signatureImpact: 'none',
  });
  assert.equal(forgedVerification.ok, false);
  if (forgedVerification.ok)
    throw new Error('forged Grace verification was recorded');
  assert.equal(getReleaseGate(forgedVerification.state).open, false);

  const exported = await exportApprovedPdfFromUi(state, source);
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('trusted Ada export failed');
  assert.equal(getVerificationGate(exported.state).open, true);
  assert.equal(getReleaseGate(exported.state).open, true);
  assert.equal(exported.state.output?.outputHash, exported.result.outputHash);
  assert.equal(
    exported.result.verifiedFields.find(({ name }) => name === 'legal_name')
      ?.value,
    'Ada Lovelace',
  );
  const outputInspection = await inspectPdf(exported.result.bytes);
  assert.equal(
    outputInspection.fields.find(({ name }) => name === 'legal_name')?.current,
    'Ada Lovelace',
  );
  assert.equal(getReleaseGate({ ...exported.state }).open, false);

  const restaged = await stageFieldUpdates(exported.state, {
    expectedStateVersion: exported.state.stateVersion,
    expectedSourceHash: exported.state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'legal_name',
        value: 'Katherine Johnson',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(restaged.ok, true);
  if (!restaged.ok) throw new Error('restaging failed');
  assert.equal(restaged.state.approval, null);
  assert.equal(restaged.state.output, null);
  assert.equal(restaged.state.verification, null);
  assert.equal(getReleaseGate(restaged.state).open, false);
});

void test('canonicalizes cleared text and multiselect values through trusted export', async () => {
  const source = await createClearableFormPdf();
  const inspection = await inspectPdf(source);
  const inspectedText = inspection.fields.find(
    ({ name }) => name === 'clear_text',
  );
  const inspectedChoices = inspection.fields.find(
    ({ name }) => name === 'clear_choices',
  );
  assert.notEqual(inspectedText, undefined);
  assert.notEqual(inspectedChoices, undefined);
  if (inspectedText === undefined || inspectedChoices === undefined) {
    throw new Error('clear fixture fields were not inspected');
  }
  assert.equal(inspectedChoices.multiSelect, true);

  let state = await createFormState(
    {
      fileName: 'clear-form.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    [
      {
        name: inspectedText.name,
        label: 'Clear text',
        type: 'text',
        required: false,
        readOnly: false,
        humanOnly: false,
        sourceValue: inspectedText.current,
      },
      {
        name: inspectedChoices.name,
        label: 'Clear choices',
        type: 'dropdown',
        required: false,
        readOnly: false,
        humanOnly: false,
        options: [...inspectedChoices.options],
        multiSelect: inspectedChoices.multiSelect,
        sourceValue: Array.isArray(inspectedChoices.current)
          ? [...inspectedChoices.current]
          : inspectedChoices.current,
      },
    ],
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'clear_text',
        value: null,
        provenance: USER_PROVENANCE,
      },
      {
        fieldName: 'clear_choices',
        value: null,
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('clear values failed to stage');
  state = staged.state;
  assert.equal(state.draft.clear_text.value, '');
  assert.deepEqual(state.draft.clear_choices.value, []);

  const approved = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['clear_choices', 'clear_text'],
  });
  assert.equal(approved.ok, true);
  if (!approved.ok) throw new Error('clear plan approval failed');

  const exported = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('trusted clear export failed');
  assert.equal(getReleaseGate(exported.state).open, true);
  assert.equal(
    exported.result.verifiedFields.find(({ name }) => name === 'clear_text')
      ?.value,
    '',
  );
  assert.deepEqual(
    exported.result.verifiedFields.find(({ name }) => name === 'clear_choices')
      ?.value,
    [],
  );

  const outputInspection = await inspectPdf(exported.result.bytes);
  assert.equal(
    outputInspection.fields.find(({ name }) => name === 'clear_text')?.current,
    '',
  );
  assert.deepEqual(
    outputInspection.fields.find(({ name }) => name === 'clear_choices')
      ?.current,
    [],
  );
});

void test('preserves approval on a true no-op and clears workflow state on discard', async () => {
  let state = await stageRequiredValues();
  const incompleteApproval = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['attestation'],
  });
  assert.equal(incompleteApproval.ok, false);
  if (incompleteApproval.ok) {
    throw new Error('an unconfirmed ordinary draft field was approved');
  }
  assert.equal(
    incompleteApproval.errors.some(
      ({ code, message }) =>
        code === 'review_unconfirmed' && message.includes('full_name'),
    ),
    true,
  );

  const approval = approveDraftFromUi(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    expectedPlanHash: state.planHash,
    approvedBy: 'local user',
    confirmedFieldNames: ['attestation', 'full_name'],
  });
  assert.equal(approval.ok, true);
  if (!approval.ok) throw new Error('approval failed');
  state = approval.state;

  const noOp = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'full_name',
        value: 'Ada Lovelace',
        provenance: USER_PROVENANCE,
      },
    ],
  });
  assert.equal(noOp.ok, true);
  if (!noOp.ok) throw new Error('no-op failed');
  assert.equal(noOp.state, state);
  assert.deepEqual(noOp.changedFields, []);
  assert.notEqual(noOp.state.approval, null);

  const discarded = await discardDraft(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
  });
  assert.equal(discarded.ok, true);
  if (!discarded.ok) throw new Error('discard failed');
  assert.deepEqual(Object.keys(discarded.state.draft), []);
  assert.equal(Object.getPrototypeOf(discarded.state.draft), null);
  assert.equal(discarded.state.stateVersion, state.stateVersion + 1);
  assert.equal(discarded.state.approval, null);
});

void test('supports prototype-like PDF field names without inherited lookups', async () => {
  const names = ['__proto__', 'constructor', 'toString'];
  const state = await createFormState(
    SOURCE,
    names.map((name) => ({
      name,
      label: name,
      type: 'text' as const,
      required: false,
      readOnly: false,
      humanOnly: false,
      sourceValue: '',
    })),
  );

  assert.equal(Object.getPrototypeOf(state.fields), null);
  for (const name of names) {
    assert.equal(Object.hasOwn(state.fields, name), true);
    assert.equal(state.fields[name].name, name);
    assert.equal(getEffectiveFieldValue(state, name), '');
  }

  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: names.map((fieldName) => ({
      fieldName,
      value: `value:${fieldName}`,
      provenance: USER_PROVENANCE,
    })),
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('prototype-like fields failed to stage');
  assert.equal(Object.getPrototypeOf(staged.state.draft), null);
  for (const name of names) {
    assert.equal(Object.hasOwn(staged.state.draft, name), true);
    assert.equal(getEffectiveFieldValue(staged.state, name), `value:${name}`);
  }
  assert.deepEqual(
    getFormContext(staged.state).fields.map(
      ({ definition }) => definition.name,
    ),
    [...names].sort(),
  );
});

void test('exposes a frozen, sorted context without exposing mutable evidence', async () => {
  const state = await stageRequiredValues();
  const context = getFormContext(state);
  assert.deepEqual(
    context.fields.map(({ definition }) => definition.name),
    ['attestation', 'case_id', 'full_name', 'programs', 'region', 'signature'],
  );
  assert.equal(
    context.fields.find(({ definition }) => definition.name === 'full_name')
      ?.effectiveValue,
    'Ada Lovelace',
  );
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.fields), true);
  assert.equal(
    Object.isFrozen(context.fields[2].staged?.provenance.evidence),
    true,
  );
});

void test('rejects invalid form schemas before any workflow state exists', async () => {
  const invalid = fields();
  invalid.push({ ...invalid[0] });
  (
    invalid.find(({ name }) => name === 'signature') as {
      humanOnly: boolean;
    }
  ).humanOnly = false;
  await assert.rejects(
    createFormState(SOURCE, invalid),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes('duplicate field name: full_name') &&
      error.message.includes('signature fields must be humanOnly'),
  );
});
