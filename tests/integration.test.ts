import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  approveDraftFromUi,
  createFormFieldDefinitionFromPdf,
  createFormState,
  exportApprovedPdfFromUi,
  getReleaseGate,
  stageFieldUpdates,
  validateDraft,
  type FormFieldValue,
  type FormState,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from '../lib/form-state.ts';
import type {
  ApplyResult,
  PdfFieldValue,
  PdfInspection,
} from '../lib/pdf-engine';
import type {
  FormProofToolResponse,
  FormProofWebMcpAdapter,
} from '../lib/webmcp';

const { inspectPdf } = (await import(
  new URL('../lib/pdf-engine.ts', import.meta.url).href
)) as typeof import('../lib/pdf-engine');
const {
  FORMPROOF_WEBMCP_TOOL_NAMES,
  FORMPROOF_MAX_RESPONSE_BYTES,
  FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
  createFieldChoiceCursor,
  createFieldEvidenceToolData,
  createFormContextToolData,
  createFormProofToolDefinitions,
  parseFieldChoiceCursor,
  parseFormContextCursor,
} = (await import(
  new URL('../lib/webmcp.ts', import.meta.url).href
)) as typeof import('../lib/webmcp');

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

interface AuthoredEvalCall {
  functionName: string;
  arguments: {
    cursor?: string;
    limit?: number;
    queries?: string[];
    agentWritableOnly?: boolean;
    fieldNames?: string[];
  };
  mockOutput: {
    data: unknown;
  };
}

interface AuthoredEvalCase {
  name: string;
  expectedCall: AuthoredEvalCall[];
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

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function fieldCombinations(
  fieldNames: readonly string[],
  maximumSize: number,
): string[][] {
  const combinations: string[][] = [];
  const visit = (start: number, selected: string[]) => {
    if (selected.length > 0) combinations.push([...selected]);
    if (selected.length === maximumSize) return;
    for (let index = start; index < fieldNames.length; index += 1) {
      selected.push(fieldNames[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return combinations;
}

async function loadStagedDemo(): Promise<StagedDemo> {
  const source = new Uint8Array(
    await readFile(new URL('../public/demo-form.pdf', import.meta.url)),
  );
  const inspection = await inspectPdf(source);
  const initialState = await createFormState(
    {
      fileName: 'residential-support-intake.pdf',
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
      loadedAt: '2026-08-29T19:00:00.000Z',
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
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

void test('keeps public safety claims within the WebMCP tool boundary', async () => {
  const [workbench, demoGenerator, layout, webMcpSource] = await Promise.all([
    readFile(
      new URL('../components/formproof-workbench.tsx', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../scripts/create-demo-form.py', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/webmcp.ts', import.meta.url), 'utf8'),
  ]);
  const publicCopy = `${workbench}\n${demoGenerator}\n${layout}\n${webMcpSource}`;

  for (const overclaim of [
    'Stays in this browser',
    'Field values do not leave the page.',
    'human approval boundary the agent cannot cross',
    'APPROVAL IS NEVER AN AGENT TOOL',
    'Only the human UI can approve or export',
    'human_review_only',
    'human-only approval',
    'Human-only gate',
    'Release gate open',
    'Verified export receipt',
  ]) {
    assert.equal(
      publicCopy.includes(overclaim),
      false,
      `public copy overclaims: ${overclaim}`,
    );
  }

  assert.match(workbench, /PDF bytes stay in this browser/);
  assert.match(workbench, /Approval and export stay outside its tool surface/);
  assert.match(
    webMcpSource,
    /This WebMCP tool cannot approve or export; those controls exist only in the UI/,
  );
  assert.match(webMcpSource, /approvalBoundary: 'ui_approval_only'/);
  assert.match(
    demoGenerator,
    /requested field data may be shared with the active agent/,
  );
  assert.match(demoGenerator, /APPROVAL \/ EXPORT ARE NOT WEBMCP TOOLS/);
  assert.match(workbench, /documentState\?\.kind !== 'demo'/);
  assert.match(workbench, /documentState\?\.kind === 'demo'/);
  assert.match(workbench, /Load built-in demo/);
  assert.match(workbench, /Staged fields/);
  assert.match(workbench, /Completeness/);
  assert.match(workbench, /Not assessed beyond PDF required flags/);
  assert.match(workbench, /human_completion_required/);
  assert.doesNotMatch(workbench, /appearances (?:are )?verified/iu);
  assert.match(workbench, /normal appearance streams are present/iu);
  assert.match(workbench, /visual rendering is not independently checked/iu);
});

void test('gives the UI reviewer a way to reject staged proposals', async () => {
  const workbench = await readFile(
    new URL('../components/formproof-workbench.tsx', import.meta.url),
    'utf8',
  );

  assert.match(workbench, /discardDraftFields/);
  assert.match(workbench, /Reject proposal/u);
  assert.match(workbench, /Discard all proposals/u);
  assert.match(workbench, /Confirm discard.*proposals/u);
  assert.match(workbench, /if \(discardAllArmed\)/u);
  assert.match(
    workbench,
    /The plan changed, so review closed and every confirmation was cleared/u,
  );
  assert.deepEqual(FORMPROOF_WEBMCP_TOOL_NAMES, [
    'get_pdf_protection',
    'get_form_context',
    'get_field_evidence',
    'stage_form_values',
    'validate_fill_plan',
    'start_fill_review',
  ]);
});

void test('wires scoped context and artifact-specific review boundaries through the workbench adapter', async () => {
  const workbench = await readFile(
    new URL('../components/formproof-workbench.tsx', import.meta.url),
    'utf8',
  );

  const contextStart = workbench.indexOf('getFormContext(input) {');
  const contextEnd = workbench.indexOf('getFieldEvidence(input) {');
  assert.ok(contextStart >= 0 && contextEnd > contextStart);
  const contextAdapter = workbench.slice(contextStart, contextEnd);
  assert.match(
    contextAdapter,
    /parseFormContextCursor\(\s*input\.cursor,\s*current\.source\.sourceHash,\s*input,\s*\)/u,
  );
  assert.match(
    contextAdapter,
    /createFormContextToolData\(\s*current,\s*inspection,\s*offset,\s*input\.limit,\s*input,\s*\)/u,
  );
  assert.match(contextAdapter, /offset > data\.pagination\.total/u);

  const openReviewStart = workbench.indexOf(
    'const openReview = useCallback(() => {',
  );
  const openReviewEnd = workbench.indexOf(
    'const resetOutput = useCallback(() => {',
  );
  assert.ok(openReviewStart >= 0 && openReviewEnd > openReviewStart);
  const openReview = workbench.slice(openReviewStart, openReviewEnd);
  assert.match(
    openReview,
    /const preferredStrategy = initialExportStrategy\(inspection\)/u,
  );
  assert.match(
    openReview,
    /preferredStrategy !== 'fill_package'[\s\S]*?!validateDraft\(current\)\.canApprove[\s\S]*?exportStrategies\.includes\('fill_package'\)[\s\S]*?\? 'fill_package'/u,
  );
  assert.doesNotMatch(openReview, /PDF_ACTION_UNSUPPORTED|will not export/u);

  const validationStart = workbench.indexOf('validateFillPlan(input) {');
  const reviewStart = workbench.indexOf('startFillReview(input) {');
  const adapterEnd = workbench.indexOf(
    '\n    };\n\n    void register',
    reviewStart,
  );
  assert.ok(
    validationStart >= 0 &&
      reviewStart > validationStart &&
      adapterEnd > reviewStart,
  );
  const validationAdapter = workbench.slice(validationStart, reviewStart);
  assert.match(validationAdapter, /readyForReview:/u);
  assert.match(
    validationAdapter,
    /reviewArtifacts = inspection\?\.protection\.exportStrategies/u,
  );
  assert.match(validationAdapter, /reviewArtifacts\.length > 0/u);
  assert.match(validationAdapter, /exportStrategySelection: 'human_ui_only'/u);

  const reviewAdapter = workbench.slice(reviewStart, adapterEnd);
  assert.match(
    reviewAdapter,
    /if \(reviewArtifacts\.length === 0\) \{[\s\S]*?'review_not_ready'[\s\S]*?no available artifact strategy[\s\S]*?\}/u,
  );
  assert.match(reviewAdapter, /exportStrategySelection: 'human_ui_only'/u);

  assert.match(workbench, /agentMaySelectExportStrategy: false/u);
  assert.match(workbench, /exportFillPackageFromUi\(current, source/u);
  assert.match(workbench, /getArtifactReviewFieldNames\(formState\)/u);
  assert.match(workbench, /Required field is blank/u);
  assert.match(workbench, /fill package remains incomplete/u);
  assert.match(workbench, /not established; unknown protection remains/u);
  assert.match(workbench, /exportApprovedDerivativePdfFromUi/u);
  assert.match(
    workbench,
    /selectedCreatesPdf &&[\s\S]*?!validation\?\.canApprove \|\| hasBlockedHighRiskActions/u,
  );
});

void test('keeps real WebMCP discovery and evidence atomic under the target budget', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const adapter: FormProofWebMcpAdapter = {
    getFormContext(input) {
      const parsed =
        input.cursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFormContextCursor(
              input.cursor,
              initialState.source.sourceHash,
              input,
            );
      if (!parsed.ok) {
        return {
          ok: false,
          stateVersion: initialState.stateVersion,
          sourceHash: initialState.source.sourceHash,
          error: {
            code: parsed.code,
            message: 'The field cursor is invalid for this context scope.',
          },
        };
      }
      return {
        ok: true,
        stateVersion: initialState.stateVersion,
        sourceHash: initialState.source.sourceHash,
        data: createFormContextToolData(
          initialState,
          inspection,
          parsed.offset,
          input.limit,
          input,
        ),
      };
    },
    getFieldEvidence(input) {
      return {
        ok: true,
        stateVersion: initialState.stateVersion,
        sourceHash: initialState.source.sourceHash,
        data: createFieldEvidenceToolData(
          initialState,
          inspection,
          input.fieldNames,
        ),
      };
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const tools = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  );
  const context = tools.find(({ name }) => name === 'get_form_context');
  const evidence = tools.find(({ name }) => name === 'get_field_evidence');
  assert.ok(context);
  assert.ok(evidence);

  const discoveredNames: string[] = [];
  let firstContextPage = true;
  let cursor: string | null = null;
  do {
    const response: FormProofToolResponse = await context.execute(
      cursor === null ? {} : { cursor },
    );
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error('Real context projection failed.');
    assert.equal(response.outputTruncated, false);
    assert.ok(
      serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `context response used ${serializedBytes(response)} bytes`,
    );
    const data = response.data as {
      fields: Array<Record<string, unknown>>;
      pagination: {
        returned: number;
        total: number;
        nextCursor: string | null;
      };
      validation?: {
        structurallyValid: boolean;
        completionStatus: 'incomplete' | 'unknown';
        ruleCoverage: 'pdf_required_flags_only';
        formCompletenessAssessed: false;
      };
    };
    assert.equal(data.pagination.returned, data.fields.length);
    if (firstContextPage) {
      assert.deepEqual(data.validation, {
        blockerCount: initialState.validation.blockerCount,
        reviewCount: initialState.validation.reviewCount,
        structurallyValid: false,
        completionStatus: 'incomplete',
        ruleCoverage: 'pdf_required_flags_only',
        formCompletenessAssessed: false,
        canApprove: initialState.validation.canApprove,
        canOpenReview: false,
        blockingFieldNames: initialState.validation.issues
          .filter(({ severity }) => severity === 'error')
          .map(({ fieldName }) => fieldName),
        reviewFieldNames: initialState.validation.reviewFieldNames,
      });
      assert.equal('valid' in data.validation!, false);
      firstContextPage = false;
    }
    for (const field of data.fields) {
      assert.equal(typeof field.name, 'string');
      assert.equal(typeof field.label, 'string');
      assert.equal(typeof field.type, 'string');
      assert.equal(typeof field.required, 'boolean');
      assert.equal(typeof field.readOnly, 'boolean');
      assert.equal(typeof field.humanOnly, 'boolean');
      discoveredNames.push(field.name as string);
    }
    cursor = data.pagination.nextCursor;
  } while (cursor !== null);

  assert.deepEqual(
    discoveredNames,
    inspection.fields.map(({ name }) => name),
  );
  assert.equal(new Set(discoveredNames).size, discoveredNames.length);

  const queryScope = {
    queries: ['contact'],
    agentWritableOnly: true,
    limit: 1,
  } as const;
  const firstQueryPage = await context.execute(queryScope);
  assert.equal(firstQueryPage.ok, true);
  if (!firstQueryPage.ok) throw new Error('Scoped context search failed.');
  const firstQueryData = firstQueryPage.data as {
    fields: Array<{ name: string; matchedQueries: string[] }>;
    pagination: { returned: number; total: number; nextCursor: string | null };
    search: {
      matchMethod: 'lexical';
      agentWritableOnly: true;
      queries: Array<{ query: string; matchCount: number }>;
    };
  };
  assert.deepEqual(firstQueryData.fields, [
    {
      name: FIELD.contact,
      label: 'Preferred contact method',
      type: 'dropdown',
      matchedQueries: ['contact'],
    },
  ]);
  assert.deepEqual(firstQueryData.search, {
    matchMethod: 'lexical',
    agentWritableOnly: true,
    queries: [{ query: 'contact', matchCount: 2 }],
  });
  assert.equal(firstQueryData.pagination.returned, 1);
  assert.equal(firstQueryData.pagination.total, 2);
  assert.ok(firstQueryData.pagination.nextCursor);

  const secondQueryPage = await context.execute({
    ...queryScope,
    cursor: firstQueryData.pagination.nextCursor,
  });
  assert.equal(secondQueryPage.ok, true);
  if (!secondQueryPage.ok) {
    throw new Error('Scoped context pagination failed.');
  }
  const secondQueryData = secondQueryPage.data as {
    fields: Array<{ name: string }>;
    pagination: { returned: number; total: number; nextCursor: string | null };
  };
  assert.deepEqual(
    secondQueryData.fields.map(({ name }) => name),
    [FIELD.consent],
  );
  assert.deepEqual(secondQueryData.pagination, {
    returned: 1,
    total: 2,
    nextCursor: null,
  });

  const mismatchedQueryScope = await context.execute({
    ...queryScope,
    queries: ['review'],
    cursor: firstQueryData.pagination.nextCursor,
  });
  assert.equal(mismatchedQueryScope.ok, false);
  if (mismatchedQueryScope.ok) {
    throw new Error('A cursor was accepted under a different query scope.');
  }
  assert.equal(mismatchedQueryScope.error.code, 'INVALID_INPUT');
  assert.equal(mismatchedQueryScope.nextAction, 'fix_tool_input');

  const evidenceResponse = await evidence.execute({
    expectedStateVersion: initialState.stateVersion,
    expectedSourceHash: initialState.source.sourceHash,
    fieldNames: [FIELD.legalName, FIELD.email, FIELD.consent],
  });
  assert.equal(evidenceResponse.ok, true);
  if (!evidenceResponse.ok) throw new Error('Real evidence projection failed.');
  assert.equal(evidenceResponse.outputTruncated, false);
  assert.ok(
    serializedBytes(evidenceResponse) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `evidence response used ${serializedBytes(evidenceResponse)} bytes`,
  );
  const evidenceData = evidenceResponse.data as {
    untrustedPdfContent: boolean;
    fields: Array<{
      name: string;
      rect: unknown;
      constraints: {
        choices: Array<{ value: string; label: string }>;
      };
    }>;
  };
  assert.equal(evidenceData.untrustedPdfContent, true);
  assert.equal(
    evidenceData.fields.every(({ rect }) => rect !== null),
    true,
  );
  const housingResponse = await evidence.execute({
    expectedStateVersion: initialState.stateVersion,
    expectedSourceHash: initialState.source.sourceHash,
    fieldNames: [FIELD.housing],
  });
  assert.equal(housingResponse.ok, true);
  if (!housingResponse.ok) throw new Error('Housing evidence failed.');
  assert.equal(housingResponse.outputTruncated, false);
  assert.ok(
    serializedBytes(housingResponse) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
  );
  const housingField = (
    housingResponse.data as {
      fields: Array<{
        constraints: { choices: Array<{ value: string; label: string }> };
      }>;
    }
  ).fields[0];
  assert.deepEqual(housingField.constraints.choices, [
    { value: 'rent', label: 'rent' },
    { value: 'own', label: 'own' },
    { value: 'other', label: 'other' },
  ]);

  for (const fieldNames of fieldCombinations(discoveredNames, 3)) {
    const response = await evidence.execute({
      expectedStateVersion: initialState.stateVersion,
      expectedSourceHash: initialState.source.sourceHash,
      fieldNames,
    });
    assert.equal(
      response.ok,
      true,
      `evidence failed for ${fieldNames.join(',')}`,
    );
    if (!response.ok) throw new Error('Evidence combination failed.');
    assert.equal(response.outputTruncated, false);
    assert.ok(
      serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `${fieldNames.join(',')} used ${serializedBytes(response)} bytes`,
    );
  }

  const longText = '表单😀\\"'.repeat(300);
  const longState: FormState = {
    ...initialState,
    source: { ...initialState.source, fileName: longText },
    fields: {
      ...initialState.fields,
      [FIELD.legalName]: {
        ...initialState.fields[FIELD.legalName],
        label: longText,
        sourceValue: longText,
      },
    },
  };
  const longInspection: PdfInspection = {
    ...inspection,
    fields: inspection.fields.map((field) =>
      field.name === FIELD.legalName ? { ...field, current: longText } : field,
    ),
  };
  const longData = createFormContextToolData(longState, longInspection, 0, 6);
  const longResponse = {
    ok: true,
    stateVersion: longState.stateVersion,
    sourceHash: longState.source.sourceHash,
    nextAction: 'get_field_evidence',
    data: longData,
    outputTruncated: false,
  };
  assert.ok(
    serializedBytes(longResponse) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `adversarial context used ${serializedBytes(longResponse)} bytes`,
  );
  const projectedLongField = longData.fields.find(
    (field) => 'name' in field && field.name === FIELD.legalName,
  );
  assert.equal(projectedLongField?.labelTruncated, true);
  assert.equal(
    projectedLongField && 'currentValueAvailable' in projectedLongField
      ? projectedLongField.currentValueAvailable
      : false,
    true,
  );
  assert.equal(
    projectedLongField && 'currentValue' in projectedLongField,
    false,
  );
});

void test('keeps journey read mocks aligned with the real demo projector', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const evaluations = JSON.parse(
    await readFile(
      new URL('../evals/formproof-evals.json', import.meta.url),
      'utf8',
    ),
  ) as AuthoredEvalCase[];

  for (const evaluation of evaluations.filter(({ name }) =>
    name.startsWith('[journey]'),
  )) {
    const contextCalls = evaluation.expectedCall.filter(
      ({ functionName }) => functionName === 'get_form_context',
    );
    assert.ok(contextCalls.length > 0);
    for (const call of contextCalls) {
      const cursor = call.arguments.cursor;
      const parsed =
        cursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFormContextCursor(
              cursor,
              initialState.source.sourceHash,
              call.arguments,
            );
      assert.equal(parsed.ok, true, `${evaluation.name} has an invalid cursor`);
      if (!parsed.ok) throw new Error('Authored context cursor was invalid.');
      const actual = createFormContextToolData(
        initialState,
        inspection,
        parsed.offset,
        call.arguments.limit ?? 6,
        call.arguments,
      );
      assert.deepEqual(
        call.mockOutput.data,
        actual,
        `${evaluation.name} does not match the real context projector`,
      );
    }
    for (const call of evaluation.expectedCall.filter(
      ({ functionName }) => functionName === 'get_field_evidence',
    )) {
      assert.ok(call.arguments.fieldNames);
      assert.deepEqual(
        call.mockOutput.data,
        createFieldEvidenceToolData(
          initialState,
          inspection,
          call.arguments.fieldNames,
        ),
        `${evaluation.name} does not match the real evidence projector`,
      );
    }
  }
});

void test('paginates long choice evidence without losing exact values', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const choices = Array.from({ length: 20 }, (_, index) => ({
    value: `option-${index}-${'值'.repeat(24)}`,
    label: `Choice ${index} ${'说明'.repeat(12)}`,
  }));
  const choiceValues = choices.map(({ value }) => value);
  const state: FormState = {
    ...initialState,
    fields: {
      ...initialState.fields,
      [FIELD.housing]: {
        ...initialState.fields[FIELD.housing],
        options: choiceValues,
      },
    },
  };
  const choiceInspection: PdfInspection = {
    ...inspection,
    fields: inspection.fields.map((field) =>
      field.name === FIELD.housing
        ? { ...field, choices, options: choiceValues }
        : field,
    ),
  };
  const adapter: FormProofWebMcpAdapter = {
    getFormContext: async () => {
      throw new Error('not used');
    },
    getFieldEvidence(input) {
      const parsed =
        input.choiceCursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFieldChoiceCursor(
              input.choiceCursor,
              state.source.sourceHash,
              input.fieldNames[0],
            );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error('Generated choice cursor was invalid.');
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        data: createFieldEvidenceToolData(
          state,
          choiceInspection,
          input.fieldNames,
          parsed.offset,
        ),
      };
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const evidence = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  ).find(({ name }) => name === 'get_field_evidence');
  assert.ok(evidence);

  const collected: Array<{ value: string; label: string }> = [];
  let choiceCursor: string | null = null;
  do {
    const response: FormProofToolResponse = await evidence.execute({
      expectedStateVersion: state.stateVersion,
      expectedSourceHash: state.source.sourceHash,
      fieldNames: [FIELD.housing],
      ...(choiceCursor === null ? {} : { choiceCursor }),
    });
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error('Choice evidence page failed.');
    assert.equal(response.outputTruncated, false);
    assert.ok(
      serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `choice evidence used ${serializedBytes(response)} bytes`,
    );
    const field: {
      constraints: {
        choices: Array<{ value: string; label: string }>;
        choicePage?: { nextCursor: string | null };
      };
    } = (
      response.data as {
        fields: Array<{
          constraints: {
            choices: Array<{ value: string; label: string }>;
            choicePage?: { nextCursor: string | null };
          };
        }>;
      }
    ).fields[0];
    collected.push(...field.constraints.choices);
    choiceCursor = field.constraints.choicePage?.nextCursor ?? null;
    assert.equal(
      response.nextAction,
      choiceCursor === null ? 'stage_form_values' : 'get_field_evidence',
    );
  } while (choiceCursor !== null);

  assert.deepEqual(collected, choices);
});

void test('reports an overlong field name without silently skipping it', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const original = inspection.fields[0];
  const longName = 'field-'.padEnd(1_000, 'x');
  const state = await createFormState(initialState.source, [
    {
      ...initialState.fields[original.name],
      name: longName,
      label: 'Long canonical field name',
      required: false,
    },
  ]);
  const longInspection: PdfInspection = {
    ...inspection,
    fieldCount: 1,
    widgetCount: 1,
    fields: [
      {
        ...original,
        name: longName,
        required: false,
        current: '',
      },
    ],
  };
  const adapter: FormProofWebMcpAdapter = {
    getFormContext(input) {
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        data: createFormContextToolData(
          state,
          longInspection,
          0,
          input.limit,
          input,
        ),
      };
    },
    getFieldEvidence: async () => {
      throw new Error('not used');
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const context = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  ).find(({ name }) => name === 'get_form_context');
  assert.ok(context);

  const response = await context.execute({ limit: 1 });
  assert.equal(response.ok, true);
  if (!response.ok) throw new Error('Long-name context failed.');
  assert.equal(response.outputTruncated, false);
  assert.ok(serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES);
  const data = response.data as {
    fields: Array<{
      agentAddressable: false;
      nameLength: number;
      name?: string;
    }>;
    pagination: {
      returned: number;
      total: number;
      nextCursor: string | null;
    };
  };
  assert.equal(data.fields[0].agentAddressable, false);
  assert.equal(data.fields[0].nameLength, longName.length);
  assert.equal('name' in data.fields[0], false);
  assert.deepEqual(data.pagination, {
    returned: 1,
    total: 1,
    nextCursor: null,
  });
});

void test('never repeats an unreturnable choice cursor', async () => {
  const { inspection, initialState } = await loadStagedDemo();
  const original = inspection.fields[0];
  const longName = 'choice-field-'.padEnd(256, 'n');
  const oversizedValue = 'v'.repeat(1_201);
  const choices = [
    { value: oversizedValue, label: 'L'.repeat(180) },
    { value: 'safe', label: 'Safe choice' },
  ];
  const initial = await createFormState(initialState.source, [
    {
      name: longName,
      label: 'F'.repeat(180),
      type: 'dropdown',
      required: false,
      readOnly: false,
      humanOnly: false,
      options: choices.map(({ value }) => value),
      multiSelect: false,
      sourceValue: null,
    },
  ]);
  const state: FormState = {
    ...initial,
    draft: {
      [longName]: {
        fieldName: longName,
        value: 'draft',
        actor: 'agent',
        provenance: {
          kind: 'agent_inference',
          confidence: 0.7,
          evidence: ['E'.repeat(120), 'S'.repeat(120)],
          rationale: 'R'.repeat(180),
        },
      },
    },
  };
  const choiceInspection: PdfInspection = {
    ...inspection,
    fieldCount: 1,
    widgetCount: 1,
    fields: [
      {
        ...original,
        name: longName,
        type: 'dropdown',
        required: false,
        current: '',
        options: choices.map(({ value }) => value),
        choices,
        multiSelect: false,
        maxLength: null,
        tooltip: 'T'.repeat(180),
      },
    ],
  };
  const adapter: FormProofWebMcpAdapter = {
    getFormContext: async () => {
      throw new Error('not used');
    },
    getFieldEvidence(input) {
      const parsed =
        input.choiceCursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFieldChoiceCursor(
              input.choiceCursor,
              state.source.sourceHash,
              longName,
            );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error('Choice cursor was invalid.');
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        data: createFieldEvidenceToolData(
          state,
          choiceInspection,
          input.fieldNames,
          parsed.offset,
        ),
      };
    },
    stageFormValues: async () => {
      throw new Error('not used');
    },
    validateFillPlan: async () => {
      throw new Error('not used');
    },
    startFillReview: async () => {
      throw new Error('not used');
    },
  };
  const evidence = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  ).find(({ name }) => name === 'get_field_evidence');
  assert.ok(evidence);

  const response = await evidence.execute({
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    fieldNames: [longName],
  });
  assert.equal(response.ok, true);
  if (!response.ok) throw new Error('Oversized choice evidence failed.');
  assert.equal(response.outputTruncated, false);
  assert.ok(serializedBytes(response) <= FORMPROOF_MAX_RESPONSE_BYTES);
  const page = (
    response.data as {
      fields: Array<{
        constraints: {
          choicePage: {
            returned: number;
            unavailableChoiceCount: number;
            nextCursor: string | null;
          };
        };
      }>;
    }
  ).fields[0].constraints.choicePage;
  assert.ok(page.returned + page.unavailableChoiceCount > 0);
  assert.notEqual(
    page.nextCursor,
    createFieldChoiceCursor(0, state.source.sourceHash, longName),
  );
});

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
      ({ normalAppearancePresent }) => normalAppearancePresent,
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
    inspection.fields.map(createFormFieldDefinitionFromPdf),
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
