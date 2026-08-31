import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PDFDocument } from 'pdf-lib';

import type { FormState, PdfFieldLabelSource } from '../lib/form-state';
import type {
  PdfActiveContentSummary,
  PdfFieldIdentityReviewReason,
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
  importFillPackageFromUi,
  resolvePdfFieldLabel,
  stageFieldUpdates,
} = (await import(
  new URL('../lib/form-state.ts', import.meta.url).href
)) as typeof import('../lib/form-state');
const { applyApprovedValues, inspectPdf, PdfEngineError } = (await import(
  new URL('../lib/pdf-engine.ts', import.meta.url).href
)) as typeof import('../lib/pdf-engine');
const {
  FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
  createFieldEvidenceToolData,
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
  rawByteRangeNameCount: number;
  historicalByteRangeNameCount: number;
  revisionMarkerCount: number;
  historyScanComplete: boolean;
  historyScanIssues: readonly string[];
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
  contentRisk: PdfInspection['contentRisk'];
  protection: ExpectedProtectionFacts;
  expectedPdfRewriteError?: string;
}

interface QueryExperiment {
  queries: string[];
  expectedFirstPageFieldNames: string[];
  expectedMatchCounts: number[];
  expectedTotalMatchedFields: number;
  discoveryFallbackExperiment?: DiscoveryFallbackExperiment;
}

type QueryMatchBasis = 'field_metadata' | 'discovery_alias' | 'unmatched';

interface DiscoveryFallbackCase {
  name: string;
  queries: string[];
  expectedFirstPageFieldNames: string[];
  expectedMatchCounts: number[];
  expectedTotalMatchedFields: number;
  expectedQueryMatchBases: QueryMatchBasis[];
  expectedAmbiguousQueries: boolean[];
  expectedHumanVerificationFieldNames: string[];
  expectedEvidenceByField: Record<string, DiscoveryEvidenceField>;
  reason: string;
}

interface DiscoveryEvidenceField {
  requiresHumanVerification: true;
  identityReviewReasons: PdfFieldIdentityReviewReason[];
  page: number;
  rect: { x: number; y: number; width: number; height: number };
}

interface DiscoveryFallbackExperiment {
  cases: DiscoveryFallbackCase[];
}

interface WriteExperiment {
  values: Record<string, PdfFieldValue>;
}

interface FillPackageExperiment extends WriteExperiment {
  createdAt: string;
}

interface XfaExperiment {
  exactSomMatchCount: number;
  speakFieldCount: number;
  captionFieldCount: number;
  staticChoiceMappedGroupCount: number;
  staticChoiceLabelGainCount: number;
  staticChoiceGoldens?: {
    fieldName: string;
    choices: {
      value: string;
      label: string;
      labelSource: 'xfa_static_exact_som';
    }[];
  }[];
}

interface SemanticLabelGolden {
  fieldName: string;
  finalLabel: string;
  labelSource: PdfFieldLabelSource;
  query: string;
  expectedMatchCount: 1;
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
  xfaExperiment?: XfaExperiment;
  semanticLabelGoldens?: SemanticLabelGolden[];
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

interface DiscoveryAliasLeakProbe {
  distinguishableTexts: readonly string[];
  trustedMetadataCollisionTexts: readonly string[];
}

interface DiscoveryAliasLeakAssessment {
  structuralAliasDataExposed: false;
  distinguishableTextCount: number;
  distinguishableTextLeakDetected: false;
  trustedMetadataCollisionTextCount: number;
  trustedMetadataCollisionTextAssessment:
    | 'not_applicable'
    | 'indeterminate_trusted_metadata_paths_only';
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
  firstPageQueryMatchBases: QueryMatchBasis[] | null;
  firstPageAmbiguousQueries: boolean[] | null;
  firstPageDiscoveryFallback: string | null;
  firstPageMatchMethod: string | null;
  humanVerificationFieldNames: string[];
  discoveryMatchedFieldNames: string[];
  maxResponseUtf8Bytes: number;
  responseBudgetBytes: number;
  responseBudgetRespected: true;
  discoveryAliasLeakAssessment: DiscoveryAliasLeakAssessment;
}

interface EvidenceMeasurement {
  calls: number;
  initialBatchFieldCount: number;
  narrowerRetryCount: number;
  requestedBatchSizes: number[];
  returnedBatchSizes: number[];
  inputUtf8Bytes: number;
  outputUtf8Bytes: number;
  totalUtf8Bytes: number;
  approximateTokenProxy: number;
  maxResponseUtf8Bytes: number;
  responseBudgetBytes: number;
  responseBudgetRespected: true;
  discoveryAliasLeakAssessment: DiscoveryAliasLeakAssessment;
  fields: Record<string, DiscoveryEvidenceField>;
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

function requireQueryIndexSet(
  value: unknown,
  queryCount: number,
  label: string,
): Set<number> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} is not an array.`);
  }
  const indexes = value.map((index) => {
    if (
      !Number.isSafeInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= queryCount
    ) {
      throw new TypeError(`${label} contains an invalid query index.`);
    }
    return index as number;
  });
  if (new Set(indexes).size !== indexes.length) {
    throw new TypeError(`${label} repeats a query index.`);
  }
  return new Set(indexes);
}

function assertDiscoveryAliasTextNotLeaked(
  value: unknown,
  probe: DiscoveryAliasLeakProbe,
  queries: readonly string[],
  path = '$response',
): void {
  if (typeof value === 'string') {
    const reflectedQuery =
      path.endsWith('.query') || /\.matchedQueries\[\d+\]$/u.test(path);
    for (const alias of probe.distinguishableTexts) {
      if (!value.includes(alias)) continue;
      if (!(queries.includes(alias) && reflectedQuery)) {
        throw new TypeError(
          `Distinguishable discovery alias text leaked outside an explicit query reflection at ${path}`,
        );
      }
    }
    for (const alias of probe.trustedMetadataCollisionTexts) {
      if (!value.includes(alias)) continue;
      const trustedMetadataPath =
        path.endsWith('.name') ||
        path.endsWith('.label') ||
        path.endsWith('.tooltip');
      if (
        !trustedMetadataPath &&
        !(queries.includes(alias) && reflectedQuery)
      ) {
        throw new TypeError(
          `Trusted-metadata collision text appeared outside a trusted metadata or query path at ${path}`,
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertDiscoveryAliasTextNotLeaked(
        child,
        probe,
        queries,
        `${path}[${index}]`,
      ),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'discoveryAliases' || key === 'discoverySpeak') {
      throw new TypeError(`Internal discovery alias data leaked at ${path}`);
    }
    assertDiscoveryAliasTextNotLeaked(child, probe, queries, `${path}.${key}`);
  }
}

function discoveryAliasLeakAssessment(
  probe: DiscoveryAliasLeakProbe,
): DiscoveryAliasLeakAssessment {
  return {
    structuralAliasDataExposed: false,
    distinguishableTextCount: probe.distinguishableTexts.length,
    distinguishableTextLeakDetected: false,
    trustedMetadataCollisionTextCount:
      probe.trustedMetadataCollisionTexts.length,
    trustedMetadataCollisionTextAssessment:
      probe.trustedMetadataCollisionTexts.length === 0
        ? 'not_applicable'
        : 'indeterminate_trusted_metadata_paths_only',
  };
}

function createBenchmarkTools(
  state: FormState,
  inspection: PdfInspection,
): {
  contextTool: WebMcpToolDefinition;
  evidenceTool: WebMcpToolDefinition;
} {
  const adapter: FormProofWebMcpAdapter = {
    getFormContext(input) {
      const parsed =
        input.cursor === undefined
          ? ({ ok: true, offset: 0 } as const)
          : parseFormContextCursor(
              input.cursor,
              {
                documentSessionId: state.documentSessionId,
                sourceHash: state.source.sourceHash,
                stateVersion: state.stateVersion,
              },
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
    getFieldEvidence(input) {
      if (
        input.expectedStateVersion !== state.stateVersion ||
        input.expectedDocumentSessionId !== state.documentSessionId ||
        input.expectedSourceHash !== state.source.sourceHash
      ) {
        throw new TypeError('The benchmark evidence request lost its binding.');
      }
      return {
        ok: true,
        stateVersion: state.stateVersion,
        sourceHash: state.source.sourceHash,
        documentSessionId: state.documentSessionId,
        data: createFieldEvidenceToolData(state, inspection, input.fieldNames),
      };
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
  const tools = createFormProofToolDefinitions(
    adapter,
    () => undefined,
    new AbortController().signal,
  );
  const contextTool = tools.find(({ name }) => name === 'get_form_context');
  const evidenceTool = tools.find(({ name }) => name === 'get_field_evidence');
  if (contextTool === undefined || evidenceTool === undefined) {
    throw new TypeError('The benchmark WebMCP tools are not registered.');
  }
  return { contextTool, evidenceTool };
}

async function measureContext(
  tool: WebMcpToolDefinition,
  scope: FormContextScope,
  stopAfterFirstPage: boolean,
  aliasLeakProbe: DiscoveryAliasLeakProbe = {
    distinguishableTexts: [],
    trustedMetadataCollisionTexts: [],
  },
): Promise<ContextMeasurement> {
  let cursor: string | undefined;
  let calls = 0;
  let inputUtf8Bytes = 0;
  let outputUtf8Bytes = 0;
  let maxResponseUtf8Bytes = 0;
  const fieldNames: string[] = [];
  const humanVerificationFieldNames: string[] = [];
  const discoveryMatchedFieldNames: string[] = [];
  let firstPageFieldNames: string[] = [];
  let firstPageQueryMatchCounts: number[] | null = null;
  let firstPageQueryMatchBases: QueryMatchBasis[] | null = null;
  let firstPageAmbiguousQueries: boolean[] | null = null;
  let firstPageDiscoveryFallback: string | null = null;
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
    const responseUtf8Bytes = utf8Bytes(response);
    if (responseUtf8Bytes > FORMPROOF_RECOMMENDED_RESPONSE_BYTES) {
      throw new TypeError(
        `get_form_context used ${responseUtf8Bytes} bytes (budget ${FORMPROOF_RECOMMENDED_RESPONSE_BYTES})`,
      );
    }
    assertDiscoveryAliasTextNotLeaked(
      response,
      aliasLeakProbe,
      scope.queries ?? [],
    );
    outputUtf8Bytes += responseUtf8Bytes;
    maxResponseUtf8Bytes = Math.max(maxResponseUtf8Bytes, responseUtf8Bytes);
    calls += 1;
    if (!response.ok) {
      throw new TypeError(
        `get_form_context failed during measurement: ${response.error.code}`,
      );
    }
    const data = requireRecord(response.data, 'Context data is not an object.');
    if (hasKeyDeep(data, new Set(['currentValue', 'stagedValue']))) {
      throw new TypeError('Context exposed a raw current or staged value.');
    }
    assertEqual(
      data.valuesAvailableVia,
      'get_field_evidence',
      'Context lost the exact-value retrieval protocol',
    );
    if (!Array.isArray(data.fields)) {
      throw new TypeError('Context data does not contain fields.');
    }
    const pageFieldNames = data.fields.map((value, index) => {
      const field = requireRecord(value, `Context field ${index} is invalid.`);
      const name = requireString(
        field.name,
        `Context field ${index} has no name.`,
      );
      if (field.requiresHumanVerification === true) {
        humanVerificationFieldNames.push(name);
        if (Array.isArray(field.identityReviewReasons)) {
          field.identityReviewReasons.forEach((reason) => {
            if (
              reason !== 'xfa_disabled_speak' &&
              reason !== 'standard_initialism'
            ) {
              throw new TypeError(
                `Context field ${index} has an unknown identity-review reason.`,
              );
            }
          });
        }
      }
      if (
        field.matchBasis === 'discovery_alias' ||
        field.matchBasis === 'mixed'
      ) {
        discoveryMatchedFieldNames.push(name);
      }
      return name;
    });
    if (calls === 1) {
      firstPageFieldNames = pageFieldNames;
      if (scope.queries !== undefined) {
        const search = requireRecord(
          data.search,
          'Query context search metadata is not an object.',
        );
        firstPageMatchMethod = requireString(
          search.matchMethod,
          'Query context search metadata has no match method.',
        );
        firstPageDiscoveryFallback =
          typeof search.discoveryFallback === 'string'
            ? search.discoveryFallback
            : null;
        if (Array.isArray(search.queries)) {
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
          firstPageQueryMatchBases = search.queries.map((value, index) => {
            const query = requireRecord(
              value,
              `Query context search result ${index} is invalid.`,
            );
            if (query.unmatched === true) return 'unmatched';
            return query.matchBasis === 'discovery_alias'
              ? 'discovery_alias'
              : 'field_metadata';
          });
          firstPageAmbiguousQueries = search.queries.map((value, index) => {
            const query = requireRecord(
              value,
              `Query context search result ${index} is invalid.`,
            );
            return query.ambiguous === true;
          });
        } else {
          if (!Array.isArray(search.queryMatchCounts)) {
            throw new TypeError(
              'Compact query context has no per-query match counts.',
            );
          }
          firstPageQueryMatchCounts = search.queryMatchCounts.map(
            (count, index) => {
              if (!Number.isSafeInteger(count) || (count as number) < 0) {
                throw new TypeError(
                  `Compact query result ${index} has an invalid match count.`,
                );
              }
              return count as number;
            },
          );
          if (firstPageQueryMatchCounts.length !== scope.queries.length) {
            throw new TypeError('Compact query result count changed.');
          }
          const unmatchedQueryIndexes = requireQueryIndexSet(
            search.unmatchedQueryIndexes,
            firstPageQueryMatchCounts.length,
            'Compact unmatchedQueryIndexes',
          );
          const ambiguousQueryIndexes = requireQueryIndexSet(
            search.ambiguousQueryIndexes,
            firstPageQueryMatchCounts.length,
            'Compact ambiguousQueryIndexes',
          );
          const queryMatchBases = Array.isArray(search.queryMatchBases)
            ? search.queryMatchBases
            : [];
          for (const index of ambiguousQueryIndexes) {
            if (firstPageQueryMatchCounts[index] <= 1) {
              throw new TypeError(
                'Compact ambiguous query does not have multiple matches.',
              );
            }
          }
          if (
            queryMatchBases.length !== firstPageQueryMatchCounts.length ||
            queryMatchBases.some(
              (basis) =>
                basis !== 'field_metadata' &&
                basis !== 'discovery_alias' &&
                basis !== 'unmatched',
            )
          ) {
            throw new TypeError('Compact query match bases are invalid.');
          }
          firstPageQueryMatchCounts.forEach((count, index) => {
            const unmatched = unmatchedQueryIndexes.has(index);
            if (
              (count === 0) !== unmatched ||
              (count === 0) !== (queryMatchBases[index] === 'unmatched')
            ) {
              throw new TypeError(
                'Compact unmatched query count, index, and basis diverged.',
              );
            }
          });
          firstPageQueryMatchBases = queryMatchBases as QueryMatchBasis[];
          firstPageAmbiguousQueries = firstPageQueryMatchCounts.map(
            (_count, index) => ambiguousQueryIndexes.has(index),
          );
        }
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
    firstPageQueryMatchBases,
    firstPageAmbiguousQueries,
    firstPageDiscoveryFallback,
    firstPageMatchMethod,
    humanVerificationFieldNames: [...new Set(humanVerificationFieldNames)],
    discoveryMatchedFieldNames: [...new Set(discoveryMatchedFieldNames)],
    maxResponseUtf8Bytes,
    responseBudgetBytes: FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    responseBudgetRespected: true,
    discoveryAliasLeakAssessment: discoveryAliasLeakAssessment(aliasLeakProbe),
  };
}

async function measureFieldEvidence(
  state: FormState,
  tool: WebMcpToolDefinition,
  fieldNames: readonly string[],
  aliasLeakProbe: DiscoveryAliasLeakProbe,
): Promise<EvidenceMeasurement> {
  if (new Set(fieldNames).size !== fieldNames.length) {
    throw new TypeError('Evidence measurement repeats a requested field.');
  }
  let calls = 0;
  let narrowerRetryCount = 0;
  let inputUtf8Bytes = 0;
  let outputUtf8Bytes = 0;
  let maxResponseUtf8Bytes = 0;
  const requestedBatchSizes: number[] = [];
  const returnedBatchSizes: number[] = [];
  const fields: Record<string, DiscoveryEvidenceField> = {};
  const pendingFieldNames = [...fieldNames];

  while (pendingFieldNames.length > 0) {
    const requestedFieldNames = pendingFieldNames.slice(0, 3);
    const input = {
      expectedDocumentSessionId: state.documentSessionId,
      expectedStateVersion: state.stateVersion,
      expectedSourceHash: state.source.sourceHash,
      fieldNames: requestedFieldNames,
    };
    requestedBatchSizes.push(requestedFieldNames.length);
    inputUtf8Bytes += utf8Bytes(input);
    const response: FormProofToolResponse = await tool.execute(input);
    calls += 1;
    const responseUtf8Bytes = utf8Bytes(response);
    if (responseUtf8Bytes > FORMPROOF_RECOMMENDED_RESPONSE_BYTES) {
      throw new TypeError(
        `get_field_evidence used ${responseUtf8Bytes} bytes (budget ${FORMPROOF_RECOMMENDED_RESPONSE_BYTES})`,
      );
    }
    assertDiscoveryAliasTextNotLeaked(response, aliasLeakProbe, []);
    outputUtf8Bytes += responseUtf8Bytes;
    maxResponseUtf8Bytes = Math.max(maxResponseUtf8Bytes, responseUtf8Bytes);
    if (!response.ok) {
      throw new TypeError(
        `get_field_evidence failed during measurement: ${response.error.code}`,
      );
    }
    const data = requireRecord(
      response.data,
      'Evidence data is not an object.',
    );
    if (!Array.isArray(data.fields) || data.fields.length === 0) {
      throw new TypeError('Evidence did not return a whole requested field.');
    }
    if (data.fields.length > requestedFieldNames.length) {
      throw new TypeError('Evidence returned more fields than requested.');
    }
    const returnedFieldNames = data.fields.map((value, index) => {
      const field = requireRecord(value, `Evidence field ${index} is invalid.`);
      return requireString(
        field.name,
        `Evidence field ${index} has no exact name.`,
      );
    });
    assertEqual(
      returnedFieldNames,
      requestedFieldNames.slice(0, returnedFieldNames.length),
      'Evidence atomic projection changed field order',
    );
    returnedBatchSizes.push(returnedFieldNames.length);
    const omittedFieldCount =
      requestedFieldNames.length - returnedFieldNames.length;
    if (omittedFieldCount > 0) {
      assertEqual(
        {
          outputTruncated: response.outputTruncated,
          nextAction: response.nextAction,
          omittedFieldCount: data.omittedFieldCount,
        },
        {
          outputTruncated: true,
          nextAction: 'retry_with_narrower_scope',
          omittedFieldCount,
        },
        'Evidence omitted fields without an explicit narrower retry',
      );
      narrowerRetryCount += 1;
    } else if (Object.hasOwn(data, 'omittedFieldCount')) {
      throw new TypeError(
        'Evidence reported an omitted field that was returned.',
      );
    }

    for (const [index, value] of data.fields.entries()) {
      const field = requireRecord(value, `Evidence field ${index} is invalid.`);
      const fieldName = returnedFieldNames[index];
      if (field.requiresHumanVerification !== true) {
        throw new TypeError(`Evidence lost identity review: ${fieldName}`);
      }
      if (!Array.isArray(field.identityReviewReasons)) {
        throw new TypeError(
          `Evidence has no identity-review reasons: ${fieldName}`,
        );
      }
      const identityReviewReasons = field.identityReviewReasons.map(
        (reason) => {
          if (
            reason !== 'xfa_disabled_speak' &&
            reason !== 'standard_initialism'
          ) {
            throw new TypeError(
              `Evidence has an unknown identity-review reason.`,
            );
          }
          return reason;
        },
      );
      if (!Number.isSafeInteger(field.page) || (field.page as number) <= 0) {
        throw new TypeError(`Evidence has no usable page: ${fieldName}`);
      }
      const rect = requireRecord(
        field.rect,
        `Evidence has no rectangle: ${fieldName}`,
      );
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        if (
          typeof rect[coordinate] !== 'number' ||
          !Number.isFinite(rect[coordinate])
        ) {
          throw new TypeError(`Evidence rectangle is invalid: ${fieldName}`);
        }
      }
      fields[fieldName] = {
        requiresHumanVerification: true,
        identityReviewReasons,
        page: field.page as number,
        rect: {
          x: rect.x as number,
          y: rect.y as number,
          width: rect.width as number,
          height: rect.height as number,
        },
      };
    }
    pendingFieldNames.splice(0, returnedFieldNames.length);
    if (calls > fieldNames.length) {
      throw new TypeError('Evidence narrower retries made no progress.');
    }
  }

  assertEqual(
    Object.keys(fields),
    fieldNames,
    'Evidence did not cover the complete candidate set',
  );
  const totalUtf8Bytes = inputUtf8Bytes + outputUtf8Bytes;
  return {
    calls,
    initialBatchFieldCount: Math.min(fieldNames.length, 3),
    narrowerRetryCount,
    requestedBatchSizes,
    returnedBatchSizes,
    inputUtf8Bytes,
    outputUtf8Bytes,
    totalUtf8Bytes,
    approximateTokenProxy: approximateTokens(totalUtf8Bytes),
    maxResponseUtf8Bytes,
    responseBudgetBytes: FORMPROOF_RECOMMENDED_RESPONSE_BYTES,
    responseBudgetRespected: true,
    discoveryAliasLeakAssessment: discoveryAliasLeakAssessment(aliasLeakProbe),
    fields,
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
    rawByteRangeNameCount: protection.evidence.rawByteRangeNameCount ?? 0,
    historicalByteRangeNameCount:
      protection.evidence.historicalByteRangeNameCount ?? 0,
    revisionMarkerCount: protection.evidence.revisionMarkerCount ?? 0,
    historyScanComplete: protection.evidence.historyScanComplete ?? false,
    historyScanIssues: protection.evidence.historyScanIssues ?? [],
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
  const semanticLabelSources = {
    acroformTooltip: 0,
    xfaSpeak: 0,
    xfaCaption: 0,
    fieldNameOnly: 0,
  };
  for (const field of inspection.fields) {
    const resolved = resolvePdfFieldLabel(field);
    assertEqual(
      state.fields[field.name]?.label,
      resolved.label,
      `UI label resolution changed: ${field.name}`,
    );
    if (resolved.source === 'acroform_tooltip') {
      semanticLabelSources.acroformTooltip += 1;
    } else if (resolved.source === 'xfa_speak') {
      semanticLabelSources.xfaSpeak += 1;
    } else if (resolved.source === 'xfa_caption') {
      semanticLabelSources.xfaCaption += 1;
    } else {
      semanticLabelSources.fieldNameOnly += 1;
    }
  }
  const semanticLabelAvailableCount =
    semanticLabelSources.acroformTooltip +
    semanticLabelSources.xfaSpeak +
    semanticLabelSources.xfaCaption;
  const discoveryAliases = inspection.fields.flatMap(
    ({ discoveryAliases: aliases = [] }) => aliases,
  );
  const discoveryAliasSources = {
    xfaDisabledSpeak: discoveryAliases.filter(
      ({ source }) => source === 'xfa_disabled_speak',
    ).length,
    standardInitialism: discoveryAliases.filter(
      ({ source }) => source === 'standard_initialism',
    ).length,
  };
  const trustedOutputTexts = inspection.fields.flatMap((field) => [
    field.name,
    resolvePdfFieldLabel(field).label,
    ...(field.tooltip === null ? [] : [field.tooltip]),
  ]);
  const discoveryAliasTrustedMetadataCollisionCount = discoveryAliases.filter(
    ({ value }) => trustedOutputTexts.some((text) => text.includes(value)),
  ).length;
  const discoveryAliasTrustedMetadataCollisionTextCount = new Set(
    discoveryAliases
      .filter(({ value }) =>
        trustedOutputTexts.some((text) => text.includes(value)),
      )
      .map(({ value }) => value),
  ).size;
  return {
    meaningfulTooltipCount,
    semanticLabelAvailableCount,
    semanticLabelUnavailableCount:
      inspection.fieldCount - semanticLabelAvailableCount,
    semanticLabelCoveragePercent: Number(
      ((semanticLabelAvailableCount / inspection.fieldCount) * 100).toFixed(2),
    ),
    semanticLabelSources,
    xfaExactSomMatchCount: inspection.fields.filter(
      ({ xfaSomNameMatched }) => xfaSomNameMatched === true,
    ).length,
    xfaSpeakFieldCount: inspection.fields.filter(
      ({ xfaSpeak }) => xfaSpeak !== null && xfaSpeak !== undefined,
    ).length,
    xfaCaptionFieldCount: inspection.fields.filter(
      ({ xfaCaption }) => xfaCaption !== null && xfaCaption !== undefined,
    ).length,
    staticXfaChoiceMappedGroupCount: inspection.fields.filter(({ choices }) =>
      choices.some(({ labelSource }) => labelSource === 'xfa_static_exact_som'),
    ).length,
    staticXfaChoiceLabelGainCount: inspection.fields.reduce(
      (count, { choices }) =>
        count +
        choices.filter(
          ({ value, label, labelSource }) =>
            labelSource === 'xfa_static_exact_som' && label !== value,
        ).length,
      0,
    ),
    discoveryAliasFieldCount: inspection.fields.filter(
      ({ discoveryAliases: aliases }) => (aliases?.length ?? 0) > 0,
    ).length,
    discoveryAliasCount: discoveryAliases.length,
    discoveryAliasSources,
    discoveryAliasTrust: 'candidate_discovery_only',
    discoveryAliasLeakAssessment: {
      structuralAliasDataExposed: false,
      distinguishableAliasObjectCount:
        discoveryAliases.length - discoveryAliasTrustedMetadataCollisionCount,
      distinguishableTextLeakDetected: false,
      trustedMetadataCollisionObjectCount:
        discoveryAliasTrustedMetadataCollisionCount,
      trustedMetadataCollisionTextCount:
        discoveryAliasTrustedMetadataCollisionTextCount,
      trustedMetadataCollisionTextAssessment:
        discoveryAliasTrustedMetadataCollisionTextCount === 0
          ? 'not_applicable'
          : 'indeterminate_trusted_metadata_paths_only',
    },
    discoveryAliasLimitation:
      discoveryAliases.length === 0
        ? null
        : 'Discovery aliases can recover candidates only when no trusted field metadata matches the same query. They never become labels or evidence, and affected fields require human identity verification before export.',
    xfaFallbackOnly: inspection.protection.evidence.xfaPresent,
    xfaSemanticLimitation: inspection.protection.evidence.xfaPresent
      ? 'AcroForm /TU remains authoritative for field labels, and AcroForm values, widget mappings, and appearance states remain authoritative for choices. Only bounded static exclGroup captions matched by exact full SOM name and a complete byte-for-byte AcroForm value set may label choices. XFA scripts, calculations, validation, dynamic choices, and dynamic layout were not executed, and PDF rewriting remains disabled.'
      : null,
  };
}

async function measureSemanticLabelGoldens(
  documentId: string,
  state: FormState,
  inspection: PdfInspection,
  contextTool: WebMcpToolDefinition,
  goldens: readonly SemanticLabelGolden[],
  aliasLeakProbe: DiscoveryAliasLeakProbe,
) {
  const measurements: Array<
    Omit<SemanticLabelGolden, 'expectedMatchCount'> & {
      queryMatchCount: 1;
      exactFieldMatch: true;
      verified: true;
    }
  > = [];

  for (const golden of goldens) {
    assertEqual(
      golden.expectedMatchCount,
      1,
      `${documentId} semantic-label golden must require exactly one query match: ${golden.fieldName}`,
    );
    const field = inspection.fields.find(
      ({ name }) => name === golden.fieldName,
    );
    if (field === undefined) {
      throw new TypeError(
        `${documentId} semantic-label golden field disappeared: ${golden.fieldName}`,
      );
    }
    const resolved = resolvePdfFieldLabel(field);
    assertEqual(
      { finalLabel: resolved.label, labelSource: resolved.source },
      { finalLabel: golden.finalLabel, labelSource: golden.labelSource },
      `${documentId} semantic-label golden changed: ${golden.fieldName}`,
    );
    assertEqual(
      state.fields[golden.fieldName]?.label,
      golden.finalLabel,
      `${documentId} form-state label diverged from its golden: ${golden.fieldName}`,
    );

    const queryMeasurement = await measureContext(
      contextTool,
      { queries: [golden.query] },
      false,
      aliasLeakProbe,
    );
    assertEqual(
      queryMeasurement.firstPageMatchMethod,
      'lexical',
      `${documentId} semantic-label query method changed: ${golden.query}`,
    );
    assertEqual(
      queryMeasurement.firstPageQueryMatchCounts,
      [golden.expectedMatchCount],
      `${documentId} semantic-label query count changed: ${golden.query}`,
    );
    assertEqual(
      queryMeasurement.returnedFields,
      golden.expectedMatchCount,
      `${documentId} semantic-label query total changed: ${golden.query}`,
    );
    assertEqual(
      queryMeasurement.uniqueReturnedFields,
      golden.expectedMatchCount,
      `${documentId} semantic-label query repeated fields: ${golden.query}`,
    );
    assertEqual(
      queryMeasurement.firstPageFieldNames,
      [golden.fieldName],
      `${documentId} semantic-label query resolved the wrong field: ${golden.query}`,
    );

    const { expectedMatchCount: queryMatchCount, ...evidence } = golden;
    measurements.push({
      ...evidence,
      queryMatchCount,
      exactFieldMatch: true,
      verified: true,
    });
  }

  return measurements;
}

async function measureDiscoveryFallbackExperiment(
  documentId: string,
  state: FormState,
  contextTool: WebMcpToolDefinition,
  evidenceTool: WebMcpToolDefinition,
  experiment: DiscoveryFallbackExperiment | undefined,
  aliasLeakProbe: DiscoveryAliasLeakProbe,
) {
  if (experiment === undefined) return null;

  const names = new Set<string>();
  const cases = [];
  for (const candidate of experiment.cases) {
    if (names.has(candidate.name)) {
      throw new TypeError(
        `${documentId} repeats discovery fallback case ${candidate.name}`,
      );
    }
    names.add(candidate.name);
    assertEqual(
      Object.keys(candidate.expectedEvidenceByField),
      candidate.expectedHumanVerificationFieldNames,
      `${documentId} discovery evidence fields diverge from the review set: ${candidate.name}`,
    );
    const contextMeasurement = await measureContext(
      contextTool,
      { queries: candidate.queries },
      false,
      aliasLeakProbe,
    );
    assertEqual(
      contextMeasurement.firstPageFieldNames,
      candidate.expectedFirstPageFieldNames,
      `${documentId} discovery fallback representatives changed: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.firstPageQueryMatchCounts,
      candidate.expectedMatchCounts,
      `${documentId} discovery fallback counts changed: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.returnedFields,
      candidate.expectedTotalMatchedFields,
      `${documentId} discovery fallback total changed: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.uniqueReturnedFields,
      candidate.expectedTotalMatchedFields,
      `${documentId} discovery fallback repeated candidates: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.firstPageQueryMatchBases,
      candidate.expectedQueryMatchBases,
      `${documentId} discovery fallback trust basis changed: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.firstPageAmbiguousQueries,
      candidate.expectedAmbiguousQueries,
      `${documentId} discovery fallback ambiguity changed: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.firstPageDiscoveryFallback,
      candidate.expectedQueryMatchBases.includes('discovery_alias')
        ? 'only_when_no_field_metadata_match'
        : null,
      `${documentId} discovery fallback policy marker changed: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.humanVerificationFieldNames,
      candidate.expectedHumanVerificationFieldNames,
      `${documentId} discovery fallback human-verification set changed: ${candidate.name}`,
    );
    assertEqual(
      contextMeasurement.discoveryMatchedFieldNames,
      candidate.expectedQueryMatchBases.includes('discovery_alias')
        ? candidate.expectedHumanVerificationFieldNames
        : [],
      `${documentId} discovery fallback field basis changed: ${candidate.name}`,
    );
    const evidenceMeasurement = await measureFieldEvidence(
      state,
      evidenceTool,
      candidate.expectedHumanVerificationFieldNames,
      aliasLeakProbe,
    );
    assertEqual(
      evidenceMeasurement.fields,
      candidate.expectedEvidenceByField,
      `${documentId} discovery fallback evidence changed: ${candidate.name}`,
    );

    cases.push({
      name: candidate.name,
      verified: true,
      reason: candidate.reason,
      candidateSetComplete: true,
      agentSelectedField: false,
      contextMeasurement,
      evidenceMeasurement,
    });
  }

  return {
    verified: true,
    trustPolicy: 'trusted_metadata_globally_precedes_discovery_aliases',
    discoveryAliasLeakAssessment: discoveryAliasLeakAssessment(aliasLeakProbe),
    agentSelectedField: false,
    cases,
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
    result.verifiedFields.every(
      ({ normalAppearancePresent }) => normalAppearancePresent,
    ),
    true,
    'Round-trip normal appearance stream presence check failed',
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
    normalAppearanceStreamPresentFieldCount: result.verifiedFields.length,
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
  let staticXfaChoiceLabelSourceFieldCount = 0;
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
        ...(definition.identityReviewReasons === undefined
          ? {}
          : {
              identityReviewReasons: [...definition.identityReviewReasons],
            }),
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
    if (
      descriptor.choices.some(
        ({ labelSource }) => labelSource === 'xfa_static_exact_som',
      )
    ) {
      const roundTripped = (
        decoded as typeof exported.result.manifest
      ).plan.stagedFields.find((field) => field.fieldName === fieldName);
      assertEqual(
        roundTripped?.choices,
        descriptor.choices,
        `Fill-package static XFA choice provenance changed: ${fieldName}`,
      );
      staticXfaChoiceLabelSourceFieldCount += 1;
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
        'normalAppearancePresent',
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

  const freshState = await createFormState(
    {
      fileName: initialState.source.fileName,
      sourceHash: inspection.sourceHash,
      byteLength: source.byteLength,
      pageCount: inspection.pageCount,
    },
    inspection.fields.map(createFormFieldDefinitionFromPdf),
  );
  const imported = await importFillPackageFromUi(
    freshState,
    source,
    exported.result.bytes,
    inspection,
  );
  if (!imported.ok) {
    throw new TypeError(
      `Fill-package import failed: ${imported.errors.map(({ code }) => code).join(', ')}`,
    );
  }
  const importedFieldNames = Object.keys(experiment.values).sort();
  assertEqual(
    imported.receipt,
    {
      packageHash: exported.result.outputHash,
      sourceHash: inspection.sourceHash,
      recordedPlanHash: staged.state.planHash,
      restoredPlanHash: staged.state.planHash,
      sourceHashVerified: true,
      planHashVerified: true,
      authenticityVerified: false,
      packageDisplayMetadataUsed: false,
      sourcePdfModified: false,
      importedFieldNames,
    },
    'Fill-package import receipt changed',
  );
  assertEqual(
    imported.state.importedProposalFieldNames,
    importedFieldNames,
    'Fill-package imported-proposal markers changed',
  );
  assertEqual(
    {
      planHash: imported.state.planHash,
      approval: imported.state.approval,
      output: imported.state.output,
      verification: imported.state.verification,
    },
    {
      planHash: staged.state.planHash,
      approval: null,
      output: null,
      verification: null,
    },
    'Fill-package import restored authority or changed the plan binding',
  );
  for (const [fieldName, proposedValue] of Object.entries(experiment.values)) {
    assertEqual(
      {
        value: imported.state.draft[fieldName]?.value,
        provenance: imported.state.draft[fieldName]?.provenance,
        actor: imported.state.draft[fieldName]?.actor,
      },
      { value: proposedValue, provenance, actor: 'agent' },
      `Fill-package import changed actionable content: ${fieldName}`,
    );
  }
  const importedReviewFields = new Set(
    getArtifactReviewFieldNames(imported.state),
  );
  assertEqual(
    importedFieldNames.every((fieldName) =>
      importedReviewFields.has(fieldName),
    ),
    true,
    'Fill-package import skipped full field review',
  );
  const reexported = await exportFillPackageFromUi(
    imported.state,
    source,
    request,
  );
  if (!reexported.ok) {
    throw new TypeError(
      `Imported fill-package re-export failed: ${reexported.errors.map(({ code }) => code).join(', ')}`,
    );
  }
  assertEqual(
    [
      bytesEqual(reexported.result.bytes, exported.result.bytes),
      reexported.result.outputHash,
    ],
    [true, exported.result.outputHash],
    'Fill-package import/re-export round-trip changed the reviewed package',
  );
  assertEqual(
    [sha256(source), bytesEqual(source, sourceSnapshot)],
    [sourceHashBefore, true],
    'Fill-package import or re-export changed the original PDF bytes',
  );

  return {
    passed: true,
    artifactType: exported.result.manifest.artifactType,
    stagedFieldCount: Object.keys(experiment.values).length,
    confirmedFieldCount: confirmedFieldNames.length,
    humanStepCount: exported.result.manifest.plan.humanSteps.length,
    multiWidgetChoiceMappingsVerified,
    staticXfaChoiceLabelSourceFieldCount,
    staticXfaChoiceLabelSourceRoundTripPreserved:
      staticXfaChoiceLabelSourceFieldCount > 0 ? true : 'not_applicable',
    semanticLabelUnavailableStagedFieldCount:
      exported.result.manifest.plan.stagedFields.filter(
        ({ semanticLabelAvailable }) => !semanticLabelAvailable,
      ).length,
    jsonRoundTripVerified: exported.result.roundTripVerified,
    deterministicWithFixedCreatedAt: true,
    sourceHashBound: true,
    planHashBound: true,
    packageReimportVerified: true,
    packageReexportRoundTripIdentical: true,
    importedProposalTrust: 'untrusted_requires_full_human_review',
    packageCreatorAuthenticityVerified: false,
    packageDisplayMetadataUsed: false,
    approvalRestoredOnImport: false,
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
    inspection.contentRisk,
    expected.contentRisk,
    `${document.id} content-risk summary mismatch`,
  );
  assertEqual(
    protectionFacts(inspection),
    expected.protection,
    `${document.id} protection facts changed`,
  );
  const xfaMeasurements = {
    exactSomMatchCount: inspection.fields.filter(
      ({ xfaSomNameMatched }) => xfaSomNameMatched === true,
    ).length,
    speakFieldCount: inspection.fields.filter(
      ({ xfaSpeak }) => xfaSpeak !== null && xfaSpeak !== undefined,
    ).length,
    captionFieldCount: inspection.fields.filter(
      ({ xfaCaption }) => xfaCaption !== null && xfaCaption !== undefined,
    ).length,
    staticChoiceMappedGroupCount: inspection.fields.filter(({ choices }) =>
      choices.some(({ labelSource }) => labelSource === 'xfa_static_exact_som'),
    ).length,
    staticChoiceLabelGainCount: inspection.fields.reduce(
      (count, { choices }) =>
        count +
        choices.filter(
          ({ value, label, labelSource }) =>
            labelSource === 'xfa_static_exact_som' && label !== value,
        ).length,
      0,
    ),
  };
  if (document.xfaExperiment === undefined) {
    assertEqual(
      [
        inspection.protection.evidence.xfaPresent,
        ...Object.values(xfaMeasurements),
      ],
      [false, 0, 0, 0, 0, 0],
      `${document.id} unexpectedly exposed XFA semantics`,
    );
  } else {
    assertEqual(
      inspection.protection.evidence.xfaPresent,
      true,
      `${document.id} lost its XFA evidence`,
    );
    assertEqual(
      xfaMeasurements,
      {
        exactSomMatchCount: document.xfaExperiment.exactSomMatchCount,
        speakFieldCount: document.xfaExperiment.speakFieldCount,
        captionFieldCount: document.xfaExperiment.captionFieldCount,
        staticChoiceMappedGroupCount:
          document.xfaExperiment.staticChoiceMappedGroupCount,
        staticChoiceLabelGainCount:
          document.xfaExperiment.staticChoiceLabelGainCount,
      },
      `${document.id} bounded XFA mapping changed`,
    );
    assertEqual(
      [expected.artifactType, expected.expectedPdfRewriteError],
      ['original_untouched_fill_package', 'PDF_XFA_UNSUPPORTED'],
      `${document.id} must remain fill-package-only`,
    );
    assertEqual(
      inspection.protection.exportStrategies,
      ['fill_package'],
      `${document.id} XFA unexpectedly became PDF-rewriteable`,
    );
    for (const golden of document.xfaExperiment.staticChoiceGoldens ?? []) {
      const field = inspection.fields.find(
        ({ name }) => name === golden.fieldName,
      );
      if (field === undefined) {
        throw new TypeError(
          `${document.id} choice-label golden field disappeared: ${golden.fieldName}`,
        );
      }
      assertEqual(
        field.choices,
        golden.choices,
        `${document.id} bounded static XFA choice labels changed: ${golden.fieldName}`,
      );
      const expectedValues = golden.choices.map(({ value }) => value);
      assertEqual(
        field.options,
        expectedValues,
        `${document.id} static XFA golden no longer matches the complete AcroForm value set: ${golden.fieldName}`,
      );
      assertEqual(
        field.widgets.flatMap(({ choiceValue }) =>
          choiceValue === null ? [] : [choiceValue],
        ),
        expectedValues,
        `${document.id} static XFA golden no longer matches the complete widget value set: ${golden.fieldName}`,
      );
      assertEqual(
        golden.choices.every(
          ({ labelSource }) => labelSource === 'xfa_static_exact_som',
        ),
        true,
        `${document.id} static XFA golden lost its label provenance: ${golden.fieldName}`,
      );
    }
  }
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
  const allDiscoveryAliasTexts = [
    ...new Set(
      inspection.fields.flatMap(({ discoveryAliases: aliases = [] }) =>
        aliases.map(({ value }) => value),
      ),
    ),
  ];
  const trustedOutputTexts = inspection.fields.flatMap((field) => [
    field.name,
    resolvePdfFieldLabel(field).label,
    ...(field.tooltip === null ? [] : [field.tooltip]),
  ]);
  const trustedMetadataCollisionTexts = allDiscoveryAliasTexts.filter((alias) =>
    trustedOutputTexts.some((text) => text.includes(alias)),
  );
  const aliasLeakProbe: DiscoveryAliasLeakProbe = {
    distinguishableTexts: allDiscoveryAliasTexts.filter(
      (alias) => !trustedOutputTexts.some((text) => text.includes(alias)),
    ),
    trustedMetadataCollisionTexts,
  };
  const contextStateSnapshot = {
    stateVersion: state.stateVersion,
    planHash: state.planHash,
    draft: structuredClone(state.draft),
  };
  const { contextTool, evidenceTool } = createBenchmarkTools(state, inspection);
  const semanticLabelGoldens = await measureSemanticLabelGoldens(
    document.id,
    state,
    inspection,
    contextTool,
    document.semanticLabelGoldens ?? [],
    aliasLeakProbe,
  );
  const fullTraversal = await measureContext(
    contextTool,
    {},
    false,
    aliasLeakProbe,
  );
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
    aliasLeakProbe,
  );
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
  const allQueryMatches = await measureContext(
    contextTool,
    queryScope,
    false,
    aliasLeakProbe,
  );
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
  const discoveryFallbackExperiment = await measureDiscoveryFallbackExperiment(
    document.id,
    state,
    contextTool,
    evidenceTool,
    document.queryExperiment.discoveryFallbackExperiment,
    aliasLeakProbe,
  );
  assertEqual(
    {
      stateVersion: state.stateVersion,
      planHash: state.planHash,
      draft: state.draft,
    },
    contextStateSnapshot,
    `${document.id} read-only discovery changed the fill plan`,
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
      filledPdfAvailable:
        inspection.protection.exportStrategies.includes('filled_pdf'),
      originalUntouchedFillPackageAvailable:
        inspection.protection.exportStrategies.includes('fill_package'),
      pdfRewriteRejectedCode: expected.expectedPdfRewriteError ?? null,
    },
    safety: {
      highRiskNativeActionCount: inspection.activeContent.highRiskActionCount,
      pdfByteExportBlockedByContentRisk: inspection.contentRisk.blocksPdfExport,
      pdfJavaScriptExecuted: false,
      activeContent: inspection.activeContent,
      contentRisk: inspection.contentRisk,
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
      discoveryFallbackExperiment,
      ...semanticCoverage(state, inspection),
      semanticLabelGoldenCount: semanticLabelGoldens.length,
      semanticLabelGoldens,
      staticXfaChoiceGoldenCount:
        document.xfaExperiment?.staticChoiceGoldens?.length ?? 0,
      staticXfaChoiceGoldensVerified:
        (document.xfaExperiment?.staticChoiceGoldens?.length ?? 0) > 0
          ? true
          : 'not_measured',
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
