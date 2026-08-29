import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  approveDraftFromUi,
  createFormState,
  exportApprovedPdfFromUi,
  getReleaseGate,
  stageFieldUpdates,
  validateDraft,
  type FormFieldDefinition,
  type FormFieldType,
  type FormFieldValue,
  type FormState,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/form-state.ts';
import type {
  ApplyResult,
  PdfFieldDescriptor,
  PdfFieldValue,
  PdfInspection,
} from '../lib/pdf-engine';

const { inspectPdf } = (await import(
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

interface StagedDemo {
  source: Uint8Array;
  inspection: PdfInspection;
  initialState: FormState;
  stagedState: FormState;
}

interface CompletedDemo extends StagedDemo {
  values: Record<string, PdfFieldValue>;
  applyResult: ApplyResult;
  releasedState: FormState;
}

function stateFieldType(field: PdfFieldDescriptor): FormFieldType {
  if (field.type === 'option_list') return 'option-list';
  if (field.type === 'unsupported') {
    throw new TypeError(`Unsupported fixture field: ${field.name}.`);
  }
  return field.type;
}

function stateFieldLabel(field: PdfFieldDescriptor): string {
  const tooltip = field.tooltip
    ?.replace(/\[\s*HUMAN[_ -]?ONLY\s*\]/i, '')
    .trim();
  return tooltip || field.name;
}

function cloneStateValue(value: PdfFieldValue): FormFieldValue {
  return Array.isArray(value) ? [...value] : value;
}

function mapField(field: PdfFieldDescriptor): FormFieldDefinition {
  return {
    name: field.name,
    label: stateFieldLabel(field),
    type: stateFieldType(field),
    required: field.required,
    readOnly: field.readOnly,
    humanOnly: field.humanOnly,
    ...(field.options.length === 0 ? {} : { options: [...field.options] }),
    ...(field.type === 'dropdown' || field.type === 'option_list'
      ? { multiSelect: field.multiSelect }
      : {}),
    ...(field.maxLength === null ? {} : { maxLength: field.maxLength }),
    sourceValue: cloneStateValue(field.current),
  };
}

function draftValues(state: FormState): Record<string, PdfFieldValue> {
  const values: Record<string, PdfFieldValue> = {};
  for (const [fieldName, staged] of Object.entries(state.draft)) {
    values[fieldName] = Array.isArray(staged.value)
      ? [...staged.value]
      : (staged.value as Exclude<FormFieldValue, readonly string[]>);
  }
  return values;
}

async function loadStagedDemo(): Promise<StagedDemo> {
  const source = new Uint8Array(
    await readFile(new URL('../public/demo-form.pdf', import.meta.url)),
  );
  const inspection = await inspectPdf(source);
  const initialState = await createFormState(
    {
      fileName: 'demo-form.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
      loadedAt: '2026-08-29T19:00:00.000Z',
    },
    inspection.fields.map(mapField),
  );

  const staged = await stageFieldUpdates(initialState, {
    expectedStateVersion: initialState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.legalName,
        value: 'Ada Lovelace',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.email,
        value: 'ada@example.test',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.contact,
        value: 'Phone',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.consent,
        value: true,
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.housing,
        value: 'rent',
        provenance: {
          kind: 'source_document',
          confidence: 0.96,
          evidence: ['page 1 housing section'],
        },
      },
      {
        fieldName: FIELD.support,
        value: ['Utilities', 'Transportation'],
        provenance: {
          kind: 'agent_inference',
          confidence: 0.74,
          rationale:
            'The request mentions utility arrears and travel barriers.',
        },
      },
      {
        fieldName: FIELD.notes,
        value: 'Needs a follow-up call.',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('Valid cross-layer staging failed.');

  return {
    source,
    inspection,
    initialState,
    stagedState: staged.state,
  };
}

async function completeDemo(): Promise<CompletedDemo> {
  const stagedDemo = await loadStagedDemo();
  const { inspection, source, stagedState } = stagedDemo;
  const validation = validateDraft(stagedState);
  const approved = approveDraftFromUi(stagedState, {
    expectedStateVersion: stagedState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    expectedPlanHash: stagedState.planHash,
    approvedBy: 'local reviewer',
    approvedAt: '2026-08-29T19:05:00.000Z',
    confirmedFieldNames: [
      ...new Set([
        ...Object.keys(stagedState.draft),
        ...validation.reviewFieldNames,
      ]),
    ],
  });
  assert.equal(
    approved.ok,
    true,
    approved.ok ? undefined : JSON.stringify(approved.errors),
  );
  if (!approved.ok) throw new Error('Exact-plan UI approval failed.');

  const values = draftValues(approved.state);
  const success = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(success.ok, true);
  if (!success.ok) throw new Error('Trusted UI export failed.');
  assert.equal(success.result.sourceHash, inspection.sourceHash);
  assert.equal(getReleaseGate(success.state).open, true);

  return {
    ...stagedDemo,
    values,
    applyResult: success.result,
    releasedState: success.state,
  };
}

void test('carries the real demo PDF through exact human approval and the release gate', async () => {
  const stagedDemo = await loadStagedDemo();
  const { initialState, inspection, stagedState } = stagedDemo;

  assert.equal(initialState.source.sourceHash, inspection.sourceHash);
  assert.equal(Object.keys(initialState.fields).length, inspection.fieldCount);
  assert.deepEqual(
    initialState.validation.issues
      .filter(({ severity }) => severity === 'error')
      .map(({ fieldName }) => fieldName)
      .sort(),
    [FIELD.legalName, FIELD.email, FIELD.consent, FIELD.housing].sort(),
  );
  assert.deepEqual(initialState.validation.reviewFieldNames, [FIELD.signature]);
  assert.equal(initialState.fields[FIELD.witness].humanOnly, true);
  assert.equal(initialState.fields[FIELD.signature].type, 'signature');

  const validation = validateDraft(stagedState);
  assert.equal(validation.blockerCount, 0);
  assert.equal(validation.canApprove, true);
  assert.deepEqual(validation.reviewFieldNames, [
    FIELD.support,
    FIELD.signature,
  ]);
  assert.equal(
    validation.issues.some(
      ({ code, fieldName }) =>
        code === 'human_completion_required' && fieldName === FIELD.signature,
    ),
    true,
  );

  const incompleteApproval = approveDraftFromUi(stagedState, {
    expectedStateVersion: stagedState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    expectedPlanHash: stagedState.planHash,
    approvedBy: 'local reviewer',
    confirmedFieldNames: [FIELD.support],
  });
  assert.equal(incompleteApproval.ok, false);
  if (incompleteApproval.ok) {
    throw new Error('Incomplete review confirmation was accepted.');
  }
  assert.equal(
    incompleteApproval.errors.some(({ code }) => code === 'review_unconfirmed'),
    true,
  );

  const completed = await completeDemo();
  assert.equal(completed.applyResult.sourceHash, inspection.sourceHash);
  assert.notEqual(
    completed.applyResult.outputHash,
    completed.applyResult.sourceHash,
  );
  assert.equal(
    completed.applyResult.verifiedFields.length,
    Object.keys(completed.values).length,
  );
  assert.ok(
    completed.applyResult.verifiedFields.every(
      ({ appearanceVerified }) => appearanceVerified,
    ),
  );
  assert.equal(
    completed.releasedState.approval?.planHash,
    stagedState.planHash,
  );
  assert.equal(
    completed.releasedState.output?.outputHash,
    completed.applyResult.outputHash,
  );
  assert.equal(
    completed.releasedState.verification?.outputHash,
    completed.applyResult.outputHash,
  );
  assert.equal(getReleaseGate(completed.releasedState).open, true);
});

void test('round-trips canonical clears using inspected choice multiplicity', async () => {
  const { inspection, source, stagedState } = await loadStagedDemo();
  assert.equal(stagedState.fields[FIELD.contact].multiSelect, false);
  assert.equal(stagedState.fields[FIELD.support].multiSelect, true);

  const cleared = await stageFieldUpdates(stagedState, {
    expectedStateVersion: stagedState.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.support,
        value: null,
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.notes,
        value: null,
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) throw new Error('Canonical clear staging failed.');
  assert.equal(cleared.state.draft[FIELD.contact].value, 'Phone');
  assert.deepEqual(cleared.state.draft[FIELD.support].value, []);
  assert.equal(cleared.state.draft[FIELD.notes].value, '');

  const validation = validateDraft(cleared.state);
  const approved = approveDraftFromUi(cleared.state, {
    expectedStateVersion: cleared.state.stateVersion,
    expectedSourceHash: inspection.sourceHash,
    expectedPlanHash: cleared.state.planHash,
    approvedBy: 'local reviewer',
    confirmedFieldNames: [
      ...new Set([
        ...Object.keys(cleared.state.draft),
        ...validation.reviewFieldNames,
      ]),
    ],
  });
  assert.equal(
    approved.ok,
    true,
    approved.ok ? undefined : JSON.stringify(approved.errors),
  );
  if (!approved.ok) throw new Error('Canonical clear approval failed.');

  const exported = await exportApprovedPdfFromUi(approved.state, source);
  assert.equal(exported.ok, true);
  if (!exported.ok) throw new Error('Canonical clear export failed.');
  assert.equal(getReleaseGate(exported.state).open, true);

  const outputInspection = await inspectPdf(exported.result.bytes);
  const outputByName = new Map(
    outputInspection.fields.map((field) => [field.name, field] as const),
  );
  assert.equal(outputByName.get(FIELD.contact)?.current, 'Phone');
  assert.deepEqual(outputByName.get(FIELD.support)?.current, []);
  assert.equal(outputByName.get(FIELD.notes)?.current, '');
});

void test('a real draft mutation revokes approval, output, and verification', async () => {
  const completed = await completeDemo();
  const released = completed.releasedState;
  assert.equal(getReleaseGate(released).open, true);

  const mutation = await stageFieldUpdates(released, {
    expectedStateVersion: released.stateVersion,
    expectedSourceHash: released.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.legalName,
        value: 'Grace Hopper',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(mutation.ok, true);
  if (!mutation.ok) throw new Error('Real draft mutation failed.');

  assert.equal(mutation.state.stateVersion, released.stateVersion + 1);
  assert.notEqual(mutation.state.planHash, released.planHash);
  assert.equal(mutation.state.approval, null);
  assert.equal(mutation.state.output, null);
  assert.equal(mutation.state.verification, null);
  assert.equal(getReleaseGate(mutation.state).open, false);
});

void test('agent staging rejects human-only and signature fields atomically', async () => {
  const source = new Uint8Array(
    await readFile(new URL('../public/demo-form.pdf', import.meta.url)),
  );
  const inspection = await inspectPdf(source);
  const state = await createFormState(
    {
      fileName: 'demo-form.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(mapField),
  );

  const rejected = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: FIELD.legalName,
        value: 'Ada Lovelace',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.witness,
        value: 'AL',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
      {
        fieldName: FIELD.signature,
        value: 'Ada Lovelace',
        provenance: { kind: 'user_instruction', confidence: 0.99 },
      },
    ],
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error('Unsafe mixed batch was accepted.');

  assert.equal(rejected.state, state);
  assert.equal(rejected.state.stateVersion, 0);
  assert.equal(rejected.state.planHash, state.planHash);
  assert.deepEqual(Object.keys(rejected.state.draft), []);
  assert.equal(JSON.stringify(rejected.state.draft), '{}');
  assert.equal(
    rejected.errors.some(
      ({ code, fieldName }) =>
        code === 'human_only' && fieldName === FIELD.witness,
    ),
    true,
  );
  assert.equal(
    rejected.errors.some(
      ({ code, fieldName }) =>
        code === 'signature_locked' && fieldName === FIELD.signature,
    ),
    true,
  );
});
