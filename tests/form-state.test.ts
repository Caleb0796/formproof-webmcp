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
  createFormFieldDefinitionFromPdf,
  createFormState,
  discardDraft,
  exportApprovedDerivativePdfFromUi,
  exportApprovedPdfFromUi,
  exportFillPackageFromUi,
  getEffectiveFieldValue,
  getExportGate,
  getFormContext,
  getReleaseGate,
  getVerificationGate,
  recordExportOutput,
  recordOutputVerification,
  stageFieldUpdates,
  validateDraft,
  type FieldProvenance,
  type FormFieldDefinition,
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
      { value: 'Housing', label: 'Housing support' },
      { value: 'Utilities', label: 'Utility support' },
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

async function createTextFormPdf(fieldName: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([320, 180]);
  const field = document.getForm().createTextField(fieldName);
  field.addToPage(page, { x: 40, y: 80, width: 240, height: 28 });
  return Uint8Array.from(
    await document.save({ addDefaultPage: false, useObjectStreams: false }),
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
  assert.equal(manifest.schemaVersion, 3);
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
    manifest.limitations.some((item) => item.includes('no semantic tooltip')),
    true,
  );
  assert.equal(
    manifest.limitations.some((item) => item.includes('XFA captions')),
    true,
  );

  const serializedManifest = JSON.stringify(parsed);
  assert.doesNotMatch(
    serializedManifest,
    /"(?:appearanceVerified|appearancesPresent|fieldValuesMatch|signatureIntegrityPreserved|verifiedFields)"/u,
  );
  assert.equal(state.output, null);
  assert.equal(state.verification, null);
  assert.deepEqual(source, sourceSnapshot, 'source PDF bytes were modified');
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
