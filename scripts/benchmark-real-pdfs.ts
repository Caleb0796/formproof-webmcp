import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PDFDocument } from 'pdf-lib';

import type { FormState } from '../lib/form-state';
import type {
  PdfActiveContentSummary,
  PdfFieldValue,
  PdfInspection,
} from '../lib/pdf-engine';
import type {
  FormContextScope,
  FormProofToolResponse,
  FormProofWebMcpAdapter,
  GetFormContextInput,
  WebMcpToolDefinition,
} from '../lib/webmcp';

const { createFormFieldDefinitionFromPdf, createFormState } = (await import(
  new URL('../lib/form-state.ts', import.meta.url).href
)) as typeof import('../lib/form-state');
const { applyApprovedValues, inspectPdf, PdfEngineError } = (await import(
  new URL('../lib/pdf-engine.ts', import.meta.url).href
)) as typeof import('../lib/pdf-engine');
const {
  createFormContextToolData,
  createFormProofToolDefinitions,
  parseFormContextCursor,
} = (await import(
  new URL('../lib/webmcp.ts', import.meta.url).href
)) as typeof import('../lib/webmcp');

interface BlockedOutcome {
  status: 'blocked';
  code: string;
}

interface WritableOutcome {
  status: 'writable';
  fieldCount: number;
  widgetCount: number;
  humanOnlyFieldCount?: number;
  recoveredRadioGroupCount?: number;
  activeContent: PdfActiveContentSummary;
}

interface QueryExperiment {
  queries: string[];
  expectedFirstPageFieldNames: string[];
}

interface WriteExperiment {
  values: Record<string, PdfFieldValue>;
}

interface CorpusDocument {
  id: string;
  fileName: string;
  title: string;
  agency: string;
  officialUrl: string;
  sha256: string;
  byteLength: number;
  pageCount: number;
  expectedEngineOutcome: BlockedOutcome | WritableOutcome;
  queryExperiment?: QueryExperiment;
  writeExperiment?: WriteExperiment;
}

interface CorpusManifest {
  schemaVersion: 1;
  corpusRoot: string;
  measurement: {
    encoding: 'UTF-8';
    tokenProxy: 'utf8_bytes_divided_by_4';
    tokenProxyIsTokenizer: false;
  };
  documents: CorpusDocument[];
}

interface ContextMeasurement {
  calls: number;
  returnedFields: number;
  uniqueReturnedFields: number;
  inputUtf8Bytes: number;
  outputUtf8Bytes: number;
  totalUtf8Bytes: number;
  approximateTokenProxy: number;
  firstPageFieldNames: string[];
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function approximateTokens(bytes: number): number {
  return Number((bytes / 4).toFixed(2));
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(message);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new TypeError(message);
  return value;
}

function createContextTool(
  state: FormState,
  inspection: PdfInspection,
): WebMcpToolDefinition {
  const adapter: FormProofWebMcpAdapter = {
    getFormContext(input) {
      const parsed =
        input.cursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFormContextCursor(
              input.cursor,
              state.source.sourceHash,
              input,
            );
      if (!parsed.ok) {
        return {
          ok: false,
          stateVersion: state.stateVersion,
          sourceHash: state.source.sourceHash,
          error: { code: parsed.code },
        };
      }
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        data: createFormContextToolData(
          state,
          inspection,
          parsed.offset,
          input.limit,
          input,
        ),
      };
    },
    getFieldEvidence: async () => {
      throw new TypeError('The benchmark only measures context discovery.');
    },
    stageFormValues: async () => {
      throw new TypeError('The benchmark never stages personal data.');
    },
    validateFillPlan: async () => {
      throw new TypeError('The benchmark never validates a fill plan.');
    },
    startFillReview: async () => {
      throw new TypeError('The benchmark never opens review.');
    },
  };
  const tool = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  ).find(({ name }) => name === 'get_form_context');
  if (tool === undefined) {
    throw new TypeError('get_form_context is not registered.');
  }
  return tool;
}

async function measureContext(
  tool: WebMcpToolDefinition,
  scope: FormContextScope,
  stopAfterFirstPage: boolean,
): Promise<ContextMeasurement> {
  let cursor: string | undefined;
  let calls = 0;
  let inputUtf8Bytes = 0;
  let outputUtf8Bytes = 0;
  const fieldNames: string[] = [];
  let firstPageFieldNames: string[] = [];

  do {
    const input: GetFormContextInput = {
      limit: 6,
      ...(scope.queries === undefined ? {} : { queries: [...scope.queries] }),
      ...(scope.agentWritableOnly === undefined
        ? {}
        : { agentWritableOnly: scope.agentWritableOnly }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    inputUtf8Bytes += utf8Bytes(input);
    const response: FormProofToolResponse = await tool.execute(input);
    outputUtf8Bytes += utf8Bytes(response);
    calls += 1;
    if (!response.ok) {
      throw new TypeError(
        `get_form_context failed during measurement: ${response.error.code}`,
      );
    }
    const data = requireRecord(response.data, 'Context data is not an object.');
    if (!Array.isArray(data.fields)) {
      throw new TypeError('Context data does not contain fields.');
    }
    const pageFieldNames = data.fields.map((value, index) => {
      const field = requireRecord(value, `Context field ${index} is invalid.`);
      return requireString(field.name, `Context field ${index} has no name.`);
    });
    if (calls === 1) firstPageFieldNames = pageFieldNames;
    fieldNames.push(...pageFieldNames);

    const pagination = requireRecord(
      data.pagination,
      'Context pagination is not an object.',
    );
    const nextCursor = pagination.nextCursor;
    if (nextCursor !== null && typeof nextCursor !== 'string') {
      throw new TypeError('Context pagination returned an invalid cursor.');
    }
    if (stopAfterFirstPage) break;
    if (nextCursor === cursor) {
      throw new TypeError('Context pagination repeated the same cursor.');
    }
    cursor = nextCursor ?? undefined;
    if (cursor !== undefined && pageFieldNames.length === 0) {
      throw new TypeError('Context pagination made no progress.');
    }
    if (calls > 1_000) {
      throw new TypeError('Context pagination exceeded 1,000 calls.');
    }
  } while (cursor !== undefined);

  const totalUtf8Bytes = inputUtf8Bytes + outputUtf8Bytes;
  return {
    calls,
    returnedFields: fieldNames.length,
    uniqueReturnedFields: new Set(fieldNames).size,
    inputUtf8Bytes,
    outputUtf8Bytes,
    totalUtf8Bytes,
    approximateTokenProxy: approximateTokens(totalUtf8Bytes),
    firstPageFieldNames,
  };
}

function warningCounts(inspection: PdfInspection): Record<string, number> {
  const counts = new Map<string, number>();
  for (const warning of inspection.warnings) {
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function measureWriteRoundTrip(
  source: Uint8Array,
  inspection: PdfInspection,
  experiment: WriteExperiment,
) {
  const result = await applyApprovedValues(source, experiment.values);
  const reopened = await inspectPdf(result.bytes);
  const expectedFieldNames = Object.keys(experiment.values).sort();
  assertEqual(
    result.verifiedFields.map(({ name }) => name).sort(),
    expectedFieldNames,
    'Round-trip verified field names changed',
  );
  assertEqual(
    result.verifiedFields.every(({ appearanceVerified }) => appearanceVerified),
    true,
    'Round-trip appearance verification failed',
  );
  for (const [fieldName, value] of Object.entries(experiment.values)) {
    const field = reopened.fields.find(({ name }) => name === fieldName);
    if (field === undefined) {
      throw new TypeError(`Round-trip field disappeared: ${fieldName}`);
    }
    assertEqual(
      field.current,
      value,
      `Round-trip value mismatch: ${fieldName}`,
    );
  }
  assertEqual(
    reopened.activeContent,
    inspection.activeContent,
    'Round-trip active-content summary changed',
  );
  assertEqual(
    [reopened.pageCount, reopened.fieldCount, reopened.widgetCount],
    [inspection.pageCount, inspection.fieldCount, inspection.widgetCount],
    'Round-trip form structure changed',
  );
  if (result.sourceHash === result.outputHash) {
    throw new TypeError('A nonempty write experiment returned source bytes.');
  }
  return {
    passed: true,
    stagedFieldCount: expectedFieldNames.length,
    verifiedFieldNames: expectedFieldNames,
    appearanceVerifiedFieldCount: result.verifiedFields.length,
    activeContentPreserved: true,
    structurePreserved: true,
    outputByteLength: result.bytes.byteLength,
  };
}

function percentSaved(smaller: number, baseline: number): number {
  return Number((((baseline - smaller) / baseline) * 100).toFixed(2));
}

function parseCorpusDirectory(manifest: CorpusManifest): string {
  const prefix = '--corpus-dir=';
  const argument = process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix));
  const unknown = process.argv
    .slice(2)
    .filter((value) => !value.startsWith(prefix));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown arguments: ${unknown.join(', ')}`);
  }
  return resolve(
    process.cwd(),
    argument?.slice(prefix.length) ?? manifest.corpusRoot,
  );
}

const manifest = JSON.parse(
  await readFile(
    new URL('../evals/real-pdf-corpus.json', import.meta.url),
    'utf8',
  ),
) as CorpusManifest;
assertEqual(manifest.schemaVersion, 1, 'Unsupported corpus schema');
assertEqual(manifest.documents.length, 5, 'The corpus must contain five PDFs');
const corpusDirectory = parseCorpusDirectory(manifest);

const emptyResult = () => ({
  ok: true as const,
  stateVersion: 0,
  sourceHash: null,
  data: {},
});
const descriptorAdapter: FormProofWebMcpAdapter = {
  getFormContext: emptyResult,
  getFieldEvidence: emptyResult,
  stageFormValues: emptyResult,
  validateFillPlan: emptyResult,
  startFillReview: emptyResult,
};
const toolCatalog = createFormProofToolDefinitions(
  descriptorAdapter,
  () => undefined,
  new AbortController().signal,
).map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));
const toolCatalogUtf8Bytes = utf8Bytes({ tools: toolCatalog });

const results: Array<Record<string, unknown>> = [];
for (const document of manifest.documents) {
  const bytes = new Uint8Array(
    await readFile(resolve(corpusDirectory, document.fileName)),
  );
  const actualHash = sha256(bytes);
  assertEqual(actualHash, document.sha256, `${document.id} SHA-256 mismatch`);
  assertEqual(
    bytes.byteLength,
    document.byteLength,
    `${document.id} byte length mismatch`,
  );
  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  assertEqual(
    loaded.getPageCount(),
    document.pageCount,
    `${document.id} page count mismatch`,
  );

  try {
    const inspection = await inspectPdf(bytes);
    const expected = document.expectedEngineOutcome;
    if (expected.status !== 'writable') {
      throw new TypeError(
        `${document.id} unexpectedly became writable instead of failing with ${expected.code}.`,
      );
    }
    assertEqual(
      inspection.fieldCount,
      expected.fieldCount,
      `${document.id} field count mismatch`,
    );
    assertEqual(
      inspection.widgetCount,
      expected.widgetCount,
      `${document.id} widget count mismatch`,
    );
    assertEqual(
      inspection.activeContent,
      expected.activeContent,
      `${document.id} active-content summary mismatch`,
    );
    if (expected.humanOnlyFieldCount !== undefined) {
      assertEqual(
        inspection.fields.filter(({ humanOnly }) => humanOnly).length,
        expected.humanOnlyFieldCount,
        `${document.id} human-only field count mismatch`,
      );
    }
    if (expected.recoveredRadioGroupCount !== undefined) {
      assertEqual(
        inspection.fields.filter(({ type }) => type === 'radio').length,
        expected.recoveredRadioGroupCount,
        `${document.id} recovered radio count mismatch`,
      );
    }
    if (document.queryExperiment === undefined) {
      throw new TypeError(`${document.id} has no query experiment.`);
    }
    if (document.writeExperiment === undefined) {
      throw new TypeError(`${document.id} has no write experiment.`);
    }

    const writeRoundTrip = await measureWriteRoundTrip(
      bytes,
      inspection,
      document.writeExperiment,
    );

    const state = await createFormState(
      {
        fileName: document.fileName,
        sourceHash: inspection.sourceHash,
        byteLength: bytes.byteLength,
        pageCount: inspection.pageCount,
      },
      inspection.fields.map(createFormFieldDefinitionFromPdf),
    );
    const contextTool = createContextTool(state, inspection);
    const fullTraversal = await measureContext(contextTool, {}, false);
    assertEqual(
      fullTraversal.returnedFields,
      inspection.fieldCount,
      `${document.id} full traversal omitted fields`,
    );
    assertEqual(
      fullTraversal.uniqueReturnedFields,
      inspection.fieldCount,
      `${document.id} full traversal repeated fields`,
    );
    const queryScope = { queries: document.queryExperiment.queries };
    const targetedFirstPage = await measureContext(
      contextTool,
      queryScope,
      true,
    );
    assertEqual(
      targetedFirstPage.firstPageFieldNames,
      document.queryExperiment.expectedFirstPageFieldNames,
      `${document.id} targeted representatives changed`,
    );
    const allQueryMatches = await measureContext(
      contextTool,
      queryScope,
      false,
    );
    assertEqual(
      allQueryMatches.returnedFields,
      allQueryMatches.uniqueReturnedFields,
      `${document.id} query traversal repeated fields`,
    );

    results.push({
      id: document.id,
      fileName: document.fileName,
      officialUrl: document.officialUrl,
      sha256: actualHash,
      byteLength: bytes.byteLength,
      pageCount: inspection.pageCount,
      writableCompatibility: true,
      writeRoundTrip,
      safety: {
        highRiskNativeActionCount: inspection.activeContent.highRiskActionCount,
        mutationWouldBeBlockedForHighRiskAction:
          inspection.activeContent.highRiskActionCount > 0,
        pdfJavaScriptExecuted: false,
        activeContent: inspection.activeContent,
        warningCount: inspection.warnings.length,
        warningCounts: warningCounts(inspection),
        formCompletenessAssessed: state.validation.formCompletenessAssessed,
        ruleCoverage: state.validation.ruleCoverage,
      },
      structure: {
        fieldCount: inspection.fieldCount,
        widgetCount: inspection.widgetCount,
        humanOnlyFieldCount: inspection.fields.filter(
          ({ humanOnly }) => humanOnly,
        ).length,
        radioGroupCount: inspection.fields.filter(
          ({ type }) => type === 'radio',
        ).length,
      },
      measurements: {
        fullTraversal,
        targetedFirstPage,
        allQueryMatches,
        targetedFirstPageVsFullTraversal: {
          totalUtf8BytesSaved:
            fullTraversal.totalUtf8Bytes - targetedFirstPage.totalUtf8Bytes,
          totalUtf8BytesSavedPercent: percentSaved(
            targetedFirstPage.totalUtf8Bytes,
            fullTraversal.totalUtf8Bytes,
          ),
          expectedRepresentativeExactMatchRate: 1,
        },
        includingOneTimeToolCatalog: {
          fullTraversalUtf8Bytes:
            toolCatalogUtf8Bytes + fullTraversal.totalUtf8Bytes,
          targetedFirstPageUtf8Bytes:
            toolCatalogUtf8Bytes + targetedFirstPage.totalUtf8Bytes,
          totalUtf8BytesSaved:
            fullTraversal.totalUtf8Bytes - targetedFirstPage.totalUtf8Bytes,
          totalUtf8BytesSavedPercent: percentSaved(
            toolCatalogUtf8Bytes + targetedFirstPage.totalUtf8Bytes,
            toolCatalogUtf8Bytes + fullTraversal.totalUtf8Bytes,
          ),
        },
      },
    });
  } catch (error) {
    const expected = document.expectedEngineOutcome;
    if (!(error instanceof PdfEngineError) || expected.status !== 'blocked') {
      throw error;
    }
    assertEqual(
      error.code,
      expected.code,
      `${document.id} block code mismatch`,
    );
    results.push({
      id: document.id,
      fileName: document.fileName,
      officialUrl: document.officialUrl,
      sha256: actualHash,
      byteLength: bytes.byteLength,
      pageCount: loaded.getPageCount(),
      writableCompatibility: false,
      safety: {
        blockedBeforeMutation: true,
        code: error.code,
        message: error.message,
      },
    });
  }
}

const writableResults = results.filter(
  (result) => result.writableCompatibility === true,
);
const blockedResults = results.filter(
  (result) => result.writableCompatibility === false,
);
const report = {
  schemaVersion: 1,
  corpusVerified: true,
  measurement: {
    encoding: 'UTF-8',
    exactByteMethod: 'TextEncoder(JSON.stringify(value)).byteLength',
    tokenProxy: 'utf8_bytes_divided_by_4',
    tokenProxyIsTokenizer: false,
    note: 'The token proxy is a model-independent approximation, not a GPT tokenizer result.',
  },
  toolCatalog: {
    toolCount: toolCatalog.length,
    utf8Bytes: toolCatalogUtf8Bytes,
    approximateTokenProxy: approximateTokens(toolCatalogUtf8Bytes),
  },
  summary: {
    documentCount: results.length,
    pageCount: manifest.documents.reduce(
      (sum, document) => sum + document.pageCount,
      0,
    ),
    writableCount: writableResults.length,
    safelyBlockedCount: blockedResults.length,
  },
  documents: results,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
