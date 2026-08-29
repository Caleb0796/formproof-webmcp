import assert from 'node:assert/strict';
import test from 'node:test';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import {
  approveDraftFromUi,
  createFormFieldDefinitionFromPdf,
  createFormState,
  discardDraft,
  exportApprovedPdfFromUi,
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
      signatureIntegrityPreserved: true,
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
    signatureIntegrityPreserved: true,
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
