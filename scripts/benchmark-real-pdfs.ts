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

const {
  createFormFieldDefinitionFromPdf,
  createFormState,
  exportFillPackageFromUi,
  getArtifactReviewFieldNames,
  stageFieldUpdates,
} = (await import(
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

interface ExpectedProtectionFacts {
  protectionType: PdfInspection['protection']['protectionType'];
  allowedMutations: PdfInspection['protection']['allowedMutations'];
  exportStrategies: PdfInspection['protection']['exportStrategies'];
  signatureImpact: PdfInspection['protection']['signatureImpact'];
  requiresHumanConfirmation: boolean;
  catalogPermsPresent: boolean;
  permsKeys: PdfInspection['protection']['evidence']['permsKeys'];
  usageRightsKeys: PdfInspection['protection']['evidence']['usageRightsKeys'];
  byteRangeEntryCount: number;
  malformedByteRangeCount: number;
  byteRangeCount: number;
  byteRangesCoverWholeFile: boolean | null;
  signatureDictionaryCount: number;
  usageRightsSignatureCount: number;
  documentSignatureCount: number;
  unclassifiedSignatureDictionaryCount: number;
  unreachableSignatureDictionaryCount: number;
  signatureFieldCount: number;
  signedSignatureFieldCount: number;
  docMdpPresent: boolean;
  docMdpSignatureDictionaryCount: number;
  docMdpPermission: 1 | 2 | 3 | null;
  fieldMdpPresent: boolean;
  adbeExtension: PdfInspection['protection']['evidence']['adbeExtension'];
  xfaPresent: boolean;
  sigFlags: number | null;
  unknownStructures: readonly string[];
  cmsIntegrity: PdfInspection['protection']['evidence']['cmsIntegrity'];
  signerTrust: PdfInspection['protection']['evidence']['signerTrust'];
}

interface HonestUsefulResult {
  status: 'honestUsefulResult';
  artifactType: 'filled_pdf' | 'original_untouched_fill_package';
  fieldCount: number;
  widgetCount: number;
  humanOnlyFieldCount?: number;
  recoveredRadioGroupCount?: number;
  activeContent: PdfActiveContentSummary;
  protection: ExpectedProtectionFacts;
  expectedPdfRewriteError?: string;
}

interface QueryExperiment {
  queries: string[];
  expectedFirstPageFieldNames: string[];
  expectedMatchCounts: number[];
  expectedTotalMatchedFields: number;
}

interface WriteExperiment {
  values: Record<string, PdfFieldValue>;
}

interface FillPackageExperiment extends WriteExperiment {
  createdAt: string;
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
  expectedEngineOutcome: HonestUsefulResult;
  queryExperiment: QueryExperiment;
  writeExperiment?: WriteExperiment;
  fillPackageExperiment?: FillPackageExperiment;
}

interface CorpusManifest {
  schemaVersion: 2;
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
  firstPageQueryMatchCounts: number[] | null;
  firstPageMatchMethod: string | null;
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
  let firstPageQueryMatchCounts: number[] | null = null;
  let firstPageMatchMethod: string | null = null;

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
    if (calls === 1) {
      firstPageFieldNames = pageFieldNames;
      if (scope.queries !== undefined) {
        const search = requireRecord(
          data.search,
          'Query context search metadata is not an object.',
        );
        if (!Array.isArray(search.queries)) {
          throw new TypeError(
            'Query context search metadata has no per-query results.',
          );
        }
        firstPageMatchMethod = requireString(
          search.matchMethod,
          'Query context search metadata has no match method.',
        );
        firstPageQueryMatchCounts = search.queries.map((value, index) => {
          const query = requireRecord(
            value,
            `Query context search result ${index} is invalid.`,
          );
          if (typeof query.matchCount !== 'number') {
            throw new TypeError(
              `Query context search result ${index} has no matchCount.`,
            );
          }
          return query.matchCount;
        });
      }
    }
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
    firstPageQueryMatchCounts,
    firstPageMatchMethod,
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

function protectionFacts(inspection: PdfInspection): ExpectedProtectionFacts {
  const { protection } = inspection;
  return {
    protectionType: protection.protectionType,
    allowedMutations: protection.allowedMutations,
    exportStrategies: protection.exportStrategies,
    signatureImpact: protection.signatureImpact,
    requiresHumanConfirmation: protection.requiresHumanConfirmation,
    catalogPermsPresent: protection.evidence.catalogPermsPresent,
    permsKeys: protection.evidence.permsKeys,
    usageRightsKeys: protection.evidence.usageRightsKeys,
    byteRangeEntryCount: protection.evidence.byteRangeEntryCount,
    malformedByteRangeCount: protection.evidence.malformedByteRangeCount,
    byteRangeCount: protection.evidence.byteRanges.length,
    byteRangesCoverWholeFile: protection.evidence.byteRangesCoverWholeFile,
    signatureDictionaryCount: protection.evidence.signatureDictionaryCount,
    usageRightsSignatureCount: protection.evidence.usageRightsSignatureCount,
    documentSignatureCount: protection.evidence.documentSignatureCount,
    unclassifiedSignatureDictionaryCount:
      protection.evidence.unclassifiedSignatureDictionaryCount,
    unreachableSignatureDictionaryCount:
      protection.evidence.unreachableSignatureDictionaryCount,
    signatureFieldCount: protection.evidence.signatureFieldCount,
    signedSignatureFieldCount: protection.evidence.signedSignatureFieldCount,
    docMdpPresent: protection.evidence.docMdpPresent,
    docMdpSignatureDictionaryCount:
      protection.evidence.docMdpSignatureDictionaryCount,
    docMdpPermission: protection.evidence.docMdpPermission,
    fieldMdpPresent: protection.evidence.fieldMdpPresent,
    adbeExtension: protection.evidence.adbeExtension,
    xfaPresent: protection.evidence.xfaPresent,
    sigFlags: protection.evidence.sigFlags,
    unknownStructures: protection.evidence.unknownStructures,
    cmsIntegrity: protection.evidence.cmsIntegrity,
    signerTrust: protection.evidence.signerTrust,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function hasKeyDeep(value: unknown, forbidden: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyDeep(item, forbidden));
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => forbidden.has(key) || hasKeyDeep(child, forbidden),
  );
}

function semanticCoverage(state: FormState, inspection: PdfInspection) {
  const meaningfulTooltipCount = inspection.fields.filter(({ tooltip }) => {
    const normalized = tooltip?.trim().toLowerCase();
    return (
      normalized !== undefined &&
      normalized !== '' &&
      normalized !== 'undefined' &&
      normalized !== 'null'
    );
  }).length;
  const semanticLabelAvailableCount = Object.values(state.fields).filter(
    ({ name, label }) => label !== name,
  ).length;
  return {
    meaningfulTooltipCount,
    semanticLabelAvailableCount,
    semanticLabelUnavailableCount:
      inspection.fieldCount - semanticLabelAvailableCount,
    semanticLabelCoveragePercent: Number(
      ((semanticLabelAvailableCount / inspection.fieldCount) * 100).toFixed(2),
    ),
    xfaFallbackOnly: inspection.protection.evidence.xfaPresent,
    xfaSemanticLimitation: inspection.protection.evidence.xfaPresent
      ? 'Only AcroForm fallback names/tooltips were measured; XFA captions, scripts, calculations, validation, and layout were not evaluated.'
      : null,
  };
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

async function measureFillPackage(
  source: Uint8Array,
  inspection: PdfInspection,
  initialState: FormState,
  experiment: FillPackageExperiment,
  expectedPdfRewriteError: string,
) {
  const sourceSnapshot = source.slice();
  const sourceHashBefore = sha256(source);
  const provenance = {
    kind: 'user_instruction' as const,
    confidence: 1,
    evidence: ['Synthetic benchmark value'],
  };
  const staged = await stageFieldUpdates(initialState, {
    expectedStateVersion: initialState.stateVersion,
    expectedSourceHash: initialState.source.sourceHash,
    actor: 'agent',
    updates: Object.entries(experiment.values).map(([fieldName, value]) => ({
      fieldName,
      value,
      provenance,
    })),
  });
  if (!staged.ok) {
    throw new TypeError(
      `Fill-package staging failed: ${staged.errors.map(({ code }) => code).join(', ')}`,
    );
  }
  const confirmedFieldNames = getArtifactReviewFieldNames(staged.state);
  const request = {
    confirmedFieldNames,
    createdAt: experiment.createdAt,
  };
  const exported = await exportFillPackageFromUi(staged.state, source, request);
  if (!exported.ok) {
    throw new TypeError(
      `Fill-package export failed: ${exported.errors.map(({ code }) => code).join(', ')}`,
    );
  }
  const repeated = await exportFillPackageFromUi(staged.state, source, request);
  if (!repeated.ok) {
    throw new TypeError(
      `Repeated fill-package export failed: ${repeated.errors.map(({ code }) => code).join(', ')}`,
    );
  }

  const decoded = JSON.parse(
    new TextDecoder().decode(exported.result.bytes),
  ) as unknown;
  assertEqual(
    decoded,
    exported.result.manifest,
    'Fill-package JSON round-trip changed the manifest',
  );
  assertEqual(
    exported.result.manifest.protection,
    inspection.protection,
    'Fill-package protection facts changed',
  );
  assertEqual(
    exported.result.manifest.source,
    {
      fileName: initialState.source.fileName,
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    'Fill-package source binding changed',
  );
  assertEqual(
    {
      stateVersion: exported.result.manifest.plan.stateVersion,
      planHash: exported.result.manifest.plan.planHash,
    },
    {
      stateVersion: staged.state.stateVersion,
      planHash: staged.state.planHash,
    },
    'Fill-package plan binding changed',
  );
  assertEqual(
    exported.result.manifest.plan.confirmedFieldNames,
    confirmedFieldNames,
    'Fill-package confirmations changed',
  );
  let multiWidgetChoiceMappingsVerified = 0;
  for (const [fieldName, proposedValue] of Object.entries(experiment.values)) {
    const descriptor = inspection.fields.find(({ name }) => name === fieldName);
    const definition = initialState.fields[fieldName];
    const packaged = exported.result.manifest.plan.stagedFields.find(
      (field) => field.fieldName === fieldName,
    );
    if (
      descriptor === undefined ||
      definition === undefined ||
      packaged === undefined
    ) {
      throw new TypeError(`Fill-package field disappeared: ${fieldName}`);
    }
    assertEqual(
      packaged,
      {
        fieldName,
        label: definition.label,
        semanticLabelAvailable: definition.label !== fieldName,
        type: definition.type,
        required: definition.required,
        multiSelect: descriptor.multiSelect,
        choices: descriptor.choices,
        widgets: descriptor.widgets,
        page: descriptor.page,
        rect: descriptor.rect,
        sourceValue: descriptor.current,
        proposedValue,
        provenance,
      },
      `Fill-package staged field changed: ${fieldName}`,
    );
    if (
      descriptor.type === 'radio' &&
      descriptor.widgets.length > 1 &&
      typeof proposedValue === 'string'
    ) {
      assertEqual(
        packaged.widgets.filter(
          ({ choiceValue }) => choiceValue === proposedValue,
        ).length,
        1,
        `Fill-package choice-to-widget mapping is ambiguous: ${fieldName}`,
      );
      multiWidgetChoiceMappingsVerified += 1;
    }
  }
  assertEqual(
    bytesEqual(exported.result.bytes, repeated.result.bytes),
    true,
    'Fixed-createdAt fill-package bytes were nondeterministic',
  );
  assertEqual(
    exported.result.outputHash,
    repeated.result.outputHash,
    'Fixed-createdAt fill-package hash was nondeterministic',
  );
  assertEqual(
    exported.result.outputHash,
    sha256(exported.result.bytes),
    'Fill-package output hash did not match its bytes',
  );
  assertEqual(
    exported.result.manifest.sourcePdfModified,
    false,
    'Fill-package claimed to modify the source PDF',
  );
  if (
    hasKeyDeep(
      exported.result.manifest,
      new Set([
        'appearanceVerified',
        'appearancesPresent',
        'signatureIntegrityPreserved',
        'signatureVerified',
      ]),
    )
  ) {
    throw new TypeError(
      'Fill package must not claim PDF appearance or signature verification.',
    );
  }

  let rewriteError: InstanceType<typeof PdfEngineError> | undefined;
  try {
    await applyApprovedValues(source, experiment.values);
  } catch (error) {
    if (!(error instanceof PdfEngineError)) throw error;
    rewriteError = error;
  }
  if (rewriteError === undefined) {
    throw new TypeError('Protected/XFA PDF rewrite unexpectedly succeeded.');
  }
  assertEqual(
    rewriteError.code,
    expectedPdfRewriteError,
    'Protected/XFA PDF rewrite error changed',
  );
  assertEqual(
    [sha256(source), bytesEqual(source, sourceSnapshot)],
    [sourceHashBefore, true],
    'Fill-package workflow changed the original PDF bytes',
  );

  return {
    passed: true,
    artifactType: exported.result.manifest.artifactType,
    stagedFieldCount: Object.keys(experiment.values).length,
    confirmedFieldCount: confirmedFieldNames.length,
    humanStepCount: exported.result.manifest.plan.humanSteps.length,
    multiWidgetChoiceMappingsVerified,
    semanticLabelUnavailableStagedFieldCount:
      exported.result.manifest.plan.stagedFields.filter(
        ({ semanticLabelAvailable }) => !semanticLabelAvailable,
      ).length,
    jsonRoundTripVerified: exported.result.roundTripVerified,
    deterministicWithFixedCreatedAt: true,
    sourceHashBound: true,
    planHashBound: true,
    sourceBytesUnchanged: true,
    sourcePdfModified: false,
    protectionFactsPreserved: true,
    pdfAppearanceVerification: 'not_applicable_no_pdf_rewrite',
    documentSignatureVerification: 'not_performed',
    cmsSignatureVerification: 'not_performed',
    signerTrustVerification: 'not_performed',
    pdfRewriteRejected: true,
    pdfRewriteErrorCode: rewriteError.code,
    outputByteLength: exported.result.bytes.byteLength,
    outputHash: exported.result.outputHash,
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
assertEqual(manifest.schemaVersion, 2, 'Unsupported corpus schema');
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
  const sourceSnapshot = bytes.slice();
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

  const inspectionStartedAt = performance.now();
  const inspection = await inspectPdf(bytes);
  const inspectionDurationMs = Number(
    (performance.now() - inspectionStartedAt).toFixed(2),
  );
  const expected = document.expectedEngineOutcome;
  assertEqual(
    expected.status,
    'honestUsefulResult',
    `${document.id} expected result status changed`,
  );
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
  assertEqual(
    protectionFacts(inspection),
    expected.protection,
    `${document.id} protection facts changed`,
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

  const state = await createFormState(
    {
      fileName: document.fileName,
      sourceHash: inspection.sourceHash,
      byteLength: bytes.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const artifactStartedAt = performance.now();
  let artifactValidation: Record<string, unknown>;
  if (expected.artifactType === 'filled_pdf') {
    if (
      document.writeExperiment === undefined ||
      document.fillPackageExperiment !== undefined
    ) {
      throw new TypeError(
        `${document.id} must define only a filled-PDF write experiment.`,
      );
    }
    artifactValidation = await measureWriteRoundTrip(
      bytes,
      inspection,
      document.writeExperiment,
    );
  } else {
    if (
      document.fillPackageExperiment === undefined ||
      document.writeExperiment !== undefined ||
      expected.expectedPdfRewriteError === undefined
    ) {
      throw new TypeError(
        `${document.id} must define only a protected fill-package experiment and rewrite error.`,
      );
    }
    artifactValidation = await measureFillPackage(
      bytes,
      inspection,
      state,
      document.fillPackageExperiment,
      expected.expectedPdfRewriteError,
    );
  }
  const artifactDurationMs = Number(
    (performance.now() - artifactStartedAt).toFixed(2),
  );

  assertEqual(
    [sha256(bytes), bytesEqual(bytes, sourceSnapshot)],
    [actualHash, true],
    `${document.id} source bytes changed during the experiment`,
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
  const targetedFirstPage = await measureContext(contextTool, queryScope, true);
  assertEqual(
    targetedFirstPage.firstPageFieldNames,
    document.queryExperiment.expectedFirstPageFieldNames,
    `${document.id} targeted representatives changed`,
  );
  assertEqual(
    targetedFirstPage.firstPageQueryMatchCounts,
    document.queryExperiment.expectedMatchCounts,
    `${document.id} per-query match counts changed`,
  );
  assertEqual(
    targetedFirstPage.firstPageMatchMethod,
    'lexical',
    `${document.id} query match method changed`,
  );
  const allQueryMatches = await measureContext(contextTool, queryScope, false);
  assertEqual(
    allQueryMatches.returnedFields,
    allQueryMatches.uniqueReturnedFields,
    `${document.id} query traversal repeated fields`,
  );
  assertEqual(
    allQueryMatches.returnedFields,
    document.queryExperiment.expectedTotalMatchedFields,
    `${document.id} query traversal match total changed`,
  );

  results.push({
    id: document.id,
    fileName: document.fileName,
    officialUrl: document.officialUrl,
    sha256: actualHash,
    byteLength: bytes.byteLength,
    pageCount: inspection.pageCount,
    honestUsefulResult: true,
    artifactType: expected.artifactType,
    artifactValidation,
    compatibility: {
      fieldInspection: true,
      fieldValueStaging: true,
      filledPdf: expected.artifactType === 'filled_pdf',
      originalUntouchedFillPackage:
        expected.artifactType === 'original_untouched_fill_package',
      pdfRewriteRejectedCode: expected.expectedPdfRewriteError ?? null,
    },
    safety: {
      highRiskNativeActionCount: inspection.activeContent.highRiskActionCount,
      mutationWouldBeBlockedForHighRiskAction:
        inspection.activeContent.highRiskActionCount > 0,
      pdfJavaScriptExecuted: false,
      activeContent: inspection.activeContent,
      warningCount: inspection.warnings.length,
      warningCounts: warningCounts(inspection),
      protection: inspection.protection,
      cmsSignatureVerification: 'not_performed',
      signerTrustVerification: 'not_performed',
      formCompletenessAssessed: state.validation.formCompletenessAssessed,
      ruleCoverage: state.validation.ruleCoverage,
    },
    accuracy: {
      artifactRoundTripVerified: true,
      queryMatchMethod: targetedFirstPage.firstPageMatchMethod,
      semanticSearchClaimed: false,
      expectedQueryRepresentativesVerified: true,
      expectedQueryMatchCountsVerified: true,
      ...semanticCoverage(state, inspection),
    },
    structure: {
      fieldCount: inspection.fieldCount,
      widgetCount: inspection.widgetCount,
      humanOnlyFieldCount: inspection.fields.filter(
        ({ humanOnly }) => humanOnly,
      ).length,
      radioGroupCount: inspection.fields.filter(({ type }) => type === 'radio')
        .length,
    },
    efficiency: {
      inspectionDurationMs,
      artifactDurationMs,
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
}

const filledPdfResults = results.filter(
  (result) => result.artifactType === 'filled_pdf',
);
const fillPackageResults = results.filter(
  (result) => result.artifactType === 'original_untouched_fill_package',
);
const report = {
  schemaVersion: 2,
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
    honestUsefulResultCount: results.filter(
      (result) => result.honestUsefulResult === true,
    ).length,
    filledPdfCount: filledPdfResults.length,
    originalUntouchedFillPackageCount: fillPackageResults.length,
  },
  documents: results,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
