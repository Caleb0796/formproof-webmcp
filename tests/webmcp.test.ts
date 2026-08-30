import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FormProofAdapterResult,
  FormProofWebMcpAdapter,
  WebMcpModelContext,
  WebMcpToolDefinition,
} from '../lib/webmcp';
import type {
  PdfEngineWarning,
  PdfFieldDescriptor,
  PdfFieldType,
  PdfInspection,
} from '../lib/pdf-engine';

const {
  FORMPROOF_MAX_RESPONSE_BYTES,
  FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
  FORMPROOF_WEBMCP_TOOL_NAMES,
  createFieldChoiceCursor,
  createFieldEvidenceToolData,
  createFormContextCursor,
  createFormContextToolData,
  parseFieldChoiceCursor,
  parseFormContextCursor,
  registerFormProofWebMcpTools,
} = (await import(
  new URL('../lib/webmcp.ts', import.meta.url).href
)) as typeof import('../lib/webmcp');

const { createFormState, resolvePdfFieldLabel, stageFieldUpdates } =
  (await import(
    new URL('../lib/form-state.ts', import.meta.url).href
  )) as typeof import('../lib/form-state');

const SOURCE_HASH = 'a'.repeat(64);

const EMPTY_ACTIVE_CONTENT = {
  javascriptActionCount: 0,
  additionalActionDictionaryCount: 0,
  openActionCount: 0,
  externalActionCount: 0,
  highRiskActionCount: 0,
  otherActionCount: 0,
} as const;

const NO_PROTECTION = {
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
    rawByteRangeNameCount: 0,
    historicalByteRangeNameCount: 0,
    revisionMarkerCount: 1,
    historyScanComplete: true,
    historyScanIssues: [],
    malformedByteRangeCount: 0,
    byteRanges: [],
    byteRangesCoverWholeFile: null,
    signatureDictionaryCount: 0,
    usageRightsSignatureCount: 0,
    documentSignatureCount: 0,
    unclassifiedSignatureDictionaryCount: 0,
    unreachableSignatureDictionaryCount: 0,
    signatureFieldCount: 0,
    signedSignatureFieldCount: 0,
    docMdpPresent: false,
    docMdpSignatureDictionaryCount: 0,
    docMdpPermission: null,
    fieldMdpPresent: false,
    adbeExtension: null,
    xfaPresent: false,
    sigFlags: null,
    unknownStructures: [],
    cmsIntegrity: 'not_applicable',
    signerTrust: 'not_applicable',
  },
} as const satisfies PdfInspection['protection'];

const USAGE_RIGHTS_PROTECTION = {
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
    rawByteRangeNameCount: 1,
    historicalByteRangeNameCount: 0,
    revisionMarkerCount: 3,
    historyScanComplete: true,
    historyScanIssues: [],
    malformedByteRangeCount: 0,
    byteRanges: [[0, 100, 200, 20] as const],
    byteRangesCoverWholeFile: true,
    signatureDictionaryCount: 1,
    usageRightsSignatureCount: 1,
    documentSignatureCount: 0,
    unclassifiedSignatureDictionaryCount: 0,
    unreachableSignatureDictionaryCount: 0,
    signatureFieldCount: 0,
    signedSignatureFieldCount: 0,
    docMdpPresent: false,
    docMdpSignatureDictionaryCount: 0,
    docMdpPermission: null,
    fieldMdpPresent: false,
    adbeExtension: { baseVersion: '1.7', extensionLevel: 8 },
    xfaPresent: false,
    sigFlags: 2,
    unknownStructures: [],
    cmsIntegrity: 'not_verified_in_browser',
    signerTrust: 'not_verified',
  },
} as const satisfies PdfInspection['protection'];

const USAGE_RIGHTS_TOOL_DATA = {
  protectionType: USAGE_RIGHTS_PROTECTION.protectionType,
  allowedMutations: USAGE_RIGHTS_PROTECTION.allowedMutations,
  exportStrategies: USAGE_RIGHTS_PROTECTION.exportStrategies,
  signatureImpact: USAGE_RIGHTS_PROTECTION.signatureImpact,
  requiresHumanConfirmation: USAGE_RIGHTS_PROTECTION.requiresHumanConfirmation,
  protectionEvidence: USAGE_RIGHTS_PROTECTION.evidence,
  exportStrategySelection: 'human_ui_only',
  agentMaySelectExportStrategy: false,
} as const;

interface ContextFieldSpec {
  name: string;
  label?: string;
  current?: string;
  tooltip?: string | null;
  xfaSpeak?: string | null;
  xfaCaption?: string | null;
  type?: PdfFieldType;
  required?: boolean;
  readOnly?: boolean;
  humanOnly?: boolean;
}

async function createContextFixture(
  specs: readonly ContextFieldSpec[],
  options: {
    fileName?: string;
    warnings?: PdfEngineWarning[];
    activeContent?: PdfInspection['activeContent'];
    protection?: PdfInspection['protection'];
  } = {},
) {
  const fields = specs.map((spec, index): PdfFieldDescriptor => {
    const type = spec.type ?? 'text';
    const rect = { x: 20, y: 700 - index * 20, width: 120, height: 18 };
    return {
      name: spec.name,
      type,
      current: type === 'signature' ? null : (spec.current ?? ''),
      options: [],
      choices: [],
      multiSelect: false,
      required: spec.required ?? false,
      readOnly: spec.readOnly ?? false,
      humanOnly: spec.humanOnly ?? type === 'signature',
      page: 1,
      rect,
      maxLength: null,
      tooltip: spec.tooltip ?? null,
      xfaSpeak: spec.xfaSpeak ?? null,
      xfaCaption: spec.xfaCaption ?? null,
      widgetCount: 1,
      widgets: [
        {
          page: 1,
          rect,
          hasAppearance: true,
          appearanceState: null,
          choiceValue: null,
        },
      ],
    };
  });
  const state = await createFormState(
    {
      fileName: options.fileName ?? 'official-form.pdf',
      sourceHash: SOURCE_HASH,
      byteLength: 2_048,
      pageCount: 3,
    },
    specs.map((spec, index) => ({
      name: spec.name,
      label: spec.label ?? resolvePdfFieldLabel(fields[index]).label,
      type:
        fields[index].type === 'signature'
          ? ('signature' as const)
          : ('text' as const),
      required: spec.required ?? false,
      readOnly:
        (spec.readOnly ?? false) || fields[index].type === 'unsupported',
      humanOnly:
        (spec.humanOnly ?? fields[index].type === 'signature') ||
        fields[index].type === 'unsupported',
      sourceValue:
        fields[index].type === 'signature' ? null : (spec.current ?? ''),
    })),
  );
  const inspection: PdfInspection = {
    sourceHash: SOURCE_HASH,
    pageCount: 3,
    fieldCount: fields.length,
    widgetCount: fields.length,
    activeContent: options.activeContent ?? EMPTY_ACTIVE_CONTENT,
    protection: options.protection ?? NO_PROTECTION,
    fields,
    warnings: options.warnings ?? [],
  };
  return { state, inspection };
}

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
    getPdfProtection: async () => success(USAGE_RIGHTS_TOOL_DATA),
    getFormContext: async () => success({ fields: [] }),
    getFieldEvidence: async () => success({ fields: [] }),
    stageFormValues: async () => success({ staged: [] }, 5),
    validateFillPlan: async () =>
      success({
        valid: true,
        stagedFieldCount: 1,
        canApprove: true,
        issues: [],
      }),
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
    [true, true, true, false, true, false],
  );
  const protection = byName(tools, 'get_pdf_protection');
  assert.deepEqual(protection.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  assert.match(
    protection.description,
    /does not verify signer trust or select an export strategy/u,
  );
  assert.match(
    byName(tools, 'get_form_context').description,
    /not semantic inference/u,
  );
  const contextSchema = byName(tools, 'get_form_context').inputSchema as {
    properties: {
      cursor: { description: string };
      queries: { description: string; maxItems: number };
    };
  };
  assert.match(
    contextSchema.properties.cursor.description,
    /Repeat the same queries and agentWritableOnly values/u,
  );
  assert.ok(contextSchema.properties.cursor.description.length <= 150);
  assert.ok(contextSchema.properties.queries.description.length <= 150);
  assert.match(
    contextSchema.properties.queries.description,
    /bounded untrusted XFA text/u,
  );
  assert.match(
    contextSchema.properties.queries.description,
    /exact-SOM and tooltip gating/u,
  );
  assert.match(
    contextSchema.properties.queries.description,
    /not semantic search/u,
  );
  assert.equal(contextSchema.properties.queries.maxItems, 3);
  assert.match(
    byName(tools, 'validate_fill_plan').description,
    /does not prove whole-form completion, execute or validate PDF JavaScript/u,
  );
});

void test('reports exact PDF protection without allowing agent strategy selection', async () => {
  const received: unknown[] = [];
  const { tools } = await captureTools(
    createAdapter({
      getPdfProtection: async (input) => {
        received.push(input);
        return success(USAGE_RIGHTS_TOOL_DATA, 9);
      },
    }),
  );
  const protection = byName(tools, 'get_pdf_protection');
  const response = await protection.execute({});

  assert.deepEqual(received, [{}]);
  assert.deepEqual(response, {
    ok: true,
    stateVersion: 9,
    sourceHash: SOURCE_HASH,
    nextAction: 'get_form_context',
    data: USAGE_RIGHTS_TOOL_DATA,
    outputTruncated: false,
  });
  if (
    !response.ok ||
    response.data === null ||
    typeof response.data !== 'object' ||
    Array.isArray(response.data)
  ) {
    throw new Error('Protection inspection must return structured data.');
  }
  assert.deepEqual(
    {
      protectionType: response.data.protectionType,
      allowedMutations: response.data.allowedMutations,
      exportStrategies: response.data.exportStrategies,
      signatureImpact: response.data.signatureImpact,
      requiresHumanConfirmation: response.data.requiresHumanConfirmation,
      exportStrategySelection: response.data.exportStrategySelection,
      agentMaySelectExportStrategy: response.data.agentMaySelectExportStrategy,
    },
    {
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
      exportStrategySelection: 'human_ui_only',
      agentMaySelectExportStrategy: false,
    },
  );
  const protectionEvidence = response.data.protectionEvidence;
  if (
    protectionEvidence === null ||
    typeof protectionEvidence !== 'object' ||
    Array.isArray(protectionEvidence)
  ) {
    throw new Error('Protection evidence must remain structured.');
  }
  assert.deepEqual(protectionEvidence, USAGE_RIGHTS_PROTECTION.evidence);
  assert.deepEqual(
    {
      rawByteRangeNameCount: protectionEvidence.rawByteRangeNameCount,
      historicalByteRangeNameCount:
        protectionEvidence.historicalByteRangeNameCount,
      revisionMarkerCount: protectionEvidence.revisionMarkerCount,
      historyScanComplete: protectionEvidence.historyScanComplete,
      historyScanIssues: protectionEvidence.historyScanIssues,
    },
    {
      rawByteRangeNameCount: 1,
      historicalByteRangeNameCount: 0,
      revisionMarkerCount: 3,
      historyScanComplete: true,
      historyScanIssues: [],
    },
  );
  assert.ok(serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES);

  for (const [input, path] of [
    [
      { exportStrategy: 'confirmed_plain_derivative_pdf' },
      'input.exportStrategy',
    ],
    [
      { humanConfirmedProtectionLoss: true },
      'input.humanConfirmedProtectionLoss',
    ],
    [{ requiresHumanConfirmation: false }, 'input.requiresHumanConfirmation'],
  ] as const) {
    const rejected = await protection.execute(input);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'INVALID_INPUT');
    assert.equal(rejected.nextAction, 'fix_tool_input');
    assert.deepEqual(rejected.error.issues, [{ code: 'INVALID_INPUT', path }]);
  }
  assert.deepEqual(received, [{}]);
  assert.equal(
    FORMPROOF_WEBMCP_TOOL_NAMES.some((name) =>
      /select.*export|export.*strategy/iu.test(name),
    ),
    false,
  );
  for (const tool of tools) {
    assert.doesNotMatch(
      JSON.stringify(tool.inputSchema),
      /exportStrategy|humanConfirmedProtectionLoss|requiresHumanConfirmation/u,
    );
  }
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

  const searchedPage = await context.execute({
    limit: 2,
    queries: ['  Employee State  ', 'signature'],
    agentWritableOnly: true,
  });
  assert.equal(searchedPage.ok, true);
  assert.deepEqual(receivedContext, {
    limit: 2,
    queries: ['Employee State', 'signature'],
    agentWritableOnly: true,
  });

  const pagedSearch = await context.execute({
    limit: 1,
    queries: ['name', 'signature'],
  });
  assert.equal(pagedSearch.ok, true);
  assert.deepEqual(receivedContext, {
    limit: 1,
    queries: ['name', 'signature'],
  });

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

void test('rejects ambiguous or unusable context search inputs', async () => {
  let contextCalls = 0;
  const { tools } = await captureTools(
    createAdapter({
      getFormContext: async () => {
        contextCalls += 1;
        return success({ fields: [] });
      },
    }),
  );
  const context = byName(tools, 'get_form_context');
  const invalidInputs = [
    { queries: [] },
    { queries: ['one', 'two', 'three', 'four'] },
    { queries: ['one', 'two', 'three', 'four', 'five', 'six'] },
    { queries: ['   '] },
    { queries: ['---'] },
    { queries: ['State', ' state '] },
    { queries: ['x'.repeat(81)] },
    { queries: ['name'], agentWritableOnly: 'yes' },
  ];

  for (const input of invalidInputs) {
    const response = await context.execute(input);
    assert.equal(response.ok, false, JSON.stringify(input));
    assert.equal(response.error.code, 'INVALID_INPUT', JSON.stringify(input));
    assert.equal(response.nextAction, 'fix_tool_input', JSON.stringify(input));
  }
  assert.equal(contextCalls, 0);
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

  const searchScope = {
    queries: ['Employee State', 'signature'],
    agentWritableOnly: true,
  } as const;
  const filteredCursor = createFormContextCursor(2, SOURCE_HASH, searchScope);
  assert.deepEqual(
    parseFormContextCursor(filteredCursor, SOURCE_HASH, searchScope),
    { ok: true, offset: 2 },
  );
  assert.deepEqual(
    parseFormContextCursor(filteredCursor, SOURCE_HASH, {
      ...searchScope,
      queries: ['signature', 'Employee State'],
    }),
    { ok: false, code: 'invalid_input' },
  );
  assert.deepEqual(
    parseFormContextCursor(filteredCursor, SOURCE_HASH, {
      ...searchScope,
      agentWritableOnly: false,
    }),
    { ok: false, code: 'invalid_input' },
  );
  assert.deepEqual(parseFormContextCursor(filteredCursor, SOURCE_HASH), {
    ok: false,
    code: 'invalid_input',
  });
  assert.deepEqual(parseFormContextCursor(cursor, SOURCE_HASH, searchScope), {
    ok: false,
    code: 'invalid_input',
  });
  assert.deepEqual(
    parseFormContextCursor(filteredCursor, 'b'.repeat(64), searchScope),
    { ok: false, code: 'source_mismatch' },
  );

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

void test('ranks batched lexical search deterministically and indexes bounded raw tooltips', async () => {
  const { state, inspection } = await createContextFixture([
    {
      name: 'employee_state',
      label: 'Employee State',
    },
    {
      name: 'mailing_code',
      label: 'Mailing employee state code',
    },
    {
      name: 'state_employee_code',
      label: 'State employee code',
    },
    {
      name: 'CB_1',
      label: 'CB_1',
      tooltip:
        'Select this box when the employee attests that they are a citizen of the United States. '.repeat(
          6,
        ),
    },
  ]);
  const rankingScope = { queries: ['employee state'] } as const;

  function collectNames() {
    const names: string[] = [];
    let offset = 0;
    let nextCursor: string | null;
    do {
      const data = createFormContextToolData(
        state,
        inspection,
        offset,
        6,
        rankingScope,
      );
      names.push(
        ...data.fields.map((field) => {
          assert.deepEqual(field.matchedQueries, ['employee state']);
          assert.equal(typeof field.name, 'string');
          return field.name!;
        }),
      );
      nextCursor = data.pagination.nextCursor;
      assert.equal(data.pagination.total, 3);
      if (nextCursor === null) continue;
      const parsed = parseFormContextCursor(
        nextCursor,
        SOURCE_HASH,
        rankingScope,
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error('Search cursor should be valid.');
      offset = parsed.offset;
    } while (nextCursor !== null);
    return names;
  }

  assert.deepEqual(collectNames(), [
    'employee_state',
    'mailing_code',
    'state_employee_code',
  ]);
  assert.deepEqual(collectNames(), collectNames());

  const tooltipSearch = createFormContextToolData(state, inspection, 0, 6, {
    queries: ['citizen employee', 'passport barcode'],
  });
  assert.equal(tooltipSearch.fields.length, 1);
  assert.ok('name' in tooltipSearch.fields[0]);
  assert.equal(
    'name' in tooltipSearch.fields[0]
      ? tooltipSearch.fields[0].name
      : undefined,
    'CB_1',
  );
  assert.deepEqual(tooltipSearch.fields[0].matchedQueries, [
    'citizen employee',
  ]);
  assert.deepEqual(tooltipSearch.search?.queries, [
    { query: 'citizen employee', matchCount: 1 },
    { query: 'passport barcode', matchCount: 0, unmatched: true },
  ]);
  assert.equal(tooltipSearch.pagination.total, 1);
  assert.equal('tooltip' in tooltipSearch.fields[0], false);
});

void test('finds a W-4-style opaque SOM field through bounded XFA text', async () => {
  const fieldName = 'topmostSubform[0].Page1[0].Step1a[0].f1_01[0]';
  const { state, inspection } = await createContextFixture([
    {
      name: fieldName,
      xfaSpeak: 'Page 1. Step 1: Enter Personal Information.',
      xfaCaption: '(a) First name and middle initial',
    },
  ]);

  const context = createFormContextToolData(state, inspection, 0, 6, {
    queries: ['first name and middle initial'],
  });
  assert.equal(context.fields.length, 1);
  assert.equal(
    'name' in context.fields[0] ? context.fields[0].name : undefined,
    fieldName,
  );
  assert.deepEqual(context.fields[0].matchedQueries, [
    'first name and middle initial',
  ]);
  assert.deepEqual(context.search?.queries, [
    { query: 'first name and middle initial', matchCount: 1 },
  ]);

  const evidence = createFieldEvidenceToolData(state, inspection, [fieldName]);
  assert.equal(evidence.fields[0].labelSource, 'xfa_speak');
  assert.equal(
    evidence.fields[0].label,
    'Page 1. Step 1: Enter Personal Information.',
  );
  assert.equal(Object.hasOwn(evidence.fields[0], 'xfaSpeak'), false);
  assert.equal(Object.hasOwn(evidence.fields[0], 'xfaCaption'), false);
});

void test('keeps an AcroForm tooltip authoritative over conflicting XFA search text', async () => {
  const fieldName = 'topmostSubform[0].Page1[0].SexGroup[0].CheckBox1[0]';
  const { state, inspection } = await createContextFixture([
    {
      name: fieldName,
      tooltip: 'Birth sex',
      xfaSpeak: 'Male',
      xfaCaption: 'Female',
    },
  ]);

  const tooltipSearch = createFormContextToolData(state, inspection, 0, 6, {
    queries: ['birth sex'],
  });
  assert.equal(tooltipSearch.fields.length, 1);
  assert.equal(
    'name' in tooltipSearch.fields[0]
      ? tooltipSearch.fields[0].name
      : undefined,
    fieldName,
  );

  const blockedXfaSearch = createFormContextToolData(state, inspection, 0, 6, {
    queries: ['male', 'female'],
  });
  assert.deepEqual(blockedXfaSearch.fields, []);
  assert.deepEqual(blockedXfaSearch.search?.queries, [
    { query: 'male', matchCount: 0, unmatched: true },
    { query: 'female', matchCount: 0, unmatched: true },
  ]);

  const evidence = createFieldEvidenceToolData(state, inspection, [fieldName]);
  assert.equal(evidence.fields[0].label, 'Birth sex');
  assert.equal(evidence.fields[0].labelSource, 'acroform_tooltip');
});

void test('does not return long raw XFA text or exceed the evidence byte target', async () => {
  const rawXfaMarker = 'NEVER_RETURN_RAW_XFA';
  const specs = Array.from({ length: 3 }, (_, index) => ({
    name: `topmostSubform[0].Page1[0].Section[${index}].f1_0${index}[0]`,
    xfaSpeak: `Page 1. Semantic field ${index + 1}.`,
    xfaCaption: `${rawXfaMarker}-${index}-${'表单😀\\"'.repeat(600)}`,
  }));
  const { state, inspection } = await createContextFixture(specs);
  const fieldNames = specs.map(({ name }) => name);
  const data = createFieldEvidenceToolData(state, inspection, fieldNames);
  const { tools } = await captureTools(
    createAdapter({
      getFieldEvidence: async () => success(data, Number.MAX_SAFE_INTEGER),
    }),
  );
  const response = await byName(tools, 'get_field_evidence').execute({
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: SOURCE_HASH,
    fieldNames,
  });

  assert.equal(response.ok, true);
  assert.equal(response.outputTruncated, false);
  assert.ok(
    serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `XFA evidence response used ${serializedBytes(response)} bytes`,
  );
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /xfaSpeak|xfaCaption/u);
  assert.equal(serialized.includes(rawXfaMarker), false);
});

void test('gives every matched query a first-page representative without duplicates', async () => {
  const broadFields = Array.from({ length: 12 }, (_, index) => ({
    name: `name_${index}`,
    label: `Name ${index}`,
  }));
  const { state, inspection } = await createContextFixture([
    ...broadFields,
    {
      name: 'employee_signature',
      label: 'Employee signature',
      humanOnly: true,
    },
    {
      name: 'shared_attestation',
      label: 'Citizen attestation signature',
    },
  ]);
  const scope = { queries: ['name', 'signature'] } as const;
  const first = createFormContextToolData(state, inspection, 0, 2, scope);

  assert.deepEqual(
    first.fields.map((field) => ('name' in field ? field.name : undefined)),
    ['name_0', 'employee_signature'],
  );
  assert.deepEqual(first.search, {
    matchMethod: 'lexical',
    queries: [
      { query: 'name', matchCount: 12 },
      { query: 'signature', matchCount: 2 },
    ],
  });
  assert.ok(
    serializedBytes(first) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `batched search used ${serializedBytes(first)} bytes`,
  );

  const deduplicated = createFormContextToolData(state, inspection, 0, 2, {
    queries: ['citizen attestation', 'signature attestation'],
  });
  assert.equal(deduplicated.fields.length, 1);
  assert.equal(
    'name' in deduplicated.fields[0] ? deduplicated.fields[0].name : undefined,
    'shared_attestation',
  );
  assert.deepEqual(deduplicated.fields[0].matchedQueries, [
    'citizen attestation',
    'signature attestation',
  ]);
});

void test('filters context to fields an agent can actually stage', async () => {
  const { state, inspection } = await createContextFixture([
    { name: 'writable', label: 'Writable name' },
    { name: 'locked', label: 'Locked name', readOnly: true },
    { name: 'ink_only', label: 'Ink signature', humanOnly: true },
    { name: 'signature', type: 'signature' },
    { name: 'push_button', type: 'unsupported' },
  ]);
  const data = createFormContextToolData(state, inspection, 0, 6, {
    agentWritableOnly: true,
  });

  assert.deepEqual(
    data.fields.map((field) => ('name' in field ? field.name : undefined)),
    ['writable'],
  );
  assert.equal(data.pagination.nextCursor, null);
  assert.equal(data.pagination.total, 1);
});

void test('reports zero scoped pagination total for an empty search', async () => {
  const { state, inspection } = await createContextFixture([
    { name: 'employee_name', label: 'Employee name' },
  ]);
  const data = createFormContextToolData(state, inspection, 0, 6, {
    queries: ['passport barcode'],
  });

  assert.deepEqual(data.fields, []);
  assert.deepEqual(data.pagination, {
    returned: 0,
    total: 0,
    nextCursor: null,
  });

  const { tools } = await captureTools(
    createAdapter({ getFormContext: async () => success(data) }),
  );
  const response = await byName(tools, 'get_form_context').execute({
    queries: ['passport barcode'],
  });
  assert.equal(response.ok, true);
  assert.equal(response.nextAction, 'retry_with_different_query');
});

void test('emits compact safety and validation diagnostics only on the initial context page', async () => {
  const activeContent = {
    javascriptActionCount: 4,
    additionalActionDictionaryCount: 3,
    openActionCount: 1,
    externalActionCount: 2,
    highRiskActionCount: 0,
    otherActionCount: 7,
  };
  const { state, inspection } = await createContextFixture(
    [{ name: 'required_name', required: true }, { name: 'optional_name' }],
    {
      activeContent,
      warnings: [
        { code: 'APPEARANCE_UNAVAILABLE', message: 'one' },
        { code: 'ACTIVE_CONTENT_PRESERVED', message: 'two' },
        { code: 'APPEARANCE_UNAVAILABLE', message: 'three' },
      ],
    },
  );
  const initial = createFormContextToolData(state, inspection, 0, 1);
  const continuation = createFormContextToolData(state, inspection, 1, 1);

  assert.deepEqual(initial.pagination, {
    returned: 1,
    total: 2,
    nextCursor: createFormContextCursor(1, SOURCE_HASH),
  });
  assert.deepEqual(continuation.pagination, {
    returned: 1,
    total: 2,
    nextCursor: null,
  });

  assert.deepEqual(initial.safety, {
    approvalBoundary: 'ui_approval_only',
    pdfJavaScriptExecuted: false,
    activeContent,
    warningCount: 3,
    warningCounts: {
      ACTIVE_CONTENT_PRESERVED: 1,
      APPEARANCE_UNAVAILABLE: 2,
    },
  });
  if (initial.validation === undefined) {
    throw new Error('Initial context must include validation diagnostics.');
  }
  assert.deepEqual(
    {
      structurallyValid: initial.validation.structurallyValid,
      completionStatus: initial.validation.completionStatus,
      ruleCoverage: initial.validation.ruleCoverage,
      formCompletenessAssessed: initial.validation.formCompletenessAssessed,
    },
    {
      structurallyValid: false,
      completionStatus: 'incomplete',
      ruleCoverage: 'pdf_required_flags_only',
      formCompletenessAssessed: false,
    },
  );
  assert.ok('document' in initial);
  assert.deepEqual(Object.keys(continuation).sort(), [
    'fields',
    'pagination',
    'untrustedPdfContent',
  ]);
  assert.ok(
    serializedBytes(initial) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `initial context used ${serializedBytes(initial)} bytes`,
  );
  assert.ok(
    serializedBytes(continuation) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
  );
});

void test('does not claim review can open when unknown protection offers no artifact', async () => {
  const { state, inspection } = await createContextFixture(
    [{ name: 'name', label: 'Name' }],
    {
      protection: {
        ...NO_PROTECTION,
        protectionType: 'unknown',
        allowedMutations: ['inspect_fields', 'stage_field_values'],
        exportStrategies: [],
        signatureImpact: 'rewrite_blocked_for_unknown_protection',
        evidence: {
          ...NO_PROTECTION.evidence,
          unknownStructures: ['historical_scan_inconclusive'],
        },
      },
    },
  );
  const staged = await stageFieldUpdates(state, {
    expectedStateVersion: state.stateVersion,
    expectedSourceHash: state.source.sourceHash,
    actor: 'agent',
    updates: [
      {
        fieldName: 'name',
        value: 'Ari',
        provenance: {
          kind: 'user_instruction',
          confidence: 1,
          evidence: ['The user supplied this name.'],
        },
      },
    ],
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error('Synthetic writable field did not stage.');

  const unknownContext = createFormContextToolData(
    staged.state,
    inspection,
    0,
    6,
  );
  const ordinaryContext = createFormContextToolData(
    staged.state,
    { ...inspection, protection: NO_PROTECTION },
    0,
    6,
  );

  assert.equal(unknownContext.validation?.canApprove, true);
  assert.equal(unknownContext.validation?.canOpenReview, false);
  assert.equal(ordinaryContext.validation?.canOpenReview, true);
});

void test('keeps a complete escaped UTF-8 context response under the recommended budget', async () => {
  const longText = '表单😀\\"'.repeat(300);
  const { state, inspection } = await createContextFixture(
    [
      { name: 'legal_name', label: longText, current: longText },
      ...Array.from({ length: 5 }, (_, index) => ({
        name: `field_${index}`,
        label: `Field ${index}`,
      })),
    ],
    { fileName: longText },
  );
  const data = createFormContextToolData(state, inspection, 0, 6);
  const { tools } = await captureTools(
    createAdapter({
      getFormContext: async () => success(data, Number.MAX_SAFE_INTEGER),
    }),
  );
  const response = await byName(tools, 'get_form_context').execute({
    limit: 6,
  });

  assert.equal(response.ok, true);
  assert.equal(response.outputTruncated, false);
  assert.equal(response.nextAction, 'get_field_evidence');
  assert.deepEqual(response.data, data);
  assert.ok(
    serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    `escaped context response used ${serializedBytes(response)} bytes`,
  );
  const projected = data.fields.find(
    (field) => 'name' in field && field.name === 'legal_name',
  );
  assert.equal(projected?.labelTruncated, true);
  assert.equal(
    projected && 'currentValueAvailable' in projected
      ? projected.currentValueAvailable
      : false,
    true,
  );
  assert.equal(projected && 'currentValue' in projected, false);
  assert.equal(data.safety?.pdfJavaScriptExecuted, false);
  assert.deepEqual(data.safety?.activeContent, EMPTY_ACTIVE_CONTENT);
});

void test('keeps an irreducible legal search result addressable', async () => {
  const query = 'q'.repeat(80);
  const name = `${query}_${'"'.repeat(48)}${'x'.repeat(121)}`;
  assert.equal(name.length, 250);
  assert.equal(serializedBytes(name), 300);
  const { state, inspection } = await createContextFixture(
    [{ name, label: 'L'.repeat(128) }],
    {
      fileName: 'F'.repeat(128),
      activeContent: {
        javascriptActionCount: 4,
        additionalActionDictionaryCount: 3,
        openActionCount: 1,
        externalActionCount: 2,
        highRiskActionCount: 0,
        otherActionCount: 1,
      },
      warnings: [
        { code: 'ACTIVE_CONTENT_PRESERVED', message: 'preserved' },
        { code: 'JAVASCRIPT_UNVALIDATED', message: 'not executed' },
        { code: 'APPEARANCE_UNAVAILABLE', message: 'appearance missing' },
      ],
    },
  );
  const scope = { queries: [query], agentWritableOnly: true } as const;
  const data = createFormContextToolData(state, inspection, 0, 1, scope);
  assert.equal(data.fields.length, 1);

  const { tools } = await captureTools(
    createAdapter({
      getFormContext: async () => success(data, Number.MAX_SAFE_INTEGER),
    }),
  );
  const response = await byName(tools, 'get_form_context').execute({
    limit: 1,
    ...scope,
  });

  assert.equal(response.ok, true);
  assert.equal(response.outputTruncated, false);
  assert.equal(response.nextAction, 'get_field_evidence');
  assert.notEqual(response.data, '[truncated]');
  if (
    response.data === null ||
    typeof response.data !== 'object' ||
    Array.isArray(response.data)
  ) {
    throw new Error('The legal field identity must be recoverable.');
  }
  const fields = response.data.fields as Array<{ name?: string }>;
  assert.equal(fields[0]?.name, name);
  assert.equal(response.data.contextProjection, 'identity_only');
  assert.ok(serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES);
});

void test('paginates three maximum-size query representatives without starvation', async () => {
  const queries = ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)];
  const names = queries.map(
    (query, index) => `${query}_${'"'.repeat(48)}${index}${'x'.repeat(120)}`,
  );
  for (const name of names) {
    assert.equal(name.length, 250);
    assert.equal(serializedBytes(name), 300);
  }
  const { state, inspection } = await createContextFixture(
    names.map((name, index) => ({
      name,
      label: `${index}${'L'.repeat(127)}`,
    })),
    { fileName: 'F'.repeat(128) },
  );
  const scope = { queries, agentWritableOnly: true } as const;
  const { tools } = await captureTools(
    createAdapter({
      getFormContext: async (input) => {
        let offset = 0;
        if (input.cursor !== undefined) {
          const parsed = parseFormContextCursor(
            input.cursor,
            SOURCE_HASH,
            input,
          );
          if (!parsed.ok) {
            return {
              ok: false,
              stateVersion: Number.MAX_SAFE_INTEGER,
              sourceHash: SOURCE_HASH,
              error: { code: parsed.code },
            };
          }
          offset = parsed.offset;
        }
        return success(
          createFormContextToolData(
            state,
            inspection,
            offset,
            input.limit,
            input,
          ),
          Number.MAX_SAFE_INTEGER,
        );
      },
    }),
  );
  const context = byName(tools, 'get_form_context');
  const returnedNames: string[] = [];
  let cursor: string | undefined;
  let pageIndex = 0;

  do {
    const response = await context.execute({ limit: 3, ...scope, cursor });
    assert.equal(response.ok, true);
    assert.equal(response.outputTruncated, false);
    assert.notEqual(response.data, '[truncated]');
    assert.ok(
      serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `maximum-size search page used ${serializedBytes(response)} bytes`,
    );
    if (
      !response.ok ||
      response.data === null ||
      typeof response.data !== 'object' ||
      Array.isArray(response.data)
    ) {
      throw new Error('Every representative page must retain its identity.');
    }
    const data = response.data as {
      fields: Array<{ name?: string }>;
      pagination: { returned: number; nextCursor: string | null };
    };
    assert.equal(data.pagination.returned, data.fields.length);
    assert.ok(data.fields.length > 0);
    if (pageIndex === 0) assert.equal(data.fields.length, 1);
    for (const field of data.fields) {
      assert.ok(field.name);
      returnedNames.push(field.name!);
    }
    cursor = data.pagination.nextCursor ?? undefined;
    pageIndex += 1;
  } while (cursor !== undefined);

  assert.deepEqual(returnedNames, names);
  assert.equal(new Set(returnedNames).size, names.length);
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
    [
      'PDF_HIGH_RISK_ACTION_UNSUPPORTED',
      'PDF_ACTION_UNSUPPORTED',
      'load_different_pdf',
    ],
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

void test('validate derives review readiness from available artifacts without claiming whole-form validity', async () => {
  const reviewArtifacts = ['filled_pdf', 'fill_package'] as const;
  const report = {
    stateVersion: 4,
    issues: [],
    blockerCount: 0,
    reviewCount: 0,
    reviewFieldNames: [],
    structurallyValid: true,
    completionStatus: 'unknown',
    ruleCoverage: 'pdf_required_flags_only',
    formCompletenessAssessed: false,
    canApprove: true,
  } as const;
  const readyTools = (
    await captureTools(
      createAdapter({
        validateFillPlan: async () =>
          success({
            valid: false,
            stagedFieldCount: 1,
            reviewArtifacts,
            exportStrategySelection: 'human_ui_only',
            ...report,
          }),
      }),
    )
  ).tools;
  const emptyTools = (
    await captureTools(
      createAdapter({
        validateFillPlan: async () =>
          success({
            valid: true,
            readyForReview: true,
            stagedFieldCount: 0,
            reviewArtifacts,
            exportStrategySelection: 'human_ui_only',
            ...report,
          }),
      }),
    )
  ).tools;
  const blockedTools = (
    await captureTools(
      createAdapter({
        validateFillPlan: async () =>
          success({
            valid: true,
            stagedFieldCount: 1,
            reviewArtifacts,
            exportStrategySelection: 'human_ui_only',
            ...report,
            structurallyValid: false,
            completionStatus: 'incomplete',
            canApprove: false,
            blockerCount: 1,
            issues: [{ code: 'required_missing' }],
          }),
      }),
    )
  ).tools;
  const noArtifactTools = (
    await captureTools(
      createAdapter({
        validateFillPlan: async () =>
          success({
            valid: true,
            stagedFieldCount: 1,
            reviewArtifacts: [],
            exportStrategySelection: 'human_ui_only',
            ...report,
          }),
      }),
    )
  ).tools;
  const actionBlockedTools = (
    await captureTools(
      createAdapter({
        validateFillPlan: async () =>
          success({
            valid: true,
            readyForReview: true,
            stagedFieldCount: 1,
            reviewArtifacts: ['fill_package'],
            exportStrategySelection: 'human_ui_only',
            exportBlockedByPdfActions: 2,
            ...report,
          }),
      }),
    )
  ).tools;
  const input = {
    expectedStateVersion: 4,
    expectedSourceHash: SOURCE_HASH,
  };

  const ready = await byName(readyTools, 'validate_fill_plan').execute(input);
  const empty = await byName(emptyTools, 'validate_fill_plan').execute(input);
  const blocked = await byName(blockedTools, 'validate_fill_plan').execute(
    input,
  );
  const noArtifact = await byName(
    noArtifactTools,
    'validate_fill_plan',
  ).execute(input);
  const actionBlocked = await byName(
    actionBlockedTools,
    'validate_fill_plan',
  ).execute(input);

  assert.equal(ready.nextAction, 'start_fill_review');
  assert.equal(empty.nextAction, 'resolve_validation_issues');
  assert.equal(blocked.nextAction, 'start_fill_review');
  assert.equal(noArtifact.nextAction, 'resolve_validation_issues');
  assert.equal(actionBlocked.nextAction, 'start_fill_review');
  if (
    !ready.ok ||
    !empty.ok ||
    !blocked.ok ||
    !noArtifact.ok ||
    !actionBlocked.ok
  ) {
    throw new Error('Synthetic validation adapters should succeed.');
  }
  if (
    ready.data === null ||
    typeof ready.data !== 'object' ||
    Array.isArray(ready.data) ||
    empty.data === null ||
    typeof empty.data !== 'object' ||
    Array.isArray(empty.data) ||
    blocked.data === null ||
    typeof blocked.data !== 'object' ||
    Array.isArray(blocked.data) ||
    noArtifact.data === null ||
    typeof noArtifact.data !== 'object' ||
    Array.isArray(noArtifact.data) ||
    actionBlocked.data === null ||
    typeof actionBlocked.data !== 'object' ||
    Array.isArray(actionBlocked.data)
  ) {
    throw new Error('Validation results must be objects.');
  }
  assert.equal(ready.data.readyForReview, true);
  assert.equal(empty.data.readyForReview, false);
  assert.equal(blocked.data.readyForReview, true);
  assert.equal(noArtifact.data.readyForReview, false);
  assert.equal(actionBlocked.data.readyForReview, true);
  assert.equal(actionBlocked.data.exportBlockedByPdfActions, 2);
  assert.equal('valid' in ready.data, false);
  assert.deepEqual(ready.data, {
    readyForReview: true,
    stagedFieldCount: 1,
    reviewArtifacts: ['filled_pdf', 'fill_package'],
    exportStrategySelection: 'human_ui_only',
    stateVersion: 4,
    blockerCount: 0,
    reviewCount: 0,
    reviewFieldNames: [],
    structurallyValid: true,
    completionStatus: 'unknown',
    ruleCoverage: 'pdf_required_flags_only',
    formCompletenessAssessed: false,
    canApprove: true,
    issues: [],
  });
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
    getFormContext: async () => success({ fields }, Number.MAX_SAFE_INTEGER),
  });
  const { tools } = await captureTools(adapter);
  const response = await byName(tools, 'get_form_context').execute({
    limit: 6,
  });

  assert.equal(response.ok, true);
  assert.equal(response.outputTruncated, true);
  assert.equal(response.nextAction, 'retry_with_narrower_scope');
  assert.ok(serializedBytes(response) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES);
  assert.equal(response.data, '[truncated]');
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
      serializedBytes(first) <= FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
      `serialized output used ${serializedBytes(first)} bytes`,
    );
    assert.equal(first.data, '[truncated]');
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
