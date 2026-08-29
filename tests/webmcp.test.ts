import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FormProofAdapterResult,
  FormProofWebMcpAdapter,
  WebMcpModelContext,
  WebMcpToolDefinition,
} from '../lib/webmcp';

const {
  FORMPROOF_MAX_RESPONSE_BYTES,
  FORMPROOF_WEBMCP_TOOL_NAMES,
  createFieldChoiceCursor,
  createFormContextCursor,
  parseFieldChoiceCursor,
  parseFormContextCursor,
  registerFormProofWebMcpTools,
} = (await import(
  new URL('../lib/webmcp.ts', import.meta.url).href
)) as typeof import('../lib/webmcp');

const SOURCE_HASH = 'a'.repeat(64);

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function success(data: unknown = {}, stateVersion = 4): FormProofAdapterResult {
  return {
    ok: true,
    stateVersion,
    sourceHash: SOURCE_HASH,
    data,
  };
}

function createAdapter(
  overrides: Partial<FormProofWebMcpAdapter> = {},
): FormProofWebMcpAdapter {
  return {
    getFormContext: async () => success({ fields: [] }),
    getFieldEvidence: async () => success({ fields: [] }),
    stageFormValues: async () => success({ staged: [] }, 5),
    validateFillPlan: async () => success({ valid: true }),
    startFillReview: async () => success({ reviewOpened: true }),
    ...overrides,
  };
}

async function captureTools(
  adapter: FormProofWebMcpAdapter = createAdapter(),
  options: {
    awaitVisibleCommit?: () => void | Promise<void>;
    failAt?: number;
    onRegistrationError?: (error: Error) => void;
  } = {},
) {
  const tools: WebMcpToolDefinition[] = [];
  const signals: AbortSignal[] = [];
  let registrationCount = 0;
  const modelContext: WebMcpModelContext = {
    async registerTool(tool, registrationOptions) {
      registrationCount += 1;
      if (registrationCount === options.failAt) {
        throw new Error('synthetic registration failure');
      }
      tools.push(tool);
      assert.ok(registrationOptions?.signal);
      signals.push(registrationOptions.signal);
    },
  };
  const registration = await registerFormProofWebMcpTools(adapter, {
    modelContext,
    awaitVisibleCommit: options.awaitVisibleCommit,
    onRegistrationError: options.onRegistrationError,
  });
  return { registration, tools, signals, registrationCount };
}

function byName(
  tools: WebMcpToolDefinition[],
  name: WebMcpToolDefinition['name'],
) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} should be registered`);
  return tool;
}

function assertEveryObjectSchemaIsClosed(schema: unknown, path = 'schema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.type === 'object') {
    assert.equal(
      record.additionalProperties,
      false,
      `${path} must set additionalProperties:false`,
    );
  }
  for (const key of ['properties', 'items', 'oneOf']) {
    const child = record[key];
    if (Array.isArray(child)) {
      child.forEach((value, index) =>
        assertEveryObjectSchemaIsClosed(value, `${path}.${key}[${index}]`),
      );
    } else if (key === 'properties' && child && typeof child === 'object') {
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        assertEveryObjectSchemaIsClosed(
          propertySchema,
          `${path}.properties.${propertyName}`,
        );
      }
    } else {
      assertEveryObjectSchemaIsClosed(child, `${path}.${key}`);
    }
  }
}

void test('registers the exact safe tool catalog sequentially', async () => {
  const { registration, tools, signals, registrationCount } =
    await captureTools();

  assert.equal(registration.supported, true);
  assert.equal(registrationCount, FORMPROOF_WEBMCP_TOOL_NAMES.length);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...FORMPROOF_WEBMCP_TOOL_NAMES],
  );
  assert.deepEqual(registration.registeredTools, FORMPROOF_WEBMCP_TOOL_NAMES);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0], registration.signal);
  assert.equal(registration.signal.aborted, false);

  const prohibited = /approve|export|download|sign|submit|complete/i;
  for (const tool of tools) {
    assert.doesNotMatch(tool.name, prohibited);
    assertEveryObjectSchemaIsClosed(tool.inputSchema, tool.name);
    assert.equal(tool.annotations.untrustedContentHint, true);
  }

  assert.deepEqual(
    tools.map((tool) => tool.annotations.readOnlyHint),
    [true, true, false, true, false],
  );
});

void test('keeps context and evidence requests within semantic page limits', async () => {
  let receivedContext: unknown;
  const adapter = createAdapter({
    getFormContext: async (input) => {
      receivedContext = input;
      return success({ fields: [] });
    },
  });
  const { tools } = await captureTools(adapter);
  const context = byName(tools, 'get_form_context');
  const evidence = byName(tools, 'get_field_evidence');

  const defaultPage = await context.execute({});
  assert.equal(defaultPage.ok, true);
  assert.deepEqual(receivedContext, { limit: 6 });

  const oversizedPage = await context.execute({ limit: 7 });
  assert.equal(oversizedPage.ok, false);
  assert.equal(oversizedPage.error.code, 'INVALID_INPUT');

  const tooManyFields = await evidence.execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    fieldNames: ['one', 'two', 'three', 'four'],
  });
  assert.equal(tooManyFields.ok, false);
  assert.equal(tooManyFields.error.code, 'INVALID_INPUT');

  const ambiguousChoicePage = await evidence.execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    fieldNames: ['one', 'two'],
    choiceCursor: createFieldChoiceCursor(2, SOURCE_HASH, 'one'),
  });
  assert.equal(ambiguousChoicePage.ok, false);
  assert.equal(ambiguousChoicePage.error.code, 'INVALID_INPUT');
});

void test('binds pagination cursors to the source PDF', () => {
  const cursor = createFormContextCursor(6, SOURCE_HASH);
  const sameShortPrefixHash = `${SOURCE_HASH.slice(0, 16)}${'b'.repeat(48)}`;

  assert.deepEqual(parseFormContextCursor(cursor, SOURCE_HASH), {
    ok: true,
    offset: 6,
  });
  assert.deepEqual(parseFormContextCursor(cursor, 'b'.repeat(64)), {
    ok: false,
    code: 'source_mismatch',
  });
  assert.deepEqual(parseFormContextCursor(cursor, sameShortPrefixHash), {
    ok: false,
    code: 'source_mismatch',
  });
  assert.deepEqual(parseFormContextCursor('field:6', SOURCE_HASH), {
    ok: false,
    code: 'invalid_input',
  });

  const choiceCursor = createFieldChoiceCursor(3, SOURCE_HASH, 'housing');
  assert.deepEqual(
    parseFieldChoiceCursor(choiceCursor, SOURCE_HASH, 'housing'),
    { ok: true, offset: 3 },
  );
  assert.deepEqual(
    parseFieldChoiceCursor(choiceCursor, 'b'.repeat(64), 'housing'),
    { ok: false, code: 'source_mismatch' },
  );
  assert.deepEqual(
    parseFieldChoiceCursor(choiceCursor, SOURCE_HASH, 'support'),
    { ok: false, code: 'invalid_input' },
  );
});

void test('runtime parsing rejects extra properties and human authority claims', async () => {
  let stageCalls = 0;
  let reviewCalls = 0;
  const adapter = createAdapter({
    stageFormValues: async () => {
      stageCalls += 1;
      return success();
    },
    startFillReview: async () => {
      reviewCalls += 1;
      return success({ reviewOpened: true });
    },
  });
  const { tools } = await captureTools(adapter);
  const stage = byName(tools, 'stage_form_values');
  const review = byName(tools, 'start_fill_review');

  const actorClaim = await stage.execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    actor: 'human',
    updates: [],
  });
  assert.equal(actorClaim.ok, false);
  assert.equal(actorClaim.error.code, 'INVALID_INPUT');
  assert.equal(actorClaim.nextAction, 'fix_tool_input');
  assert.deepEqual(actorClaim.error.issues, [
    { code: 'INVALID_INPUT', path: 'input.actor' },
  ]);

  const humanProvenance = await stage.execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: { kind: 'human_entry', confidence: 1 },
      },
    ],
  });
  assert.equal(humanProvenance.ok, false);
  assert.equal(humanProvenance.error.code, 'INVALID_INPUT');

  const nestedAuthorityClaim = await stage.execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          approved: true,
        },
      },
    ],
  });
  assert.equal(nestedAuthorityClaim.ok, false);
  assert.equal(nestedAuthorityClaim.error.code, 'INVALID_INPUT');
  assert.deepEqual(nestedAuthorityClaim.error.issues, [
    {
      code: 'INVALID_INPUT',
      path: 'input.updates[0].provenance.approved',
    },
  ]);

  const approvalClaim = await review.execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    approve: true,
  });
  assert.equal(approvalClaim.ok, false);
  assert.equal(approvalClaim.error.code, 'INVALID_INPUT');
  assert.equal(stageCalls, 0);
  assert.equal(reviewCalls, 0);
});

void test('stage_form_values validates, normalizes, and waits for visible state', async () => {
  const events: string[] = [];
  let received: unknown;
  const adapter = createAdapter({
    stageFormValues: async (input) => {
      events.push('adapter');
      received = input;
      return success({ stagedFieldNames: ['name'] }, 8);
    },
  });
  const { tools } = await captureTools(adapter, {
    awaitVisibleCommit: async () => {
      events.push('visible-commit');
    },
  });
  const stage = byName(tools, 'stage_form_values');

  const response = await stage.execute({
    expectedStateVersion: 7,
    expectedSourceHash: SOURCE_HASH.toUpperCase(),
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: {
          kind: 'user_instruction',
          confidence: 0.95,
          evidence: ['The user supplied this name.'],
          rationale: 'Direct instruction',
        },
      },
    ],
  });

  assert.deepEqual(events, ['adapter', 'visible-commit']);
  assert.deepEqual(received, {
    expectedStateVersion: 7,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: {
          kind: 'user_instruction',
          confidence: 0.95,
          evidence: ['The user supplied this name.'],
          rationale: 'Direct instruction',
        },
      },
    ],
  });
  assert.deepEqual(response, {
    ok: true,
    stateVersion: 8,
    sourceHash: SOURCE_HASH,
    nextAction: 'validate_fill_plan',
    data: { stagedFieldNames: ['name'] },
    outputTruncated: false,
  });
});

void test('normalizes state-engine errors with a versioned recovery action', async () => {
  let visibleCommits = 0;
  const adapter = createAdapter({
    stageFormValues: async () => ({
      ok: false,
      stateVersion: 12,
      sourceHash: SOURCE_HASH,
      error: {
        code: 'stale_state',
        message: 'The draft is now version 12.',
        details: { expected: 11, actual: 12 },
      },
    }),
  });
  const { tools } = await captureTools(adapter, {
    awaitVisibleCommit: () => {
      visibleCommits += 1;
    },
  });
  const stage = byName(tools, 'stage_form_values');
  const response = await stage.execute({
    expectedStateVersion: 11,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: { kind: 'agent_inference', confidence: 0.4 },
      },
    ],
  });

  assert.equal(visibleCommits, 1);
  assert.deepEqual(response, {
    ok: false,
    stateVersion: 12,
    sourceHash: SOURCE_HASH,
    nextAction: 'refresh_form_context',
    error: {
      code: 'STATE_VERSION_CONFLICT',
      message: 'The form changed after the referenced state version.',
    },
    outputTruncated: false,
  });
});

void test('maps state and PDF errors without exposing adapter details', async () => {
  let adapterCode = 'invalid_request';
  const adapter = createAdapter({
    stageFormValues: async () => ({
      ok: false,
      stateVersion: 4,
      sourceHash: SOURCE_HASH,
      error: {
        code: adapterCode,
        message: 'private adapter implementation detail',
        details: { secret: 'private adapter implementation detail' },
      },
    }),
  });
  const { tools } = await captureTools(adapter);
  const stage = byName(tools, 'stage_form_values');
  const input = {
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: { kind: 'agent_inference', confidence: 0.4 },
      },
    ],
  };
  const cases = [
    ['invalid_request', 'INVALID_INPUT', 'fix_tool_input'],
    ['plan_mismatch', 'STATE_VERSION_CONFLICT', 'refresh_form_context'],
    ['review_unconfirmed', 'HUMAN_ACTION_REQUIRED', 'human_review_required'],
    ['approval_missing', 'HUMAN_ACTION_REQUIRED', 'human_review_required'],
    ['approval_stale', 'STATE_VERSION_CONFLICT', 'refresh_form_context'],
    ['output_missing', 'HUMAN_ACTION_REQUIRED', 'human_review_required'],
    ['output_stale', 'STATE_VERSION_CONFLICT', 'refresh_form_context'],
    ['verification_missing', 'REVIEW_NOT_READY', 'resolve_validation_issues'],
    ['verification_stale', 'STATE_VERSION_CONFLICT', 'refresh_form_context'],
    ['verification_failed', 'VALIDATION_FAILED', 'resolve_validation_issues'],
    [
      'FIELD_VALUE_TYPE_INVALID',
      'INVALID_FIELD_TYPE',
      'resolve_validation_issues',
    ],
    [
      'FIELD_OPTION_INVALID',
      'INVALID_FIELD_OPTION',
      'resolve_validation_issues',
    ],
    ['FIELD_VALUE_TOO_LONG', 'INVALID_FIELD_TYPE', 'resolve_validation_issues'],
    ['FIELD_HUMAN_ONLY', 'HUMAN_ACTION_REQUIRED', 'human_review_required'],
  ] as const;

  for (const [internalCode, publicCode, nextAction] of cases) {
    adapterCode = internalCode;
    const response = await stage.execute(input);
    assert.equal(response.ok, false, internalCode);
    assert.equal(response.error.code, publicCode, internalCode);
    assert.equal(response.nextAction, nextAction, internalCode);
    assert.doesNotMatch(
      JSON.stringify(response),
      /private adapter/,
      internalCode,
    );
    assert.equal('details' in response.error, false, internalCode);
  }
});

void test('returns bounded public issues without leaking adapter details', async () => {
  const adapter = createAdapter({
    stageFormValues: async () => ({
      ok: false,
      stateVersion: 4,
      sourceHash: SOURCE_HASH,
      error: {
        code: 'unknown_field',
        message: 'private adapter implementation detail',
        details: [
          {
            code: 'unknown_field',
            fieldName: 'missing_name',
            secret: 'private adapter implementation detail',
          },
          { code: 'read_only', fieldName: 'locked_id' },
          { code: 'field_value_type_invalid', fieldName: 'age' },
          { code: 'read_only', fieldName: 'locked_id' },
        ],
      },
    }),
  });
  const { tools } = await captureTools(adapter);
  const response = await byName(tools, 'stage_form_values').execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: { kind: 'agent_inference', confidence: 0.4 },
      },
    ],
  });

  assert.equal(response.ok, false);
  assert.deepEqual(response.error.issues, [
    { code: 'FIELD_NOT_FOUND', fieldName: 'missing_name' },
    { code: 'FIELD_READ_ONLY', fieldName: 'locked_id' },
    { code: 'INVALID_FIELD_TYPE', fieldName: 'age' },
  ]);
  assert.doesNotMatch(JSON.stringify(response), /private adapter|secret/);
  assert.equal('details' in response.error, false);
});

void test('normalizes unknown field lists into repairable issues', async () => {
  const adapter = createAdapter({
    getFieldEvidence: async () => ({
      ok: false,
      stateVersion: 4,
      sourceHash: SOURCE_HASH,
      error: {
        code: 'unknown_field',
        details: { fieldNames: ['missing_one', 'missing_two'] },
      },
    }),
  });
  const { tools } = await captureTools(adapter);
  const response = await byName(tools, 'get_field_evidence').execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    fieldNames: ['missing_one', 'missing_two'],
  });

  assert.equal(response.ok, false);
  assert.deepEqual(response.error.issues, [
    { code: 'FIELD_NOT_FOUND', fieldName: 'missing_one' },
    { code: 'FIELD_NOT_FOUND', fieldName: 'missing_two' },
  ]);
});

void test('validate only advances a clean plan to human review', async () => {
  const validAdapter = createAdapter({
    validateFillPlan: async () => success({ valid: true, issues: [] }),
  });
  const invalidAdapter = createAdapter({
    validateFillPlan: async () =>
      success({ valid: false, issues: [{ code: 'required' }] }),
  });
  const validTools = (await captureTools(validAdapter)).tools;
  const invalidTools = (await captureTools(invalidAdapter)).tools;
  const input = {
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
  };

  const valid = await byName(validTools, 'validate_fill_plan').execute(input);
  const invalid = await byName(invalidTools, 'validate_fill_plan').execute(
    input,
  );

  assert.equal(valid.nextAction, 'start_fill_review');
  assert.equal(invalid.nextAction, 'resolve_validation_issues');
});

void test('start_fill_review stops at a human-required next action', async () => {
  let reviewCalls = 0;
  const adapter = createAdapter({
    startFillReview: async () => {
      reviewCalls += 1;
      return success({ reviewOpened: true, reviewedStateVersion: 4 });
    },
  });
  const { tools } = await captureTools(adapter);
  const response = await byName(tools, 'start_fill_review').execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
  });

  assert.equal(reviewCalls, 1);
  assert.equal(response.ok, true);
  assert.equal(response.nextAction, 'human_review_required');
  assert.equal(
    FORMPROOF_WEBMCP_TOOL_NAMES.some((name) =>
      /approve|export|download|sign|submit/i.test(name),
    ),
    false,
  );
});

void test('bounds PDF-derived tool output', async () => {
  const fields = Array.from({ length: 100 }, (_, index) => ({
    fieldName: `field-${index}`,
    label: 'x'.repeat(2_000),
  }));
  const adapter = createAdapter({
    getFormContext: async () => success({ fields }),
  });
  const { tools } = await captureTools(adapter);
  const response = await byName(tools, 'get_form_context').execute({
    limit: 6,
  });

  assert.equal(response.ok, true);
  assert.equal(response.outputTruncated, true);
  assert.equal(response.nextAction, 'retry_with_narrower_scope');
  assert.ok(serializedBytes(response) <= FORMPROOF_MAX_RESPONSE_BYTES);
  assert.notEqual(response.data, '[truncated]');
  assert.deepEqual((response.data as { fields: unknown[] }).fields, []);
});

void test('budgets UTF-8 output including escapes and multibyte text', async () => {
  const payloads = [
    'ascii'.repeat(1_000),
    '表单'.repeat(1_000),
    '😀'.repeat(1_000),
    '\0"\\😀'.repeat(600),
  ];

  for (const payload of payloads) {
    const adapter = createAdapter({
      getFormContext: async () =>
        success(
          Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => [
              `field-${index}`,
              payload,
            ]),
          ),
        ),
    });
    const { tools } = await captureTools(adapter);
    const context = byName(tools, 'get_form_context');
    const first = await context.execute({ limit: 6 });
    const second = await context.execute({ limit: 6 });
    const serialized = JSON.stringify(first);

    assert.equal(first.ok, true);
    assert.equal(first.outputTruncated, true);
    assert.equal(first.nextAction, 'retry_with_narrower_scope');
    assert.ok(
      serializedBytes(first) <= FORMPROOF_MAX_RESPONSE_BYTES,
      `serialized output used ${serializedBytes(first)} bytes`,
    );
    assert.doesNotThrow(() => JSON.parse(serialized));
    assert.deepEqual(second, first);
  }
});

void test('keeps oversized failures bounded and repairable', async () => {
  const issues = Array.from({ length: 30 }, (_, index) => ({
    code: 'unknown_field',
    fieldName: `${index}-${'表😀\\"'.repeat(40)}`,
  }));
  const adapter = createAdapter({
    stageFormValues: async () => ({
      ok: false,
      stateVersion: 4,
      sourceHash: SOURCE_HASH,
      error: { code: 'unknown_field', details: issues },
    }),
  });
  const { tools } = await captureTools(adapter);
  const response = await byName(tools, 'stage_form_values').execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: { kind: 'user_instruction', confidence: 1 },
      },
    ],
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'FIELD_NOT_FOUND');
  assert.equal(response.outputTruncated, true);
  assert.ok((response.error.issues?.length ?? 0) > 0);
  assert.ok((response.error.omittedIssueCount ?? 0) > 0);
  assert.equal(
    (response.error.issues?.length ?? 0) +
      (response.error.omittedIssueCount ?? 0),
    issues.length,
  );
  assert.ok(serializedBytes(response) <= FORMPROOF_MAX_RESPONSE_BYTES);
});

void test('reports adapter issues omitted before byte bounding', async () => {
  const issues = Array.from({ length: 30 }, (_, index) => ({
    code: 'unknown_field',
    fieldName: `missing-${index}`,
  }));
  const adapter = createAdapter({
    stageFormValues: async () => ({
      ok: false,
      stateVersion: 4,
      sourceHash: SOURCE_HASH,
      error: { code: 'unknown_field', details: issues },
    }),
  });
  const { tools } = await captureTools(adapter);
  const response = await byName(tools, 'stage_form_values').execute({
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: { kind: 'user_instruction', confidence: 1 },
      },
    ],
  });

  assert.equal(response.ok, false);
  assert.equal(response.outputTruncated, true);
  assert.equal(response.error.issues?.length, 25);
  assert.equal(response.error.omittedIssueCount, 5);
  assert.ok(serializedBytes(response) <= FORMPROOF_MAX_RESPONSE_BYTES);
});

void test('cleanup aborts every registered tool and prevents later execution', async () => {
  let contextCalls = 0;
  const adapter = createAdapter({
    getFormContext: async () => {
      contextCalls += 1;
      return success();
    },
  });
  const { registration, tools, signals } = await captureTools(adapter);

  registration.cleanup();
  registration.cleanup();
  assert.equal(registration.signal.aborted, true);
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );

  const response = await byName(tools, 'get_form_context').execute({});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'OPERATION_ABORTED');
  assert.equal(contextCalls, 0);
});

void test('a partial registration failure rolls back the whole catalog', async () => {
  let reportedError: Error | undefined;
  const { registration, signals, registrationCount } = await captureTools(
    createAdapter(),
    {
      failAt: 3,
      onRegistrationError: (error) => {
        reportedError = error;
      },
    },
  );

  assert.equal(registrationCount, 3);
  assert.equal(registration.supported, true);
  assert.deepEqual(registration.registeredTools, []);
  assert.deepEqual(registration.error, {
    code: 'REGISTRATION_FAILED',
    message: 'FormProof tools could not be registered safely.',
  });
  assert.equal(registration.signal.aborted, true);
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );
  assert.equal(reportedError?.message, 'synthetic registration failure');
});

void test('feature detection is a safe no-op without document.modelContext', async () => {
  const registration = await registerFormProofWebMcpTools(createAdapter(), {
    modelContext: null,
  });

  assert.equal(registration.supported, false);
  assert.deepEqual(registration.registeredTools, []);
  assert.equal(registration.error, undefined);
  registration.cleanup();
  assert.equal(registration.signal.aborted, true);
});
