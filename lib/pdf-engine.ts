import {
  EncryptedPDFError,
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFForm,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFOptionList,
  PDFObject,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  StandardFonts,
} from 'pdf-lib';

import {
  fingerprintPdfSignatures,
  type PdfSignatureFingerprint,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from './pdf-signature-history.ts';
import {
  BoundedZlibDecodeLimitError,
  decodeBoundedZlib,
  extractXfaSemantics,
  type XfaFieldSemantics,
  type XfaSemanticsResult,
  // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
} from './xfa-semantics.ts';
// @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
import { formatCount } from './utils.ts';

export const PDF_ENGINE_SUPPORT = {
  formType: 'AcroForm',
  preservesInteractiveFields: true,
  unsupported: [
    'encrypted PDFs',
    'PDF mutation when XFA is present',
    'PDF mutation when document signatures or certification are present',
    'unknown PDF protection structures',
    'signature writing',
    'characters outside the built-in WinAnsi appearance font',
  ],
} as const;

export type PdfFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'option_list'
  | 'signature'
  | 'unsupported';

export type PdfFieldValue = string | boolean | string[] | null;

export type PdfEngineErrorCode =
  | 'CRYPTO_UNAVAILABLE'
  | 'PDF_ENCRYPTED'
  | 'PDF_LOAD_FAILED'
  | 'PDF_RESOURCE_LIMIT_EXCEEDED'
  | 'PDF_XFA_UNSUPPORTED'
  | 'PDF_SIGNED_UNSUPPORTED'
  | 'PDF_CERTIFIED_UNSUPPORTED'
  | 'PDF_UNKNOWN_PROTECTION_UNSUPPORTED'
  | 'PDF_DERIVATIVE_CONFIRMATION_REQUIRED'
  | 'PDF_HIGH_RISK_ACTION_UNSUPPORTED'
  | 'FIELD_NOT_FOUND'
  | 'FIELD_READ_ONLY'
  | 'FIELD_HUMAN_ONLY'
  | 'FIELD_SIGNATURE_UNSUPPORTED'
  | 'FIELD_TYPE_UNSUPPORTED'
  | 'FIELD_VALUE_TYPE_INVALID'
  | 'FIELD_OPTION_INVALID'
  | 'FIELD_VALUE_TOO_LONG'
  | 'FIELD_GLYPH_UNSUPPORTED'
  | 'PDF_APPLY_FAILED'
  | 'PDF_VERIFY_FIELD_MISSING'
  | 'PDF_VERIFY_VALUE_MISMATCH'
  | 'PDF_VERIFY_WIDGET_MISSING'
  | 'PDF_VERIFY_WIDGET_PAGE_MISSING'
  | 'PDF_VERIFY_APPEARANCE_MISSING'
  | 'PDF_VERIFY_WIDGET_VALUE_MISMATCH'
  | 'PDF_VERIFY_PROTECTION_MISMATCH';

export type PdfEngineWarningCode =
  | 'NO_ACROFORM_FIELDS'
  | 'SIGNATURE_FIELD_HUMAN_ONLY'
  | 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY'
  | 'UNSUPPORTED_FIELD_TYPE'
  | 'WIDGET_PAGE_UNKNOWN'
  | 'APPEARANCE_UNAVAILABLE'
  | 'JAVASCRIPT_UNVALIDATED'
  | 'ACTIVE_CONTENT_PRESERVED'
  | 'PDF_EXPORT_BLOCKED_BY_CONTENT'
  | 'USAGE_RIGHTS_DETECTED'
  | 'XFA_PRESENT_INSPECTION_ONLY'
  | 'XFA_SEMANTICS_UNAVAILABLE'
  | 'DOCUMENT_SIGNATURE_PROTECTED'
  | 'DOC_MDP_PROTECTED'
  | 'UNKNOWN_PROTECTION';

export type PdfProtectionType =
  | 'none'
  | 'usage_rights'
  | 'document_signature'
  | 'doc_mdp'
  | 'unknown';

export type PdfAllowedMutation =
  | 'inspect_fields'
  | 'stage_field_values'
  | 'create_filled_pdf'
  | 'create_plain_derivative_pdf'
  | 'create_fill_package';

export type PdfExportStrategy =
  | 'filled_pdf'
  | 'confirmed_plain_derivative_pdf'
  | 'fill_package';

export type PdfSignatureImpact =
  | 'none'
  | 'usage_rights_removed_in_plain_derivative'
  | 'rewrite_would_invalidate_usage_rights'
  | 'rewrite_blocked_to_preserve_document_signature'
  | 'rewrite_blocked_to_preserve_certification'
  | 'rewrite_blocked_for_unknown_protection';

export interface PdfProtectionEvidence {
  readonly catalogPermsPresent: boolean;
  readonly permsKeys: readonly string[];
  readonly usageRightsKeys: readonly ('UR' | 'UR3')[];
  readonly byteRangeEntryCount: number;
  readonly rawByteRangeNameCount?: number;
  readonly historicalByteRangeNameCount?: number;
  readonly revisionMarkerCount?: number;
  readonly historyScanComplete?: boolean;
  readonly historyScanIssues?: readonly string[];
  readonly malformedByteRangeCount: number;
  readonly byteRanges: readonly (readonly [number, number, number, number])[];
  readonly byteRangesCoverWholeFile: boolean | null;
  readonly signatureDictionaryCount: number;
  readonly usageRightsSignatureCount: number;
  readonly documentSignatureCount: number;
  readonly unclassifiedSignatureDictionaryCount: number;
  readonly unreachableSignatureDictionaryCount: number;
  readonly signatureFieldCount: number;
  readonly signedSignatureFieldCount: number;
  readonly docMdpPresent: boolean;
  readonly docMdpSignatureDictionaryCount: number;
  readonly docMdpPermission: 1 | 2 | 3 | null;
  readonly fieldMdpPresent: boolean;
  readonly adbeExtension: {
    readonly baseVersion: string | null;
    readonly extensionLevel: number | null;
  } | null;
  readonly xfaPresent: boolean;
  readonly sigFlags: number | null;
  readonly unknownStructures: readonly string[];
  readonly cmsIntegrity: 'not_applicable' | 'not_verified_in_browser';
  readonly signerTrust: 'not_applicable' | 'not_verified';
}

export interface PdfProtectionReport {
  readonly protectionType: PdfProtectionType;
  readonly allowedMutations: readonly PdfAllowedMutation[];
  readonly exportStrategies: readonly PdfExportStrategy[];
  readonly signatureImpact: PdfSignatureImpact;
  readonly requiresHumanConfirmation: boolean;
  readonly evidence: Readonly<PdfProtectionEvidence>;
}

export interface PdfActiveContentSummary {
  javascriptActionCount: number;
  additionalActionDictionaryCount: number;
  openActionCount: number;
  externalActionCount: number;
  highRiskActionCount: number;
  otherActionCount: number;
}

export type PdfContentRiskReasonCode =
  | 'javascript_present'
  | 'external_link_present'
  | 'dangerous_or_unknown_action_present'
  | 'embedded_file_present'
  | 'associated_file_present'
  | 'file_attachment_present'
  | 'rich_media_present'
  | 'multimedia_present'
  | 'unclassified_payload_entry';

export type PdfActionTriggerKind =
  | 'open_action'
  | 'additional_action'
  | 'direct_action'
  | 'javascript_name_tree';

export interface PdfContentRiskReason {
  readonly code: PdfContentRiskReasonCode;
  readonly count: number;
}

export interface PdfPayloadSummary {
  readonly embeddedFileCount: number;
  readonly associatedFileCount: number;
  readonly fileAttachmentAnnotationCount: number;
  readonly richMediaAnnotationCount: number;
  readonly multimediaAnnotationCount: number;
  readonly malformedPayloadEntryCount: number;
}

export interface PdfContentRisk {
  readonly blocksPdfExport: boolean;
  readonly blocksInteractivePreview: boolean;
  readonly reasons: readonly PdfContentRiskReason[];
  readonly actionTriggerCounts: Readonly<Record<PdfActionTriggerKind, number>>;
  readonly payloadSummary: Readonly<PdfPayloadSummary>;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfWidgetDescriptor {
  page: number | null;
  rect: PdfRect;
  hasAppearance: boolean;
  appearanceState: string | null;
  choiceValue: string | null;
}

export interface PdfChoiceDescriptor {
  value: string;
  label: string;
  labelSource: 'acroform' | 'xfa_static_exact_som';
}

export type PdfFieldIdentityReviewReason =
  | 'xfa_disabled_speak'
  | 'standard_initialism';

export interface PdfFieldDiscoveryAlias {
  readonly value: string;
  readonly source: PdfFieldIdentityReviewReason;
}

export interface PdfFieldDescriptor {
  name: string;
  type: PdfFieldType;
  current: PdfFieldValue;
  options: string[];
  choices: PdfChoiceDescriptor[];
  multiSelect: boolean;
  multiline?: boolean;
  required: boolean;
  readOnly: boolean;
  humanOnly: boolean;
  page: number | null;
  rect: PdfRect | null;
  maxLength: number | null;
  tooltip: string | null;
  xfaSomNameMatched?: boolean;
  xfaSignatureWidget?: boolean;
  xfaSpeak?: string | null;
  xfaCaption?: string | null;
  discoveryAliases?: readonly PdfFieldDiscoveryAlias[];
  widgetCount: number;
  widgets: PdfWidgetDescriptor[];
}

export interface PdfEngineWarning {
  code: PdfEngineWarningCode;
  message: string;
  fieldName?: string;
}

export interface PdfInspection {
  sourceHash: string;
  pageCount: number;
  fieldCount: number;
  widgetCount: number;
  activeContent: PdfActiveContentSummary;
  contentRisk: PdfContentRisk;
  protection: PdfProtectionReport;
  fields: PdfFieldDescriptor[];
  warnings: PdfEngineWarning[];
}

export interface VerifiedPdfField {
  name: string;
  type: PdfFieldType;
  value: PdfFieldValue;
  widgetCount: number;
  normalAppearancePresent: boolean;
}

export interface ApplyResult {
  bytes: Uint8Array;
  sourceHash: string;
  outputHash: string;
  fieldCount: number;
  widgetCount: number;
  activeContent: PdfActiveContentSummary;
  contentRisk: PdfContentRisk;
  exportStrategy: 'filled_pdf' | 'confirmed_plain_derivative_pdf';
  sourceProtection: PdfProtectionReport;
  outputProtection: PdfProtectionReport;
  verifiedFields: VerifiedPdfField[];
  warnings: PdfEngineWarning[];
}

export class PdfEngineError extends Error {
  readonly code: PdfEngineErrorCode;
  readonly fieldName?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: PdfEngineErrorCode,
    message: string,
    options: {
      fieldName?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'PdfEngineError';
    this.code = code;
    this.fieldName = options.fieldName;
    this.details = options.details;

    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
      });
    }
  }
}

interface LoadedPdf {
  document: PDFDocument;
  form: ReturnType<PDFDocument['getForm']>;
  activeContent: PdfActiveContentSummary;
  contentRisk: PdfContentRisk;
  protectionAnalysis: PdfProtectionAnalysis;
  xfaSemantics: XfaSemanticsResult;
}

interface PdfProtectionAnalysis {
  protectionType: PdfProtectionType;
  evidence: PdfProtectionEvidence;
  usageRightsRefs: PDFRef[];
  permsRef: PDFRef | null;
}

const HUMAN_ONLY_MARKER = /\[\s*HUMAN[_ -]?ONLY\s*\]/i;
const HUMAN_ONLY_MARKER_GLOBAL = /\[\s*HUMAN[_ -]?ONLY\s*\]/gi;
const MAX_SEMANTIC_FIELD_LABEL_LENGTH = 180;
const EXPLICIT_SIGNATURE_FIELD =
  /(?:^|[\s.,;:])signature\s+of(?:\s|$)|\benter\s+(?:the\s+)?signature(?!\s+date\b)(?:\s|[:.]|$)|\bcannot\s+be\s+signed\s+electronically\b|\bprint\s+and\s+sign\s+in\s+ink\b/i;
const DIRECT_SIGNATURE_FIELD_NAME = /(?:^|[\s.])signature(?:\s+\d+)?\s*$/i;
const SIGNATURE_DATE_FIELD = /\bdate\b.*\bsignature\b|\bsignature\b.*\bdate\b/i;
const REPORT_ONLY_ACTION_TYPES = new Set([
  'GoTo',
  'Thread',
  'Sound',
  'Movie',
  'Hide',
  'Named',
  'ResetForm',
  'SetOCGState',
  'Rendition',
  'Trans',
  'GoTo3DView',
  'RichMediaExecute',
]);
const MAX_ACTION_GRAPH_DEPTH = 64;
const MAX_ACTION_GRAPH_EDGES = 4_096;
const MAX_ACTION_GRAPH_NODES = 4_096;
const MAX_ACROFORM_FIELD_GRAPH_DEPTH = 128;
const MAX_ACROFORM_FIELD_GRAPH_NODES = 16_384;
const MAX_PAGE_TREE_DEPTH = 128;
const MAX_PAGE_TREE_NODES = 65_536;
const MAX_PDF_OBJECT_GRAPH_EDGES = 65_536;
const MAX_PDF_OBJECT_GRAPH_NODES = 65_536;

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function isPdfWhitespace(byte: number): boolean {
  return (
    byte === 0 ||
    byte === 9 ||
    byte === 10 ||
    byte === 12 ||
    byte === 13 ||
    byte === 32
  );
}

function rawBytesMatch(
  bytes: Uint8Array,
  start: number,
  expected: Uint8Array,
): boolean {
  if (start < 0 || start + expected.length > bytes.length) return false;
  return expected.every((byte, offset) => bytes[start + offset] === byte);
}

interface PdfRevisionCandidate {
  readonly start: number;
  readonly end: number;
  readonly xrefOffset: number;
  readonly linearizedPseudoMarker?: true;
}

interface PdfRevisionHistorySummary {
  readonly byteRangeNameCount: number;
  readonly historicalByteRangeNameCount: number;
  readonly historicalSignatureStructureCount: number;
  readonly revisionMarkerCount: number;
  readonly complete: boolean;
  readonly issues: readonly string[];
}

const STARTXREF_BYTES = new TextEncoder().encode('startxref');
const XREF_BYTES = new TextEncoder().encode('xref');
const OBJ_BYTES = new TextEncoder().encode('obj');
const EOF_BYTES = new TextEncoder().encode('%%EOF');
const MAX_PDF_HISTORY_REVISIONS = 32;
const MAX_PDF_HISTORY_PARSE_BYTES = 64 * 1024 * 1024;

function decimalIntegerAt(
  bytes: Uint8Array,
  start: number,
): { readonly end: number; readonly value: number } | null {
  let index = start;
  let value = 0;
  while (index < bytes.length && bytes[index] >= 48 && bytes[index] <= 57) {
    value = value * 10 + (bytes[index] - 48);
    if (!Number.isSafeInteger(value)) return null;
    index += 1;
  }
  return index === start ? null : { end: index, value };
}

function xrefOffsetLooksValid(
  bytes: Uint8Array,
  offset: number,
  revisionEnd: number,
): boolean {
  if (offset < 0 || offset >= revisionEnd) return false;
  if (rawBytesMatch(bytes, offset, XREF_BYTES)) return true;

  const objectNumber = decimalIntegerAt(bytes, offset);
  if (objectNumber === null) return false;
  let index = objectNumber.end;
  if (!isPdfWhitespace(bytes[index])) return false;
  while (isPdfWhitespace(bytes[index])) index += 1;
  const generation = decimalIntegerAt(bytes, index);
  if (generation === null) return false;
  index = generation.end;
  if (!isPdfWhitespace(bytes[index])) return false;
  while (isPdfWhitespace(bytes[index])) index += 1;
  return rawBytesMatch(bytes, index, OBJ_BYTES);
}

type RawPdfTokenKind =
  | 'array_close'
  | 'array_open'
  | 'dictionary_close'
  | 'dictionary_open'
  | 'hex_string'
  | 'literal_string'
  | 'name'
  | 'word';

interface RawPdfToken {
  readonly kind: RawPdfTokenKind;
  readonly start: number;
  readonly end: number;
}

type RawPdfStreamLength =
  | { readonly kind: 'direct'; readonly value: number }
  | { readonly kind: 'duplicate' | 'indirect' | 'invalid' | 'missing' };

interface RawPdfParsedValue {
  readonly end: number;
  readonly kind: 'dictionary' | 'integer' | 'other' | 'reference';
  readonly integer?: number;
  readonly integerArray?: readonly number[];
  readonly name?: string;
  readonly nameArray?: readonly string[];
  readonly linearization?: RawPdfLinearizationInfo;
  readonly objectStreamDictionary?: true;
  readonly objectStreamFirst?: number;
  readonly objectStreamMetadataInvalid?: true;
  readonly objectStreamN?: number;
  readonly streamDecodeParmsPresent?: true;
  readonly streamFilter?:
    | 'ascii85_flate'
    | 'flate'
    | 'flate_chain'
    | 'unsupported';
  readonly typeIndirect?: true;
  readonly xrefStreamDictionary?: true;
  readonly xrefStmOffset?: number;
  readonly prevOffset?: number;
  readonly xrefMetadataInvalid?: true;
  readonly streamLength?: RawPdfStreamLength;
}

interface RawPdfLinearizationInfo {
  readonly length: number;
  readonly firstPageObject: number;
  readonly firstPageEnd: number;
  readonly pageCount: number;
  readonly mainXrefOffset: number;
  readonly hintOffsets: readonly number[];
}

interface RawPdfScanState {
  readonly bytes: Uint8Array;
  readonly budget: RawPdfScanBudget;
  readonly issues: Set<string>;
  readonly strictValueWords: boolean;
  readonly allowLinearizedPseudoMarker: boolean;
  readonly classicXrefOffsets: number[];
  readonly xrefStreamOffsets: number[];
  readonly xrefStreamPrevOffsets: Map<number, number | null>;
  readonly linearization: RawPdfLinearizationInfo | null;
  linearizedPseudoMarkerCount: number;
  linearizedPseudoMarkerEnd: number | null;
  linearizedPseudoMarkerStart: number | null;
}

interface RawPdfScanBudget {
  decodedNameBytes: number;
  flateStreamCompressedBytes: number;
  flateStreamCount: number;
  flateStreamDecodedBytes: number;
  objectStreamCompressedBytes: number;
  objectStreamCount: number;
  objectStreamDecodedBytes: number;
  objectStreamObjectCount: number;
  tokenCount: number;
}

interface RawPdfRevisionScan {
  readonly candidates: readonly PdfRevisionCandidate[];
  readonly markerCount: number;
  readonly complete: boolean;
  readonly issues: readonly string[];
}

const MAX_RAW_PDF_CONTAINER_DEPTH = 128;
const MAX_RAW_PDF_TOKENS = 2_000_000;
const MAX_RAW_PDF_NAME_BYTES = 64 * 1024;
const MAX_RAW_PDF_DECODED_NAME_BYTES = 16 * 1024 * 1024;
const MAX_RAW_PDF_OBJECT_STREAMS = 4_096;
const MAX_RAW_PDF_OBJECT_STREAM_OBJECTS = 200_000;
const MAX_RAW_PDF_OBJECT_STREAM_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_RAW_PDF_OBJECT_STREAM_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_RAW_PDF_SINGLE_OBJECT_STREAM_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_RAW_PDF_SINGLE_OBJECT_STREAM_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_RAW_PDF_FLATE_STREAMS = 20_000;
const MAX_RAW_PDF_FLATE_STREAM_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_RAW_PDF_FLATE_STREAM_DECODED_BYTES = 96 * 1024 * 1024;
const MAX_RAW_PDF_SINGLE_FLATE_STREAM_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_RAW_PDF_SINGLE_FLATE_STREAM_DECODED_BYTES = 24 * 1024 * 1024;
const MAX_PDF_SOURCE_BYTES = 15 * 1024 * 1024;
const RAW_PDF_RESOURCE_ISSUES = new Set([
  'object_stream_compressed_budget_exceeded',
  'object_stream_count_limit_exceeded',
  'object_stream_decode_failed',
  'object_stream_decoded_budget_exceeded',
  'object_stream_filter_unsupported',
  'object_stream_object_budget_exceeded',
  'flate_stream_compressed_budget_exceeded',
  'flate_stream_count_limit_exceeded',
  'flate_stream_decode_failed',
  'flate_stream_decoded_budget_exceeded',
  'flate_filter_chain_unsupported',
  'raw_container_depth_exceeded',
  'raw_name_budget_exceeded',
  'raw_name_too_long',
  'raw_token_budget_exceeded',
  'stream_extent_unverified',
  'stream_length_duplicate',
  'stream_length_indirect',
  'stream_length_invalid',
  'stream_length_missing',
  'stream_length_out_of_bounds',
]);
const STREAM_BYTES = new TextEncoder().encode('stream');
const ENDSTREAM_BYTES = new TextEncoder().encode('endstream');
const LENGTH_BYTES = new TextEncoder().encode('Length');
const LINEARIZED_BYTES = new TextEncoder().encode('Linearized');
const LINEARIZED_LENGTH_BYTES = new TextEncoder().encode('L');
const LINEARIZED_OBJECT_BYTES = new TextEncoder().encode('O');
const LINEARIZED_END_BYTES = new TextEncoder().encode('E');
const LINEARIZED_PAGE_COUNT_BYTES = new TextEncoder().encode('N');
const LINEARIZED_MAIN_XREF_BYTES = new TextEncoder().encode('T');
const LINEARIZED_HINTS_BYTES = new TextEncoder().encode('H');
const PREV_BYTES = new TextEncoder().encode('Prev');
const FIRST_BYTES = new TextEncoder().encode('First');
const FILTER_BYTES = new TextEncoder().encode('Filter');
const DECODE_PARMS_BYTES = new TextEncoder().encode('DecodeParms');
const OBJ_STM_BYTES = new TextEncoder().encode('ObjStm');
const ASCII85_DECODE_NAME = 'ASCII85Decode';
const FLATE_DECODE_NAME = 'FlateDecode';
const REFERENCE_BYTES = new TextEncoder().encode('R');
const TRUE_BYTES = new TextEncoder().encode('true');
const FALSE_BYTES = new TextEncoder().encode('false');
const NULL_BYTES = new TextEncoder().encode('null');
const TRAILER_BYTES = new TextEncoder().encode('trailer');
const TYPE_BYTES = new TextEncoder().encode('Type');
const XREF_NAME_BYTES = new TextEncoder().encode('XRef');
const XREF_STM_BYTES = new TextEncoder().encode('XRefStm');

function createRawPdfScanBudget(): RawPdfScanBudget {
  return {
    decodedNameBytes: 0,
    flateStreamCompressedBytes: 0,
    flateStreamCount: 0,
    flateStreamDecodedBytes: 0,
    objectStreamCompressedBytes: 0,
    objectStreamCount: 0,
    objectStreamDecodedBytes: 0,
    objectStreamObjectCount: 0,
    tokenCount: 0,
  };
}

function isPdfDelimiter(byte: number): boolean {
  return (
    isPdfWhitespace(byte) ||
    byte === 37 ||
    byte === 40 ||
    byte === 41 ||
    byte === 47 ||
    byte === 60 ||
    byte === 62 ||
    byte === 91 ||
    byte === 93 ||
    byte === 123 ||
    byte === 125
  );
}

function hexNibble(byte: number): number | null {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return null;
}

function markRawPdfIssue(state: RawPdfScanState, issue: string): null {
  state.issues.add(issue);
  return null;
}

function nextRawPdfToken(
  state: RawPdfScanState,
  start: number,
): RawPdfToken | null {
  const { bytes } = state;
  let index = start;
  while (index < bytes.length) {
    if (isPdfWhitespace(bytes[index])) {
      index += 1;
      continue;
    }
    if (bytes[index] === 37) {
      while (
        index < bytes.length &&
        bytes[index] !== 10 &&
        bytes[index] !== 13
      ) {
        index += 1;
      }
      continue;
    }
    break;
  }
  if (index >= bytes.length) return null;
  state.budget.tokenCount += 1;
  if (state.budget.tokenCount > MAX_RAW_PDF_TOKENS) {
    return markRawPdfIssue(state, 'raw_token_budget_exceeded');
  }

  const tokenStart = index;
  if (bytes[index] === 40) {
    let depth = 1;
    index += 1;
    while (index < bytes.length && depth > 0) {
      if (bytes[index] === 92) {
        index += 1;
        if (bytes[index] === 13 && bytes[index + 1] === 10) index += 2;
        else if (index < bytes.length) index += 1;
        continue;
      }
      if (bytes[index] === 40) depth += 1;
      else if (bytes[index] === 41) depth -= 1;
      index += 1;
    }
    if (depth !== 0)
      return markRawPdfIssue(state, 'literal_string_unterminated');
    return { kind: 'literal_string', start: tokenStart, end: index };
  }
  if (bytes[index] === 60) {
    if (bytes[index + 1] === 60) {
      return { kind: 'dictionary_open', start: tokenStart, end: index + 2 };
    }
    index += 1;
    while (index < bytes.length && bytes[index] !== 62) index += 1;
    if (index >= bytes.length) {
      return markRawPdfIssue(state, 'hex_string_unterminated');
    }
    return { kind: 'hex_string', start: tokenStart, end: index + 1 };
  }
  if (bytes[index] === 62 && bytes[index + 1] === 62) {
    return { kind: 'dictionary_close', start: tokenStart, end: index + 2 };
  }
  if (bytes[index] === 91) {
    return { kind: 'array_open', start: tokenStart, end: index + 1 };
  }
  if (bytes[index] === 93) {
    return { kind: 'array_close', start: tokenStart, end: index + 1 };
  }
  if (bytes[index] === 47) {
    index += 1;
    while (index < bytes.length && !isPdfDelimiter(bytes[index])) index += 1;
    return { kind: 'name', start: tokenStart, end: index };
  }

  index += 1;
  while (index < bytes.length && !isPdfDelimiter(bytes[index])) index += 1;
  return { kind: 'word', start: tokenStart, end: index };
}

function rawPdfWordEquals(
  bytes: Uint8Array,
  token: RawPdfToken,
  expected: Uint8Array,
): boolean {
  return (
    token.kind === 'word' &&
    token.end - token.start === expected.length &&
    rawBytesMatch(bytes, token.start, expected)
  );
}

function rawPdfNameEquals(
  bytes: Uint8Array,
  token: RawPdfToken,
  expected: Uint8Array,
): boolean {
  if (token.kind !== 'name') return false;
  let source = token.start + 1;
  let target = 0;
  while (source < token.end) {
    let decoded = bytes[source];
    if (decoded === 35 && source + 2 < token.end) {
      const high = hexNibble(bytes[source + 1]);
      const low = hexNibble(bytes[source + 2]);
      if (high !== null && low !== null) {
        decoded = high * 16 + low;
        source += 2;
      }
    }
    if (target >= expected.length || decoded !== expected[target]) return false;
    source += 1;
    target += 1;
  }
  return target === expected.length;
}

function rawPdfDecodedName(
  state: RawPdfScanState,
  token: RawPdfToken,
): string | null {
  if (token.kind !== 'name') return null;
  const chunks: string[] = [];
  let characters: number[] = [];
  let decodedLength = 0;
  let source = token.start + 1;
  while (source < token.end) {
    let decoded = state.bytes[source];
    if (decoded === 35 && source + 2 < token.end) {
      const high = hexNibble(state.bytes[source + 1]);
      const low = hexNibble(state.bytes[source + 2]);
      if (high !== null && low !== null) {
        decoded = high * 16 + low;
        source += 2;
      }
    }
    decodedLength += 1;
    if (decodedLength > MAX_RAW_PDF_NAME_BYTES) {
      return markRawPdfIssue(state, 'raw_name_too_long');
    }
    characters.push(decoded);
    if (characters.length === 1_024) {
      chunks.push(String.fromCharCode(...characters));
      characters = [];
    }
    source += 1;
  }
  state.budget.decodedNameBytes += decodedLength;
  if (state.budget.decodedNameBytes > MAX_RAW_PDF_DECODED_NAME_BYTES) {
    return markRawPdfIssue(state, 'raw_name_budget_exceeded');
  }
  if (characters.length > 0) {
    chunks.push(String.fromCharCode(...characters));
  }
  return chunks.join('');
}

function rawPdfUnsignedInteger(
  bytes: Uint8Array,
  token: RawPdfToken,
): number | null {
  if (token.kind !== 'word') return null;
  let index = token.start;
  if (bytes[index] === 43) index += 1;
  if (index >= token.end) return null;
  let value = 0;
  while (index < token.end) {
    if (bytes[index] < 48 || bytes[index] > 57) return null;
    value = value * 10 + (bytes[index] - 48);
    if (!Number.isSafeInteger(value)) return null;
    index += 1;
  }
  return value;
}

function rawPdfNumberIsValid(bytes: Uint8Array, token: RawPdfToken): boolean {
  if (token.kind !== 'word') return false;
  let index = token.start;
  if (bytes[index] === 43 || bytes[index] === 45) index += 1;
  if (index >= token.end) return false;

  let sawDecimal = false;
  let sawDigit = false;
  while (index < token.end) {
    const byte = bytes[index];
    if (byte === 46 && !sawDecimal) {
      sawDecimal = true;
    } else if (byte >= 48 && byte <= 57) {
      sawDigit = true;
    } else {
      return false;
    }
    index += 1;
  }
  return sawDigit;
}

function rawPdfPrimitiveWordIsValid(
  bytes: Uint8Array,
  token: RawPdfToken,
): boolean {
  return (
    rawPdfNumberIsValid(bytes, token) ||
    rawPdfWordEquals(bytes, token, TRUE_BYTES) ||
    rawPdfWordEquals(bytes, token, FALSE_BYTES) ||
    rawPdfWordEquals(bytes, token, NULL_BYTES)
  );
}

function rawPdfNumberEqualsOne(bytes: Uint8Array, token: RawPdfToken): boolean {
  if (token.kind !== 'word' || token.end - token.start > 64) return false;
  let index = token.start;
  if (bytes[index] === 43) index += 1;
  if (index >= token.end || bytes[index] === 45) return false;

  let sawOne = false;
  let sawDecimalPoint = false;
  for (; index < token.end; index += 1) {
    const byte = bytes[index];
    if (byte === 46 && !sawDecimalPoint) {
      sawDecimalPoint = true;
      continue;
    }
    if (byte < 48 || byte > 57) return false;
    if (sawDecimalPoint) {
      if (byte !== 48) return false;
    } else if (byte === 49 && !sawOne) {
      sawOne = true;
    } else if (byte !== 48 || sawOne) {
      return false;
    }
  }
  return sawOne;
}

function parseRawPdfValueFromToken(
  state: RawPdfScanState,
  token: RawPdfToken,
  depth: number,
): RawPdfParsedValue | null {
  if (depth > MAX_RAW_PDF_CONTAINER_DEPTH) {
    return markRawPdfIssue(state, 'raw_container_depth_exceeded');
  }
  if (token.kind === 'dictionary_open') {
    return parseRawPdfDictionary(state, token, depth + 1);
  }
  if (token.kind === 'array_open') {
    return parseRawPdfArray(state, token, depth + 1);
  }
  if (token.kind === 'dictionary_close' || token.kind === 'array_close') {
    return markRawPdfIssue(state, 'raw_container_close_unexpected');
  }
  if (token.kind === 'name') {
    const name = rawPdfDecodedName(state, token);
    return name === null ? null : { end: token.end, kind: 'other', name };
  }

  const integer = rawPdfUnsignedInteger(state.bytes, token);
  if (integer === null) {
    if (
      state.strictValueWords &&
      token.kind === 'word' &&
      !rawPdfPrimitiveWordIsValid(state.bytes, token)
    ) {
      return markRawPdfIssue(state, 'object_stream_value_invalid');
    }
    return { end: token.end, kind: 'other' };
  }
  const generationToken = nextRawPdfToken(state, token.end);
  const generation =
    generationToken === null
      ? null
      : rawPdfUnsignedInteger(state.bytes, generationToken);
  if (generationToken !== null && generation !== null) {
    const referenceToken = nextRawPdfToken(state, generationToken.end);
    if (
      referenceToken !== null &&
      rawPdfWordEquals(state.bytes, referenceToken, REFERENCE_BYTES)
    ) {
      return { end: referenceToken.end, kind: 'reference' };
    }
  }
  return { end: token.end, kind: 'integer', integer };
}

function parseRawPdfArray(
  state: RawPdfScanState,
  open: RawPdfToken,
  depth: number,
): RawPdfParsedValue | null {
  let index = open.end;
  const integers: number[] = [];
  const names: string[] = [];
  let integersOnly = true;
  let namesOnly = true;
  while (index < state.bytes.length) {
    const token = nextRawPdfToken(state, index);
    if (token === null) break;
    if (token.kind === 'array_close') {
      return {
        end: token.end,
        kind: 'other',
        ...(integersOnly ? { integerArray: integers } : {}),
        ...(namesOnly ? { nameArray: names } : {}),
      };
    }
    const value = parseRawPdfValueFromToken(state, token, depth);
    if (value === null) return null;
    if (value.kind === 'integer' && value.integer !== undefined) {
      integers.push(value.integer);
    } else {
      integersOnly = false;
    }
    if (value.name !== undefined) names.push(value.name);
    else namesOnly = false;
    index = value.end;
  }
  return markRawPdfIssue(state, 'array_unterminated');
}

function parseRawPdfDictionary(
  state: RawPdfScanState,
  open: RawPdfToken,
  depth: number,
): RawPdfParsedValue | null {
  let index = open.end;
  let sawLength = false;
  let sawType = false;
  let sawPrev = false;
  let sawXrefStm = false;
  let streamLength: RawPdfStreamLength = { kind: 'missing' };
  let typeIndirect = false;
  let xrefStreamDictionary = false;
  let objectStreamDictionary = false;
  let objectStreamN: number | undefined;
  let objectStreamFirst: number | undefined;
  let objectStreamMetadataInvalid = false;
  let streamFilter:
    | 'ascii85_flate'
    | 'flate'
    | 'flate_chain'
    | 'unsupported'
    | undefined;
  let streamDecodeParmsPresent = false;
  let xrefStmOffset: number | undefined;
  let prevOffset: number | undefined;
  let xrefMetadataInvalid = false;
  let linearizationInvalid = false;
  const linearizationKeys = new Set<string>();
  let linearized: number | undefined;
  let linearizedLength: number | undefined;
  let firstPageObject: number | undefined;
  let firstPageEnd: number | undefined;
  let pageCount: number | undefined;
  let mainXrefOffset: number | undefined;
  let hintOffsets: readonly number[] | undefined;
  const dictionaryKeys = new Set<string>();
  while (index < state.bytes.length) {
    const key = nextRawPdfToken(state, index);
    if (key === null) break;
    if (key.kind === 'dictionary_close') {
      let linearization: RawPdfLinearizationInfo | undefined;
      if (
        !linearizationInvalid &&
        linearized === 1 &&
        linearizedLength !== undefined &&
        firstPageObject !== undefined &&
        firstPageEnd !== undefined &&
        pageCount !== undefined &&
        mainXrefOffset !== undefined &&
        hintOffsets !== undefined
      ) {
        linearization = {
          length: linearizedLength,
          firstPageObject,
          firstPageEnd,
          pageCount,
          mainXrefOffset,
          hintOffsets,
        };
      }
      return {
        end: key.end,
        kind: 'dictionary',
        streamLength,
        ...(linearization === undefined ? {} : { linearization }),
        ...(objectStreamDictionary ? { objectStreamDictionary: true } : {}),
        ...(objectStreamFirst === undefined ? {} : { objectStreamFirst }),
        ...(objectStreamMetadataInvalid
          ? { objectStreamMetadataInvalid: true }
          : {}),
        ...(objectStreamN === undefined ? {} : { objectStreamN }),
        ...(streamDecodeParmsPresent ? { streamDecodeParmsPresent: true } : {}),
        ...(streamFilter === undefined ? {} : { streamFilter }),
        ...(typeIndirect ? { typeIndirect: true } : {}),
        ...(xrefStreamDictionary ? { xrefStreamDictionary: true } : {}),
        ...(xrefStmOffset === undefined ? {} : { xrefStmOffset }),
        ...(prevOffset === undefined ? {} : { prevOffset }),
        ...(xrefMetadataInvalid ? { xrefMetadataInvalid: true } : {}),
      };
    }
    if (key.kind !== 'name') {
      return markRawPdfIssue(state, 'dictionary_key_invalid');
    }
    const decodedKey = rawPdfDecodedName(state, key);
    if (decodedKey === null) return null;
    if (dictionaryKeys.has(decodedKey)) {
      return markRawPdfIssue(state, 'dictionary_key_duplicate');
    }
    dictionaryKeys.add(decodedKey);
    const valueToken = nextRawPdfToken(state, key.end);
    if (valueToken === null) {
      return markRawPdfIssue(state, 'dictionary_value_missing');
    }
    const value = parseRawPdfValueFromToken(state, valueToken, depth);
    if (value === null) return null;
    if (rawPdfNameEquals(state.bytes, key, LENGTH_BYTES)) {
      if (sawLength) streamLength = { kind: 'duplicate' };
      else if (value.kind === 'integer' && value.integer !== undefined) {
        streamLength = { kind: 'direct', value: value.integer };
      } else if (value.kind === 'reference') {
        streamLength = { kind: 'indirect' };
      } else {
        streamLength = { kind: 'invalid' };
      }
      sawLength = true;
    }
    if (rawPdfNameEquals(state.bytes, key, TYPE_BYTES)) {
      if (sawType) xrefMetadataInvalid = true;
      typeIndirect = value.kind === 'reference';
      xrefStreamDictionary = rawPdfNameEquals(
        state.bytes,
        valueToken,
        XREF_NAME_BYTES,
      );
      objectStreamDictionary = rawPdfNameEquals(
        state.bytes,
        valueToken,
        OBJ_STM_BYTES,
      );
      sawType = true;
    }
    if (rawPdfNameEquals(state.bytes, key, LINEARIZED_PAGE_COUNT_BYTES)) {
      if (value.kind === 'integer' && value.integer !== undefined) {
        objectStreamN = value.integer;
      } else {
        objectStreamMetadataInvalid = true;
      }
    }
    if (rawPdfNameEquals(state.bytes, key, FIRST_BYTES)) {
      if (value.kind === 'integer' && value.integer !== undefined) {
        objectStreamFirst = value.integer;
      } else {
        objectStreamMetadataInvalid = true;
      }
    }
    if (rawPdfNameEquals(state.bytes, key, FILTER_BYTES)) {
      streamFilter =
        value.name === FLATE_DECODE_NAME ||
        (value.nameArray?.length === 1 &&
          value.nameArray[0] === FLATE_DECODE_NAME)
          ? 'flate'
          : value.nameArray?.length === 2 &&
              value.nameArray[0] === ASCII85_DECODE_NAME &&
              value.nameArray[1] === FLATE_DECODE_NAME
            ? 'ascii85_flate'
            : value.nameArray?.includes(FLATE_DECODE_NAME)
              ? 'flate_chain'
              : 'unsupported';
    }
    if (rawPdfNameEquals(state.bytes, key, DECODE_PARMS_BYTES)) {
      streamDecodeParmsPresent = true;
    }
    if (rawPdfNameEquals(state.bytes, key, PREV_BYTES)) {
      if (sawPrev || value.kind !== 'integer' || value.integer === undefined) {
        xrefMetadataInvalid = true;
      } else {
        prevOffset = value.integer;
      }
      sawPrev = true;
    }
    if (rawPdfNameEquals(state.bytes, key, XREF_STM_BYTES)) {
      if (
        sawXrefStm ||
        value.kind !== 'integer' ||
        value.integer === undefined
      ) {
        xrefMetadataInvalid = true;
      } else {
        xrefStmOffset = value.integer;
      }
      sawXrefStm = true;
    }

    const setLinearizationInteger = (
      identifier: string,
      assign: (integer: number) => void,
    ) => {
      if (
        linearizationKeys.has(identifier) ||
        value.kind !== 'integer' ||
        value.integer === undefined
      ) {
        linearizationInvalid = true;
      } else {
        assign(value.integer);
      }
      linearizationKeys.add(identifier);
    };
    if (rawPdfNameEquals(state.bytes, key, LINEARIZED_BYTES)) {
      if (
        linearizationKeys.has('Linearized') ||
        !rawPdfNumberEqualsOne(state.bytes, valueToken)
      ) {
        linearizationInvalid = true;
      } else {
        linearized = 1;
      }
      linearizationKeys.add('Linearized');
    } else if (rawPdfNameEquals(state.bytes, key, LINEARIZED_LENGTH_BYTES)) {
      setLinearizationInteger('L', (integer) => {
        linearizedLength = integer;
      });
    } else if (rawPdfNameEquals(state.bytes, key, LINEARIZED_OBJECT_BYTES)) {
      setLinearizationInteger('O', (integer) => {
        firstPageObject = integer;
      });
    } else if (rawPdfNameEquals(state.bytes, key, LINEARIZED_END_BYTES)) {
      setLinearizationInteger('E', (integer) => {
        firstPageEnd = integer;
      });
    } else if (
      rawPdfNameEquals(state.bytes, key, LINEARIZED_PAGE_COUNT_BYTES)
    ) {
      setLinearizationInteger('N', (integer) => {
        pageCount = integer;
      });
    } else if (rawPdfNameEquals(state.bytes, key, LINEARIZED_MAIN_XREF_BYTES)) {
      setLinearizationInteger('T', (integer) => {
        mainXrefOffset = integer;
      });
    } else if (rawPdfNameEquals(state.bytes, key, LINEARIZED_HINTS_BYTES)) {
      if (linearizationKeys.has('H') || value.integerArray === undefined) {
        linearizationInvalid = true;
      } else {
        hintOffsets = value.integerArray;
      }
      linearizationKeys.add('H');
    }
    index = value.end;
  }
  return markRawPdfIssue(state, 'dictionary_unterminated');
}

interface RawPdfIndirectDictionary {
  readonly objectStart: number;
  readonly value: RawPdfParsedValue;
}

function parseRawPdfIndirectDictionary(
  state: RawPdfScanState,
  objectNumberToken: RawPdfToken,
): RawPdfIndirectDictionary | null {
  if (rawPdfUnsignedInteger(state.bytes, objectNumberToken) === null) {
    return null;
  }
  const generationToken = nextRawPdfToken(state, objectNumberToken.end);
  if (
    generationToken === null ||
    rawPdfUnsignedInteger(state.bytes, generationToken) === null
  ) {
    return null;
  }
  const objectToken = nextRawPdfToken(state, generationToken.end);
  if (
    objectToken === null ||
    !rawPdfWordEquals(state.bytes, objectToken, OBJ_BYTES)
  ) {
    return null;
  }
  const valueToken = nextRawPdfToken(state, objectToken.end);
  if (valueToken === null || valueToken.kind !== 'dictionary_open') {
    return null;
  }
  const value = parseRawPdfValueFromToken(state, valueToken, 0);
  return value?.kind === 'dictionary'
    ? { objectStart: objectNumberToken.start, value }
    : null;
}

function firstRawPdfLinearization(
  bytes: Uint8Array,
): RawPdfLinearizationInfo | null {
  const state: RawPdfScanState = {
    bytes,
    budget: createRawPdfScanBudget(),
    issues: new Set(),
    strictValueWords: false,
    allowLinearizedPseudoMarker: false,
    classicXrefOffsets: [],
    xrefStreamOffsets: [],
    xrefStreamPrevOffsets: new Map(),
    linearization: null,
    linearizedPseudoMarkerCount: 0,
    linearizedPseudoMarkerEnd: null,
    linearizedPseudoMarkerStart: null,
  };
  const firstToken = nextRawPdfToken(state, 0);
  if (firstToken === null) return null;
  const firstObject = parseRawPdfIndirectDictionary(state, firstToken);
  if (firstObject === null || state.issues.size > 0) return null;
  const linearization = firstObject.value.linearization;
  if (linearization === undefined) return null;

  const {
    length,
    firstPageObject,
    firstPageEnd,
    pageCount,
    mainXrefOffset,
    hintOffsets,
  } = linearization;
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > bytes.length ||
    !Number.isSafeInteger(firstPageObject) ||
    firstPageObject <= 0 ||
    !Number.isSafeInteger(firstPageEnd) ||
    firstPageEnd <= firstObject.value.end ||
    firstPageEnd > length ||
    !Number.isSafeInteger(pageCount) ||
    pageCount <= 0 ||
    !Number.isSafeInteger(mainXrefOffset) ||
    mainXrefOffset <= 0 ||
    mainXrefOffset >= length ||
    (hintOffsets.length !== 2 && hintOffsets.length !== 4) ||
    hintOffsets.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > length,
    )
  ) {
    return null;
  }
  for (let index = 0; index < hintOffsets.length; index += 2) {
    if (hintOffsets[index] + hintOffsets[index + 1] > length) return null;
  }
  return linearization;
}

interface RawPdfStreamExtent {
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly end: number;
}

function rawPdfStreamExtent(
  state: RawPdfScanState,
  streamToken: RawPdfToken,
  length: RawPdfStreamLength,
): RawPdfStreamExtent | null {
  if (length.kind !== 'direct') {
    return markRawPdfIssue(state, `stream_length_${length.kind}`);
  }
  let dataStart = streamToken.end;
  while (
    dataStart < state.bytes.length &&
    (state.bytes[dataStart] === 0 ||
      state.bytes[dataStart] === 9 ||
      state.bytes[dataStart] === 12 ||
      state.bytes[dataStart] === 32)
  ) {
    dataStart += 1;
  }
  if (state.bytes[dataStart] === 13) {
    dataStart += state.bytes[dataStart + 1] === 10 ? 2 : 1;
  } else if (state.bytes[dataStart] === 10) {
    dataStart += 1;
  } else {
    return markRawPdfIssue(state, 'stream_eol_missing');
  }
  const dataEnd = dataStart + length.value;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > state.bytes.length) {
    return markRawPdfIssue(state, 'stream_length_out_of_bounds');
  }

  let endstreamStart = dataEnd;
  if (state.bytes[endstreamStart] === 13) {
    endstreamStart += state.bytes[endstreamStart + 1] === 10 ? 2 : 1;
  } else if (state.bytes[endstreamStart] === 10) {
    endstreamStart += 1;
  }
  while (
    endstreamStart < state.bytes.length &&
    (state.bytes[endstreamStart] === 0 ||
      state.bytes[endstreamStart] === 9 ||
      state.bytes[endstreamStart] === 12 ||
      state.bytes[endstreamStart] === 32)
  ) {
    endstreamStart += 1;
  }
  if (
    !rawBytesMatch(state.bytes, endstreamStart, ENDSTREAM_BYTES) ||
    (endstreamStart > 0 && !isPdfDelimiter(state.bytes[endstreamStart - 1])) ||
    (endstreamStart + ENDSTREAM_BYTES.length < state.bytes.length &&
      !isPdfDelimiter(state.bytes[endstreamStart + ENDSTREAM_BYTES.length]))
  ) {
    return markRawPdfIssue(state, 'stream_extent_unverified');
  }
  return {
    dataStart,
    dataEnd,
    end: endstreamStart + ENDSTREAM_BYTES.length,
  };
}

function rawPdfChildState(
  parent: RawPdfScanState,
  bytes: Uint8Array,
): RawPdfScanState {
  return {
    bytes,
    budget: parent.budget,
    issues: parent.issues,
    strictValueWords: true,
    allowLinearizedPseudoMarker: false,
    classicXrefOffsets: [],
    xrefStreamOffsets: [],
    xrefStreamPrevOffsets: new Map(),
    linearization: null,
    linearizedPseudoMarkerCount: 0,
    linearizedPseudoMarkerEnd: null,
    linearizedPseudoMarkerStart: null,
  };
}

function onlyRawPdfWhitespaceAndCommentsRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  allowFinalComment: boolean,
): boolean {
  if (start < 0 || end < start || end > bytes.length) return false;
  let index = start;
  while (index < end) {
    if (isPdfWhitespace(bytes[index])) {
      index += 1;
      continue;
    }
    if (bytes[index] !== 37) return false;
    index += 1;
    while (index < end && bytes[index] !== 10 && bytes[index] !== 13) {
      index += 1;
    }
    if (index === end && !allowFinalComment) return false;
  }
  return true;
}

function markObjectStreamIssue(state: RawPdfScanState, issue: string): false {
  state.issues.add(issue);
  return false;
}

class RawPdfDecodeLimitError extends Error {}

function decodeBoundedAscii85(
  input: Uint8Array,
  maxOutputBytes: number,
): Uint8Array {
  const output: number[] = [];
  const group: number[] = [];
  let index = 0;
  let terminated = false;
  const append = (value: number): void => {
    if (output.length >= maxOutputBytes) throw new RawPdfDecodeLimitError();
    output.push(value);
  };
  const flush = (count: number): void => {
    let value = 0;
    for (let groupIndex = 0; groupIndex < 5; groupIndex += 1) {
      value = value * 85 + (group[groupIndex] ?? 84);
      if (!Number.isSafeInteger(value) || value > 0xffff_ffff) {
        throw new Error('Invalid ASCII85 group');
      }
    }
    for (let byteIndex = 0; byteIndex < count; byteIndex += 1) {
      append((value >>> (24 - byteIndex * 8)) & 255);
    }
    group.length = 0;
  };

  while (index < input.byteLength) {
    const byte = input[index++];
    if (isPdfWhitespace(byte)) continue;
    if (byte === 60 && input[index] === 126 && output.length === 0) {
      index += 1;
      continue;
    }
    if (byte === 126) {
      while (index < input.byteLength && isPdfWhitespace(input[index])) {
        index += 1;
      }
      if (input[index] !== 62) throw new Error('Invalid ASCII85 terminator');
      index += 1;
      terminated = true;
      break;
    }
    if (byte === 122) {
      if (group.length !== 0) throw new Error('Invalid ASCII85 zero group');
      append(0);
      append(0);
      append(0);
      append(0);
      continue;
    }
    if (byte < 33 || byte > 117) throw new Error('Invalid ASCII85 byte');
    group.push(byte - 33);
    if (group.length === 5) flush(4);
  }
  if (!terminated || group.length === 1) {
    throw new Error('Invalid ASCII85 stream');
  }
  if (group.length > 1) flush(group.length - 1);
  while (index < input.byteLength) {
    if (!isPdfWhitespace(input[index])) {
      throw new Error('Trailing ASCII85 data');
    }
    index += 1;
  }
  return Uint8Array.from(output);
}

function rawPdfZlibInput(
  input: Uint8Array,
  filter: RawPdfParsedValue['streamFilter'],
  maxOutputBytes: number,
): Uint8Array {
  return filter === 'ascii85_flate'
    ? decodeBoundedAscii85(input, maxOutputBytes)
    : input;
}

function scanRawPdfObjectStreamPayload(
  state: RawPdfScanState,
  payload: Uint8Array,
  objectCount: number,
  firstObjectOffset: number,
): boolean {
  if (
    firstObjectOffset > payload.byteLength ||
    (objectCount > 0 && firstObjectOffset === 0)
  ) {
    return markObjectStreamIssue(state, 'object_stream_metadata_invalid');
  }
  if (
    state.budget.objectStreamObjectCount + objectCount >
    MAX_RAW_PDF_OBJECT_STREAM_OBJECTS
  ) {
    return markObjectStreamIssue(state, 'object_stream_object_budget_exceeded');
  }
  state.budget.objectStreamObjectCount += objectCount;

  const headerState = rawPdfChildState(state, payload);
  const objectNumbers = new Set<number>();
  const offsets: number[] = [];
  let index = 0;
  for (let objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
    const objectNumberToken = nextRawPdfToken(headerState, index);
    if (
      objectNumberToken === null ||
      objectNumberToken.start >= firstObjectOffset ||
      objectNumberToken.end > firstObjectOffset
    ) {
      return markObjectStreamIssue(state, 'object_stream_header_invalid');
    }
    const objectNumber = rawPdfUnsignedInteger(payload, objectNumberToken);
    if (objectNumber === null || objectNumber === 0) {
      return markObjectStreamIssue(state, 'object_stream_header_invalid');
    }

    const offsetToken = nextRawPdfToken(headerState, objectNumberToken.end);
    if (
      offsetToken === null ||
      offsetToken.start >= firstObjectOffset ||
      offsetToken.end > firstObjectOffset
    ) {
      return markObjectStreamIssue(state, 'object_stream_header_invalid');
    }
    const offset = rawPdfUnsignedInteger(payload, offsetToken);
    if (
      offset === null ||
      offset > payload.byteLength - firstObjectOffset ||
      objectNumbers.has(objectNumber) ||
      (offsets.length > 0 && offset <= offsets[offsets.length - 1])
    ) {
      return markObjectStreamIssue(state, 'object_stream_header_invalid');
    }
    objectNumbers.add(objectNumber);
    offsets.push(offset);
    index = offsetToken.end;
  }

  if (
    !onlyRawPdfWhitespaceAndCommentsRange(
      payload,
      index,
      firstObjectOffset,
      false,
    )
  ) {
    return markObjectStreamIssue(state, 'object_stream_header_invalid');
  }
  if (objectCount === 0) {
    return onlyRawPdfWhitespaceAndCommentsRange(
      payload,
      firstObjectOffset,
      payload.byteLength,
      true,
    )
      ? true
      : markObjectStreamIssue(state, 'object_stream_payload_invalid');
  }
  if (
    !onlyRawPdfWhitespaceAndCommentsRange(
      payload,
      firstObjectOffset,
      firstObjectOffset + offsets[0],
      false,
    )
  ) {
    return markObjectStreamIssue(state, 'object_stream_payload_invalid');
  }

  for (let objectIndex = 0; objectIndex < objectCount; objectIndex += 1) {
    const objectStart = firstObjectOffset + offsets[objectIndex];
    const objectEnd =
      objectIndex + 1 < objectCount
        ? firstObjectOffset + offsets[objectIndex + 1]
        : payload.byteLength;
    if (objectStart >= objectEnd) {
      return markObjectStreamIssue(state, 'object_stream_payload_invalid');
    }

    const objectBytes = payload.subarray(objectStart, objectEnd);
    const objectState = rawPdfChildState(state, objectBytes);
    const valueToken = nextRawPdfToken(objectState, 0);
    if (valueToken === null) {
      return markObjectStreamIssue(state, 'object_stream_payload_invalid');
    }
    const issueCount = state.issues.size;
    const value = parseRawPdfValueFromToken(objectState, valueToken, 0);
    if (value === null) {
      return state.issues.size > issueCount
        ? false
        : markObjectStreamIssue(state, 'object_stream_payload_invalid');
    }
    if (
      !onlyRawPdfWhitespaceAndCommentsRange(
        objectBytes,
        value.end,
        objectBytes.byteLength,
        objectIndex + 1 === objectCount,
      )
    ) {
      return markObjectStreamIssue(state, 'object_stream_payload_invalid');
    }
  }
  return true;
}

function scanRawPdfObjectStream(
  state: RawPdfScanState,
  dictionary: RawPdfParsedValue,
  extent: RawPdfStreamExtent,
): boolean {
  state.budget.objectStreamCount += 1;
  if (state.budget.objectStreamCount > MAX_RAW_PDF_OBJECT_STREAMS) {
    return markObjectStreamIssue(state, 'object_stream_count_limit_exceeded');
  }
  if (
    dictionary.objectStreamMetadataInvalid ||
    dictionary.objectStreamN === undefined ||
    dictionary.objectStreamFirst === undefined
  ) {
    return markObjectStreamIssue(state, 'object_stream_metadata_invalid');
  }
  if (
    dictionary.streamDecodeParmsPresent ||
    dictionary.streamFilter === 'unsupported' ||
    dictionary.streamFilter === 'flate_chain' ||
    dictionary.streamFilter === 'ascii85_flate'
  ) {
    return markObjectStreamIssue(state, 'object_stream_filter_unsupported');
  }

  const input = state.bytes.subarray(extent.dataStart, extent.dataEnd);
  if (
    input.byteLength > MAX_RAW_PDF_SINGLE_OBJECT_STREAM_COMPRESSED_BYTES ||
    state.budget.objectStreamCompressedBytes + input.byteLength >
      MAX_RAW_PDF_OBJECT_STREAM_COMPRESSED_BYTES
  ) {
    return markObjectStreamIssue(
      state,
      'object_stream_compressed_budget_exceeded',
    );
  }
  state.budget.objectStreamCompressedBytes += input.byteLength;

  let payload: Uint8Array;
  if (dictionary.streamFilter === 'flate') {
    const remainingDecodedBytes =
      MAX_RAW_PDF_OBJECT_STREAM_DECODED_BYTES -
      state.budget.objectStreamDecodedBytes;
    const outputLimit = Math.min(
      remainingDecodedBytes,
      MAX_RAW_PDF_SINGLE_OBJECT_STREAM_DECODED_BYTES,
    );
    if (outputLimit <= 0) {
      return markObjectStreamIssue(
        state,
        'object_stream_decoded_budget_exceeded',
      );
    }
    try {
      payload = decodeBoundedZlib(input, outputLimit);
    } catch (error) {
      return markObjectStreamIssue(
        state,
        error instanceof BoundedZlibDecodeLimitError
          ? 'object_stream_decoded_budget_exceeded'
          : 'object_stream_decode_failed',
      );
    }
  } else {
    payload = input;
  }
  if (
    payload.byteLength > MAX_RAW_PDF_SINGLE_OBJECT_STREAM_DECODED_BYTES ||
    state.budget.objectStreamDecodedBytes + payload.byteLength >
      MAX_RAW_PDF_OBJECT_STREAM_DECODED_BYTES
  ) {
    return markObjectStreamIssue(
      state,
      'object_stream_decoded_budget_exceeded',
    );
  }
  state.budget.objectStreamDecodedBytes += payload.byteLength;
  return scanRawPdfObjectStreamPayload(
    state,
    payload,
    dictionary.objectStreamN,
    dictionary.objectStreamFirst,
  );
}

function scanRawPdfFlateStream(
  state: RawPdfScanState,
  dictionary: RawPdfParsedValue,
  extent: RawPdfStreamExtent,
): boolean {
  state.budget.flateStreamCount += 1;
  if (state.budget.flateStreamCount > MAX_RAW_PDF_FLATE_STREAMS) {
    return markObjectStreamIssue(state, 'flate_stream_count_limit_exceeded');
  }
  const input = state.bytes.subarray(extent.dataStart, extent.dataEnd);
  if (
    input.byteLength > MAX_RAW_PDF_SINGLE_FLATE_STREAM_COMPRESSED_BYTES ||
    state.budget.flateStreamCompressedBytes + input.byteLength >
      MAX_RAW_PDF_FLATE_STREAM_COMPRESSED_BYTES
  ) {
    return markObjectStreamIssue(
      state,
      'flate_stream_compressed_budget_exceeded',
    );
  }
  state.budget.flateStreamCompressedBytes += input.byteLength;
  const remainingDecodedBytes =
    MAX_RAW_PDF_FLATE_STREAM_DECODED_BYTES -
    state.budget.flateStreamDecodedBytes;
  const outputLimit = Math.min(
    remainingDecodedBytes,
    MAX_RAW_PDF_SINGLE_FLATE_STREAM_DECODED_BYTES,
  );
  if (outputLimit <= 0) {
    return markObjectStreamIssue(state, 'flate_stream_decoded_budget_exceeded');
  }
  let decoded: Uint8Array;
  try {
    const zlibInput = rawPdfZlibInput(
      input,
      dictionary.streamFilter,
      MAX_RAW_PDF_SINGLE_FLATE_STREAM_COMPRESSED_BYTES,
    );
    decoded = decodeBoundedZlib(zlibInput, outputLimit);
  } catch (error) {
    return markObjectStreamIssue(
      state,
      error instanceof BoundedZlibDecodeLimitError ||
        error instanceof RawPdfDecodeLimitError
        ? 'flate_stream_decoded_budget_exceeded'
        : 'flate_stream_decode_failed',
    );
  }
  if (
    decoded.byteLength > MAX_RAW_PDF_SINGLE_FLATE_STREAM_DECODED_BYTES ||
    state.budget.flateStreamDecodedBytes + decoded.byteLength >
      MAX_RAW_PDF_FLATE_STREAM_DECODED_BYTES
  ) {
    return markObjectStreamIssue(state, 'flate_stream_decoded_budget_exceeded');
  }
  state.budget.flateStreamDecodedBytes += decoded.byteLength;
  return true;
}

function rawPdfOrdinaryStreamResourceSafe(
  state: RawPdfScanState,
  dictionary: RawPdfParsedValue,
  extent: RawPdfStreamExtent,
): boolean {
  if (dictionary.streamFilter === 'flate_chain') {
    return markObjectStreamIssue(state, 'flate_filter_chain_unsupported');
  }
  return (
    (dictionary.streamFilter !== 'flate' &&
      dictionary.streamFilter !== 'ascii85_flate') ||
    scanRawPdfFlateStream(state, dictionary, extent)
  );
}

function revisionCandidateAfterStartXref(
  state: RawPdfScanState,
  startXref: RawPdfToken,
): PdfRevisionCandidate | null {
  const offsetToken = nextRawPdfToken(state, startXref.end);
  if (offsetToken === null) return null;
  const xrefOffset = rawPdfUnsignedInteger(state.bytes, offsetToken);
  if (xrefOffset === null) return null;
  let index = offsetToken.end;
  while (index < state.bytes.length) {
    while (index < state.bytes.length && isPdfWhitespace(state.bytes[index])) {
      index += 1;
    }
    if (rawBytesMatch(state.bytes, index, EOF_BYTES)) {
      const end = index + EOF_BYTES.length;
      if (end !== state.bytes.length && !isPdfWhitespace(state.bytes[end])) {
        return null;
      }
      if (!xrefOffsetLooksValid(state.bytes, xrefOffset, index)) {
        if (
          xrefOffset === 0 &&
          state.allowLinearizedPseudoMarker &&
          startXref.start < 4_096 &&
          state.linearizedPseudoMarkerCount === 0
        ) {
          state.linearizedPseudoMarkerCount += 1;
          state.linearizedPseudoMarkerStart = startXref.start;
          state.linearizedPseudoMarkerEnd = end;
          return {
            start: startXref.start,
            end,
            xrefOffset,
            linearizedPseudoMarker: true,
          };
        }
        return markRawPdfIssue(state, 'revision_xref_offset_invalid');
      }
      return { start: startXref.start, end, xrefOffset };
    }
    if (state.bytes[index] !== 37) return null;
    while (
      index < state.bytes.length &&
      state.bytes[index] !== 10 &&
      state.bytes[index] !== 13
    ) {
      index += 1;
    }
  }
  return null;
}

function scanRawPdfRevisions(
  bytes: Uint8Array,
  linearization: RawPdfLinearizationInfo | null,
): RawPdfRevisionScan {
  const state: RawPdfScanState = {
    bytes,
    budget: createRawPdfScanBudget(),
    issues: new Set(),
    strictValueWords: false,
    allowLinearizedPseudoMarker: linearization !== null,
    classicXrefOffsets: [],
    xrefStreamOffsets: [],
    xrefStreamPrevOffsets: new Map(),
    linearization,
    linearizedPseudoMarkerCount: 0,
    linearizedPseudoMarkerEnd: null,
    linearizedPseudoMarkerStart: null,
  };
  const candidates: PdfRevisionCandidate[] = [];
  let markerCount = 0;
  let index = 0;
  while (index < bytes.length && state.issues.size === 0) {
    const token = nextRawPdfToken(state, index);
    if (token === null) break;
    if (rawPdfWordEquals(bytes, token, STARTXREF_BYTES)) {
      const candidate = revisionCandidateAfterStartXref(state, token);
      if (candidate !== null) {
        if (candidate.linearizedPseudoMarker) {
          index = candidate.end;
          continue;
        }
        markerCount += 1;
        if (candidates.length < MAX_PDF_HISTORY_REVISIONS + 1) {
          candidates.push(candidate);
        }
        index = candidate.end;
        continue;
      }
      if (state.issues.size === 0) {
        state.issues.add('revision_marker_malformed');
      }
      break;
    }
    if (rawPdfWordEquals(bytes, token, XREF_BYTES)) {
      state.classicXrefOffsets.push(token.start);
    }
    if (rawPdfWordEquals(bytes, token, TRAILER_BYTES)) {
      const dictionaryToken = nextRawPdfToken(state, token.end);
      if (
        dictionaryToken === null ||
        dictionaryToken.kind !== 'dictionary_open'
      ) {
        state.issues.add('trailer_dictionary_missing');
        break;
      }
      const trailer = parseRawPdfValueFromToken(state, dictionaryToken, 0);
      if (trailer === null || trailer.kind !== 'dictionary') break;
      if (trailer.xrefMetadataInvalid) {
        state.issues.add('trailer_xref_metadata_invalid');
        break;
      }
      if (trailer.xrefStmOffset !== undefined) {
        state.issues.add('hybrid_xref_unverified');
        break;
      }
      index = trailer.end;
      continue;
    }

    const indirectDictionary = parseRawPdfIndirectDictionary(state, token);
    if (indirectDictionary !== null) {
      const { objectStart, value } = indirectDictionary;
      if (value.xrefStreamDictionary) {
        state.xrefStreamOffsets.push(objectStart);
        state.xrefStreamPrevOffsets.set(objectStart, value.prevOffset ?? null);
        if (value.xrefMetadataInvalid) {
          state.issues.add('xref_stream_metadata_invalid');
          break;
        }
      }
      index = value.end;
      const streamToken = nextRawPdfToken(state, value.end);
      const hasStream =
        streamToken !== null &&
        rawPdfWordEquals(bytes, streamToken, STREAM_BYTES);
      if (value.objectStreamDictionary && !hasStream) {
        state.issues.add('object_stream_missing');
        break;
      }
      if (hasStream) {
        if (value.typeIndirect) {
          state.issues.add('stream_type_indirect');
          break;
        }
        const extent = rawPdfStreamExtent(
          state,
          streamToken,
          value.streamLength ?? { kind: 'missing' },
        );
        if (extent === null) break;
        if (
          value.objectStreamDictionary &&
          !scanRawPdfObjectStream(state, value, extent)
        ) {
          break;
        }
        if (
          !value.objectStreamDictionary &&
          !rawPdfOrdinaryStreamResourceSafe(state, value, extent)
        ) {
          break;
        }
        index = extent.end;
      }
      continue;
    }

    const value = parseRawPdfValueFromToken(state, token, 0);
    if (value === null) break;
    index = value.end;
    if (value.kind !== 'dictionary') continue;
    const next = nextRawPdfToken(state, value.end);
    if (next === null || !rawPdfWordEquals(bytes, next, STREAM_BYTES)) continue;
    if (value.objectStreamDictionary) {
      state.issues.add('object_stream_not_indirect');
      break;
    }
    const extent = rawPdfStreamExtent(
      state,
      next,
      value.streamLength ?? { kind: 'missing' },
    );
    if (extent === null) break;
    if (!rawPdfOrdinaryStreamResourceSafe(state, value, extent)) {
      break;
    }
    index = extent.end;
  }

  if (markerCount > MAX_PDF_HISTORY_REVISIONS) {
    state.issues.add('revision_candidate_limit_exceeded');
  }
  const markedXrefOffsets = new Set(
    candidates.map(({ xrefOffset }) => xrefOffset),
  );
  const classicXrefOffsets = new Set(state.classicXrefOffsets);
  const xrefStreamOffsets = new Set(state.xrefStreamOffsets);
  if (
    state.classicXrefOffsets.some((offset) => !markedXrefOffsets.has(offset))
  ) {
    state.issues.add('unmarked_classic_xref_section');
  }
  if (
    [...markedXrefOffsets].some(
      (offset) =>
        !classicXrefOffsets.has(offset) && !xrefStreamOffsets.has(offset),
    )
  ) {
    state.issues.add('xref_target_unrecognized');
  }
  const unmarkedXrefStreams = state.xrefStreamOffsets.filter(
    (offset) => !markedXrefOffsets.has(offset),
  );
  let linearizedMainXrefOffset = state.linearization?.mainXrefOffset ?? -1;
  while (
    linearizedMainXrefOffset >= 0 &&
    linearizedMainXrefOffset < bytes.length &&
    isPdfWhitespace(bytes[linearizedMainXrefOffset])
  ) {
    linearizedMainXrefOffset += 1;
  }
  const allowedLinearizedXrefStream =
    state.linearizedPseudoMarkerCount === 1 &&
    unmarkedXrefStreams.includes(linearizedMainXrefOffset)
      ? linearizedMainXrefOffset
      : null;
  if (
    unmarkedXrefStreams.some((offset) => offset !== allowedLinearizedXrefStream)
  ) {
    state.issues.add('unmarked_xref_stream');
  }

  if (state.linearizedPseudoMarkerCount > 0) {
    const originalBoundary =
      state.linearization === null
        ? undefined
        : candidates.find(
            ({ end }) =>
              end <= state.linearization!.length &&
              onlyPdfWhitespaceRange(bytes, end, state.linearization!.length),
          );
    const linearizationVerified =
      state.linearization !== null &&
      state.linearizedPseudoMarkerCount === 1 &&
      state.linearizedPseudoMarkerStart !== null &&
      state.linearizedPseudoMarkerEnd !== null &&
      state.linearizedPseudoMarkerEnd < state.linearization.firstPageEnd &&
      originalBoundary !== undefined &&
      originalBoundary.xrefOffset < state.linearizedPseudoMarkerStart &&
      allowedLinearizedXrefStream !== null &&
      state.xrefStreamPrevOffsets.get(originalBoundary.xrefOffset) ===
        allowedLinearizedXrefStream;
    if (!linearizationVerified) {
      state.issues.add('linearized_boundary_unverified');
    }
  }
  return {
    candidates,
    markerCount,
    complete: state.issues.size === 0,
    issues: [...state.issues].sort(),
  };
}

function findPdfRevisionCandidates(bytes: Uint8Array): RawPdfRevisionScan {
  const scan = scanRawPdfRevisions(bytes, firstRawPdfLinearization(bytes));
  if (scan.markerCount > MAX_PDF_HISTORY_REVISIONS) {
    return {
      ...scan,
      candidates: scan.candidates.slice(0, MAX_PDF_HISTORY_REVISIONS),
    };
  }
  return scan;
}

function preflightPdfBytes(bytes: Uint8Array): RawPdfRevisionScan {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_SOURCE_BYTES) {
    throw new PdfEngineError(
      'PDF_RESOURCE_LIMIT_EXCEEDED',
      'The PDF exceeds the supported source-byte budget.',
    );
  }
  const scan = findPdfRevisionCandidates(bytes);
  const resourceIssue = scan.issues.find((issue) =>
    RAW_PDF_RESOURCE_ISSUES.has(issue),
  );
  if (resourceIssue !== undefined) {
    throw new PdfEngineError(
      'PDF_RESOURCE_LIMIT_EXCEEDED',
      'The PDF contains a compressed or structural stream that exceeds the bounded parser budget.',
    );
  }
  return scan;
}

function onlyPdfWhitespace(bytes: Uint8Array, start: number): boolean {
  for (let index = start; index < bytes.length; index += 1) {
    if (!isPdfWhitespace(bytes[index])) return false;
  }
  return true;
}

function onlyPdfWhitespaceRange(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  if (start < 0 || end < start || end > bytes.length) return false;
  for (let index = start; index < end; index += 1) {
    if (!isPdfWhitespace(bytes[index])) return false;
  }
  return true;
}

function signatureByteRangeFingerprint(
  signature: PdfSignatureFingerprint,
): string | null {
  if (signature.byteRangeRaw.kind === 'missing') return null;
  return JSON.stringify([
    signature.byteRangeRaw,
    signature.byteRangeElementRaw,
    signature.resolvedByteRange,
  ]);
}

async function inspectPdfRevisionHistory(
  bytes: Uint8Array,
  currentDocument: PDFDocument,
  preflightScan?: RawPdfRevisionScan,
): Promise<PdfRevisionHistorySummary> {
  const scan = preflightScan ?? findPdfRevisionCandidates(bytes);
  const { candidates, markerCount } = scan;
  const issues = new Set(scan.issues);
  const currentSnapshot = await fingerprintPdfSignatures(currentDocument);
  const currentSignatures = new Map(
    currentSnapshot.signatures.map((signature) => [
      signature.identity,
      signature,
    ]),
  );
  const byteRangeIdentities = new Set(
    currentSnapshot.signatures
      .filter((signature) => signature.byteRangeRaw.kind !== 'missing')
      .map((signature) => signature.identity),
  );
  const historicalByteRangeMismatches = new Set<string>();
  const historicalSignatureMismatches = new Set<string>();
  if (!currentSnapshot.complete) {
    issues.add('current_signature_fingerprint_inconclusive');
  }

  if (candidates.length === 0) issues.add('revision_marker_missing');
  if (markerCount > MAX_PDF_HISTORY_REVISIONS) {
    issues.add('revision_candidate_limit_exceeded');
  }
  const finalCandidate = candidates.at(-1);
  if (
    finalCandidate === undefined ||
    !onlyPdfWhitespace(bytes, finalCandidate.end)
  ) {
    issues.add('final_revision_boundary_unverified');
  }

  if (markerCount <= MAX_PDF_HISTORY_REVISIONS) {
    let parsedBytes = 0;
    for (const candidate of candidates.slice(0, -1)) {
      parsedBytes += candidate.end;
      if (parsedBytes > MAX_PDF_HISTORY_PARSE_BYTES) {
        issues.add('revision_parse_byte_budget_exceeded');
        break;
      }
      try {
        const revision = await PDFDocument.load(
          copyBytes(bytes.subarray(0, candidate.end)),
          { updateMetadata: false },
        );
        const historicalSnapshot = await fingerprintPdfSignatures(revision);
        if (!historicalSnapshot.complete) {
          issues.add('revision_signature_fingerprint_inconclusive');
        }
        for (const historical of historicalSnapshot.signatures) {
          const historicalRange = signatureByteRangeFingerprint(historical);
          if (historicalRange !== null) {
            byteRangeIdentities.add(historical.identity);
          }
          const current = currentSignatures.get(historical.identity);
          if (
            historicalRange !== null &&
            (current === undefined ||
              signatureByteRangeFingerprint(current) !== historicalRange)
          ) {
            historicalByteRangeMismatches.add(historical.identity);
          }
          if (
            historical.fingerprint === null ||
            current?.fingerprint === null ||
            current === undefined ||
            current.fingerprint !== historical.fingerprint
          ) {
            historicalSignatureMismatches.add(historical.identity);
          }
        }
      } catch {
        issues.add('revision_prefix_parse_failed');
      }
    }
  }

  return {
    byteRangeNameCount: byteRangeIdentities.size,
    historicalByteRangeNameCount: historicalByteRangeMismatches.size,
    historicalSignatureStructureCount: historicalSignatureMismatches.size,
    revisionMarkerCount: markerCount,
    complete: issues.size === 0,
    issues: [...issues].sort(),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PdfEngineError(
      'CRYPTO_UNAVAILABLE',
      'SHA-256 is unavailable in this browser context.',
    );
  }

  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function collectPdfDictionaries(document: PDFDocument): PDFDict[] {
  const dictionaries: PDFDict[] = [];
  const seen = new Set<PDFObject>();
  const pending: PDFObject[] = [document.catalog];
  let edgeCount = 0;
  const enqueue = (object: PDFObject): void => {
    edgeCount += 1;
    if (edgeCount > MAX_PDF_OBJECT_GRAPH_EDGES) {
      malformedPdfObjectGraph('edge_limit_exceeded');
    }
    pending.push(object);
  };

  while (pending.length > 0) {
    const object = pending.pop();
    if (object === undefined || seen.has(object)) continue;
    if (seen.size >= MAX_PDF_OBJECT_GRAPH_NODES) {
      malformedPdfObjectGraph('node_limit_exceeded');
    }
    seen.add(object);

    if (object instanceof PDFRef) {
      enqueue(requiredGraphLookup(document, object));
    } else if (object instanceof PDFStream) {
      enqueue(object.dict);
    } else if (object instanceof PDFDict) {
      dictionaries.push(object);
      for (const value of object.values()) enqueue(value);
    } else if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index += 1) {
        enqueue(object.get(index));
      }
    }
  }

  return dictionaries;
}

function collectUnreachableSignatureDictionaries(
  document: PDFDocument,
  reachableDictionaries: readonly PDFDict[],
): PDFDict[] {
  const reachable = new Set(reachableDictionaries);
  const seen = new Set<PDFObject>();
  const unreachable: PDFDict[] = [];
  let edgeCount = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    const pending: PDFObject[] = [object];
    const enqueue = (candidate: PDFObject): void => {
      edgeCount += 1;
      if (edgeCount > MAX_PDF_OBJECT_GRAPH_EDGES) {
        malformedPdfObjectGraph('unreachable_edge_limit_exceeded');
      }
      pending.push(candidate);
    };
    while (pending.length > 0) {
      const candidate = pending.pop();
      if (
        candidate === undefined ||
        candidate instanceof PDFRef ||
        seen.has(candidate)
      ) {
        continue;
      }
      if (seen.size >= MAX_PDF_OBJECT_GRAPH_NODES) {
        malformedPdfObjectGraph('unreachable_node_limit_exceeded');
      }
      seen.add(candidate);
      if (candidate instanceof PDFStream) {
        enqueue(candidate.dict);
      } else if (candidate instanceof PDFArray) {
        for (let index = 0; index < candidate.size(); index += 1) {
          enqueue(candidate.get(index));
        }
      } else if (candidate instanceof PDFDict) {
        if (
          !reachable.has(candidate) &&
          (dictionaryName(candidate, 'Type') === 'Sig' ||
            candidate.has(PDFName.of('ByteRange')))
        ) {
          unreachable.push(candidate);
        }
        for (const value of candidate.values()) enqueue(value);
      }
    }
  }
  return unreachable;
}

function dictionaryName(dictionary: PDFDict, key: string): string | null {
  const value = dictionary.context.lookup(dictionary.get(PDFName.of(key)));
  return value instanceof PDFName ? value.decodeText() : null;
}

function malformedPdfObjectGraph(reason: string, cause?: unknown): never {
  throw new PdfEngineError(
    'PDF_LOAD_FAILED',
    'The PDF object graph is malformed or exceeds inspection limits.',
    { details: { hierarchy: 'pdf_object_graph', reason }, cause },
  );
}

function requiredGraphLookup(
  document: PDFDocument,
  reference: PDFRef,
): PDFObject {
  let resolved: PDFObject | undefined;
  try {
    resolved = document.context.lookup(reference);
  } catch (cause) {
    malformedPdfObjectGraph('reference_lookup_failed', cause);
  }
  if (resolved === undefined) {
    malformedPdfObjectGraph('reference_unresolved');
  }
  return resolved;
}

function malformedPdfHierarchy(
  hierarchy: 'acroform_fields' | 'page_tree',
  reason: string,
): never {
  throw new PdfEngineError(
    'PDF_LOAD_FAILED',
    hierarchy === 'acroform_fields'
      ? 'The PDF AcroForm field hierarchy is malformed.'
      : 'The PDF page tree is malformed.',
    { details: { hierarchy, reason } },
  );
}

function lookedUpObject(
  document: PDFDocument,
  object: PDFObject | undefined,
): PDFObject | undefined {
  try {
    return document.context.lookup(object);
  } catch {
    return undefined;
  }
}

interface PendingPageTreeNode {
  readonly depth: number;
  readonly dictionary: PDFDict;
  readonly parentRef: PDFRef | null;
  readonly ref: PDFRef;
}

interface ValidatedPageTreeNode {
  readonly childRefs: readonly PDFRef[];
  readonly declaredCount: number | null;
  readonly ref: PDFRef;
  readonly type: 'Page' | 'Pages';
}

function validatePageTree(document: PDFDocument): void {
  const rawRoot = document.catalog.get(PDFName.of('Pages'));
  if (!(rawRoot instanceof PDFRef)) {
    malformedPdfHierarchy('page_tree', 'catalog_pages_not_indirect_reference');
  }
  const root = lookedUpObject(document, rawRoot);
  if (!(root instanceof PDFDict)) {
    malformedPdfHierarchy('page_tree', 'catalog_pages_not_dictionary');
  }

  const discovered = new Set<string>([rawRoot.toString()]);
  const pending: PendingPageTreeNode[] = [
    { depth: 0, dictionary: root, parentRef: null, ref: rawRoot },
  ];
  const nodes: ValidatedPageTreeNode[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current.depth > MAX_PAGE_TREE_DEPTH) {
      malformedPdfHierarchy('page_tree', 'depth_limit_exceeded');
    }
    if (nodes.length >= MAX_PAGE_TREE_NODES) {
      malformedPdfHierarchy('page_tree', 'node_limit_exceeded');
    }

    const rawParent = current.dictionary.get(PDFName.of('Parent'));
    if (current.parentRef === null) {
      if (rawParent !== undefined) {
        malformedPdfHierarchy('page_tree', 'root_parent_present');
      }
    } else if (
      !(rawParent instanceof PDFRef) ||
      rawParent.toString() !== current.parentRef.toString()
    ) {
      malformedPdfHierarchy('page_tree', 'child_parent_mismatch');
    }

    const type = dictionaryName(current.dictionary, 'Type');
    if (type === 'Page') {
      if (current.dictionary.has(PDFName.of('Kids'))) {
        malformedPdfHierarchy('page_tree', 'page_leaf_has_kids');
      }
      nodes.push({
        childRefs: [],
        declaredCount: null,
        ref: current.ref,
        type,
      });
      continue;
    }
    if (type !== 'Pages') {
      malformedPdfHierarchy('page_tree', 'node_type_unrecognized');
    }

    const rawKids = current.dictionary.get(PDFName.of('Kids'));
    const kids = lookedUpObject(document, rawKids);
    if (!(kids instanceof PDFArray)) {
      malformedPdfHierarchy('page_tree', 'kids_not_array');
    }
    const rawCount = lookedUpObject(
      document,
      current.dictionary.get(PDFName.of('Count')),
    );
    const declaredCount =
      rawCount instanceof PDFNumber ? rawCount.asNumber() : Number.NaN;
    if (!Number.isSafeInteger(declaredCount) || declaredCount < 0) {
      malformedPdfHierarchy('page_tree', 'count_invalid');
    }

    const children: PendingPageTreeNode[] = [];
    for (let index = 0; index < kids.size(); index += 1) {
      const childRef = kids.get(index);
      if (!(childRef instanceof PDFRef)) {
        malformedPdfHierarchy('page_tree', 'kid_not_indirect_reference');
      }
      const key = childRef.toString();
      if (discovered.has(key)) {
        malformedPdfHierarchy('page_tree', 'duplicate_or_cyclic_kid');
      }
      if (discovered.size >= MAX_PAGE_TREE_NODES) {
        malformedPdfHierarchy('page_tree', 'node_limit_exceeded');
      }
      const child = lookedUpObject(document, childRef);
      if (!(child instanceof PDFDict)) {
        malformedPdfHierarchy('page_tree', 'kid_not_dictionary');
      }
      discovered.add(key);
      children.push({
        depth: current.depth + 1,
        dictionary: child,
        parentRef: current.ref,
        ref: childRef,
      });
    }
    nodes.push({
      childRefs: children.map(({ ref }) => ref),
      declaredCount,
      ref: current.ref,
      type,
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }

  const leafCounts = new Map<string, number>();
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.type === 'Page') {
      leafCounts.set(node.ref.toString(), 1);
      continue;
    }
    let actualCount = 0;
    for (const childRef of node.childRefs) {
      const childCount = leafCounts.get(childRef.toString());
      if (childCount === undefined) {
        malformedPdfHierarchy('page_tree', 'kid_count_unavailable');
      }
      actualCount += childCount;
      if (!Number.isSafeInteger(actualCount)) {
        malformedPdfHierarchy('page_tree', 'count_overflow');
      }
    }
    if (node.declaredCount !== actualCount) {
      malformedPdfHierarchy('page_tree', 'count_mismatch');
    }
    leafCounts.set(node.ref.toString(), actualCount);
  }
}

interface PendingAcroFormFieldNode {
  readonly depth: number;
  readonly dictionary: PDFDict;
  readonly parentRef: PDFRef | null;
  readonly ref: PDFRef;
}

function validateAcroFormFieldGraph(
  document: PDFDocument,
): ReadonlySet<PDFDict> {
  const fieldAndWidgetDictionaries = new Set<PDFDict>();
  const rawAcroForm = document.catalog.get(PDFName.of('AcroForm'));
  if (rawAcroForm === undefined) return fieldAndWidgetDictionaries;
  const acroForm = lookedUpObject(document, rawAcroForm);
  if (!(acroForm instanceof PDFDict)) {
    malformedPdfHierarchy('acroform_fields', 'acroform_not_dictionary');
  }

  const rawFields = acroForm.get(PDFName.of('Fields'));
  if (rawFields === undefined) return fieldAndWidgetDictionaries;
  const fields = lookedUpObject(document, rawFields);
  if (!(fields instanceof PDFArray)) {
    malformedPdfHierarchy('acroform_fields', 'fields_not_array');
  }

  const discovered = new Set<string>();
  const pending: PendingAcroFormFieldNode[] = [];
  const discover = (
    object: PDFObject,
    depth: number,
    parentRef: PDFRef | null,
  ): PendingAcroFormFieldNode => {
    if (!(object instanceof PDFRef)) {
      malformedPdfHierarchy('acroform_fields', 'field_not_indirect_reference');
    }
    const key = object.toString();
    if (discovered.has(key)) {
      malformedPdfHierarchy(
        'acroform_fields',
        'duplicate_or_cyclic_field_reference',
      );
    }
    if (discovered.size >= MAX_ACROFORM_FIELD_GRAPH_NODES) {
      malformedPdfHierarchy('acroform_fields', 'node_limit_exceeded');
    }
    if (depth > MAX_ACROFORM_FIELD_GRAPH_DEPTH) {
      malformedPdfHierarchy('acroform_fields', 'depth_limit_exceeded');
    }
    const dictionary = lookedUpObject(document, object);
    if (!(dictionary instanceof PDFDict)) {
      malformedPdfHierarchy('acroform_fields', 'field_not_dictionary');
    }
    discovered.add(key);
    fieldAndWidgetDictionaries.add(dictionary);
    return { depth, dictionary, parentRef, ref: object };
  };

  for (let index = fields.size() - 1; index >= 0; index -= 1) {
    pending.push(discover(fields.get(index), 0, null));
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;

    const rawParent = current.dictionary.get(PDFName.of('Parent'));
    if (current.parentRef === null) {
      if (rawParent !== undefined) {
        malformedPdfHierarchy('acroform_fields', 'root_parent_present');
      }
    } else if (
      !(rawParent instanceof PDFRef) ||
      rawParent.toString() !== current.parentRef.toString()
    ) {
      malformedPdfHierarchy('acroform_fields', 'child_parent_mismatch');
    }

    if (!current.dictionary.has(PDFName.of('Kids'))) continue;
    const kids = lookedUpObject(
      document,
      current.dictionary.get(PDFName.of('Kids')),
    );
    if (!(kids instanceof PDFArray)) {
      malformedPdfHierarchy('acroform_fields', 'kids_not_array');
    }

    const children: PendingAcroFormFieldNode[] = [];
    let containsChildField = false;
    for (let index = 0; index < kids.size(); index += 1) {
      const child = discover(kids.get(index), current.depth + 1, current.ref);
      const rawChildParent = child.dictionary.get(PDFName.of('Parent'));
      if (
        !(rawChildParent instanceof PDFRef) ||
        rawChildParent.toString() !== current.ref.toString()
      ) {
        malformedPdfHierarchy('acroform_fields', 'child_parent_mismatch');
      }
      if (child.dictionary.has(PDFName.of('T'))) {
        containsChildField = true;
      } else if (child.dictionary.has(PDFName.of('Kids'))) {
        malformedPdfHierarchy('acroform_fields', 'widget_kid_has_kids');
      }
      children.push(child);
    }
    if (!containsChildField) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  return fieldAndWidgetDictionaries;
}

interface ActionGraphFrame {
  readonly depth: number;
  readonly expectation: 'action' | 'action_or_array';
  readonly object: PDFObject;
  readonly parent: ActionGraphFrame | null;
  readonly rootPath: boolean;
  phase: 'enter' | 'exit';
  valid: boolean;
}

interface ReferencedActionSummary {
  readonly actions: ReadonlySet<PDFDict>;
  readonly triggers: ReadonlyMap<PDFDict, ReadonlySet<PdfActionTriggerKind>>;
  readonly malformedActionGraphCount: number;
}

const ACTION_ANNOTATION_SUBTYPES = new Set([
  'Text',
  'Link',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'FileAttachment',
  'Sound',
  'Movie',
  'Widget',
  'Screen',
  'PrinterMark',
  'TrapNet',
  'Watermark',
  '3D',
  'Redact',
  'Projection',
  'RichMedia',
]);

function dictionaryOwnsActionEntry(
  document: PDFDocument,
  dictionary: PDFDict,
  fieldAndWidgetDictionaries: ReadonlySet<PDFDict>,
): boolean {
  if (
    dictionary === document.catalog ||
    fieldAndWidgetDictionaries.has(dictionary) ||
    dictionaryName(dictionary, 'Type') === 'Annot' ||
    dictionaryName(dictionary, 'Type') === 'Page'
  ) {
    return true;
  }
  const subtype = dictionaryName(dictionary, 'Subtype');
  return (
    (subtype !== null && ACTION_ANNOTATION_SUBTYPES.has(subtype)) ||
    (dictionary.has(PDFName.of('Title')) &&
      dictionary.has(PDFName.of('Parent')))
  );
}

function isDirectActionDictionary(
  document: PDFDocument,
  object: PDFObject | undefined,
): boolean {
  const seenRefs = new Set<string>();
  let candidate = object;
  for (let depth = 0; candidate instanceof PDFRef; depth += 1) {
    if (depth > MAX_ACTION_GRAPH_DEPTH || seenRefs.has(candidate.toString())) {
      return false;
    }
    seenRefs.add(candidate.toString());
    candidate = lookedUpObject(document, candidate);
  }
  return (
    candidate instanceof PDFDict && dictionaryName(candidate, 'S') !== null
  );
}

function isOpenActionDestination(
  document: PDFDocument,
  object: PDFObject,
): boolean {
  const seenRefs = new Set<string>();
  let candidate: PDFObject | undefined = object;
  for (let depth = 0; candidate instanceof PDFRef; depth += 1) {
    if (depth > MAX_ACTION_GRAPH_DEPTH || seenRefs.has(candidate.toString())) {
      return false;
    }
    seenRefs.add(candidate.toString());
    candidate = lookedUpObject(document, candidate);
  }
  if (!(candidate instanceof PDFArray) || candidate.size() < 2) return false;

  const page = lookedUpObject(document, candidate.get(0));
  const destinationType = lookedUpObject(document, candidate.get(1));
  if (
    !(page instanceof PDFDict) ||
    dictionaryName(page, 'Type') !== 'Page' ||
    !(destinationType instanceof PDFName)
  ) {
    return false;
  }

  const parameterCounts: Readonly<Record<string, number>> = {
    XYZ: 3,
    Fit: 0,
    FitH: 1,
    FitV: 1,
    FitR: 4,
    FitB: 0,
    FitBH: 1,
    FitBV: 1,
  };
  const parameterCount = parameterCounts[destinationType.decodeText()];
  if (parameterCount === undefined || candidate.size() !== parameterCount + 2) {
    return false;
  }
  for (let index = 2; index < candidate.size(); index += 1) {
    const parameter = lookedUpObject(document, candidate.get(index));
    if (!(parameter instanceof PDFNumber) && parameter !== PDFNull) {
      return false;
    }
  }
  return true;
}

function explicitlyReferencedActions(
  document: PDFDocument,
  dictionaries: readonly PDFDict[],
  fieldAndWidgetDictionaries: ReadonlySet<PDFDict>,
): ReferencedActionSummary {
  const actions = new Set<PDFDict>();
  const triggers = new Map<PDFDict, Set<PdfActionTriggerKind>>();
  let malformedActionGraphCount = 0;
  let traversedEdgeCount = 0;
  let traversedNodeCount = 0;
  const reserveEdges = (count: number): boolean => {
    if (count > MAX_ACTION_GRAPH_EDGES - traversedEdgeCount) return false;
    traversedEdgeCount += count;
    return true;
  };

  const addAction = (
    object: PDFObject | undefined,
    allowRootArray: boolean,
    trigger: PdfActionTriggerKind,
  ): void => {
    if (object === undefined) return;
    let rootKind: 'array' | 'dictionary' | 'invalid' | null = null;
    const completed = new Map<
      PDFObject,
      Partial<Record<ActionGraphFrame['expectation'], boolean>>
    >();
    const visiting = new Set<PDFObject>();
    const root: ActionGraphFrame = {
      depth: 0,
      expectation: 'action_or_array',
      object,
      parent: null,
      rootPath: true,
      phase: 'enter',
      valid: true,
    };
    const pending: ActionGraphFrame[] = [root];

    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined) continue;
      if (frame.phase === 'exit') {
        visiting.delete(frame.object);
        const state = completed.get(frame.object) ?? {};
        state[frame.expectation] = frame.valid;
        completed.set(frame.object, state);
        if (!frame.valid && frame.parent !== null) frame.parent.valid = false;
        continue;
      }

      const cached = completed.get(frame.object)?.[frame.expectation];
      if (cached !== undefined) {
        if (!cached) {
          frame.valid = false;
          if (frame.parent !== null) frame.parent.valid = false;
        }
        continue;
      }
      if (
        visiting.has(frame.object) ||
        frame.depth > MAX_ACTION_GRAPH_DEPTH ||
        traversedNodeCount >= MAX_ACTION_GRAPH_NODES
      ) {
        frame.valid = false;
        if (frame.parent !== null) frame.parent.valid = false;
        continue;
      }

      traversedNodeCount += 1;
      visiting.add(frame.object);
      frame.phase = 'exit';
      pending.push(frame);

      if (frame.object instanceof PDFRef) {
        const resolved = lookedUpObject(document, frame.object);
        if (resolved === undefined || !reserveEdges(1)) {
          frame.valid = false;
        } else {
          pending.push({
            depth: frame.depth + 1,
            expectation: frame.expectation,
            object: resolved,
            parent: frame,
            rootPath: frame.rootPath,
            phase: 'enter',
            valid: true,
          });
        }
        continue;
      }

      if (frame.object instanceof PDFArray) {
        if (frame.rootPath) rootKind = 'array';
        if (frame.expectation === 'action' || frame.object.size() === 0) {
          frame.valid = false;
        }
        if (!reserveEdges(frame.object.size())) {
          frame.valid = false;
          continue;
        }
        for (let index = frame.object.size() - 1; index >= 0; index -= 1) {
          pending.push({
            depth: frame.depth + 1,
            expectation: 'action',
            object: frame.object.get(index),
            parent: frame,
            rootPath: false,
            phase: 'enter',
            valid: true,
          });
        }
        continue;
      }

      if (frame.object instanceof PDFDict) {
        if (frame.rootPath) rootKind = 'dictionary';
        if (dictionaryName(frame.object, 'S') === null) {
          frame.valid = false;
          continue;
        }
        actions.add(frame.object);
        const actionTriggers = triggers.get(frame.object) ?? new Set();
        actionTriggers.add(trigger);
        triggers.set(frame.object, actionTriggers);
        if (frame.object.has(PDFName.of('Next'))) {
          if (!reserveEdges(1)) {
            frame.valid = false;
          } else {
            pending.push({
              depth: frame.depth + 1,
              expectation: 'action_or_array',
              object: frame.object.get(PDFName.of('Next'))!,
              parent: frame,
              rootPath: false,
              phase: 'enter',
              valid: true,
            });
          }
        }
        continue;
      }

      if (frame.rootPath) rootKind = 'invalid';
      frame.valid = false;
    }

    if (!root.valid || rootKind === 'invalid' || rootKind === null) {
      malformedActionGraphCount += 1;
    } else if (rootKind === 'array' && !allowRootArray) {
      malformedActionGraphCount += 1;
    }
  };

  for (const dictionary of dictionaries) {
    const ownsActionEntry = dictionaryOwnsActionEntry(
      document,
      dictionary,
      fieldAndWidgetDictionaries,
    );
    if (dictionary.has(PDFName.of('A'))) {
      const action = dictionary.get(PDFName.of('A'));
      if (ownsActionEntry || isDirectActionDictionary(document, action)) {
        addAction(action, false, 'direct_action');
      }
    }
    if (dictionary.has(PDFName.of('NA'))) {
      const action = dictionary.get(PDFName.of('NA'));
      if (ownsActionEntry || isDirectActionDictionary(document, action)) {
        addAction(action, false, 'direct_action');
      }
    }
    if (dictionary.has(PDFName.of('AA'))) {
      const additionalActions = lookedUpObject(
        document,
        dictionary.get(PDFName.of('AA')),
      );
      if (additionalActions instanceof PDFDict) {
        for (const action of additionalActions.values()) {
          if (ownsActionEntry || isDirectActionDictionary(document, action)) {
            addAction(action, false, 'additional_action');
          }
        }
      } else if (ownsActionEntry) {
        malformedActionGraphCount += 1;
      }
    }
  }
  if (document.catalog.has(PDFName.of('OpenAction'))) {
    const openAction = document.catalog.get(PDFName.of('OpenAction'));
    if (
      openAction !== undefined &&
      !isOpenActionDestination(document, openAction)
    ) {
      addAction(openAction, false, 'open_action');
    }
  }

  const names = lookedUpObject(
    document,
    document.catalog.get(PDFName.of('Names')),
  );
  const javaScriptEntry =
    names instanceof PDFDict ? names.get(PDFName.of('JavaScript')) : undefined;
  const javaScriptNameTree = lookedUpObject(document, javaScriptEntry);
  if (
    javaScriptEntry !== undefined &&
    !(javaScriptNameTree instanceof PDFDict)
  ) {
    malformedActionGraphCount += 1;
  }
  const seenNameTrees = new Set<PDFDict>();
  const queuedNameTrees = new Set<PDFDict>();
  const pendingNameTrees: Array<{
    readonly depth: number;
    readonly tree: PDFDict;
  }> = [];
  if (javaScriptNameTree instanceof PDFDict) {
    queuedNameTrees.add(javaScriptNameTree);
    pendingNameTrees.push({ depth: 0, tree: javaScriptNameTree });
  }
  while (pendingNameTrees.length > 0) {
    const current = pendingNameTrees.pop();
    if (current === undefined) continue;
    const { depth, tree } = current;
    if (
      seenNameTrees.has(tree) ||
      depth > MAX_ACTION_GRAPH_DEPTH ||
      traversedNodeCount >= MAX_ACTION_GRAPH_NODES
    ) {
      malformedActionGraphCount += 1;
      continue;
    }
    traversedNodeCount += 1;
    seenNameTrees.add(tree);

    const rawEntries = tree.get(PDFName.of('Names'));
    const entries = lookedUpObject(document, rawEntries);
    if (entries instanceof PDFArray) {
      if (entries.size() % 2 !== 0) malformedActionGraphCount += 1;
      for (let index = 1; index < entries.size(); index += 2) {
        addAction(entries.get(index), false, 'javascript_name_tree');
      }
    } else if (rawEntries !== undefined) {
      malformedActionGraphCount += 1;
    }
    const rawKids = tree.get(PDFName.of('Kids'));
    const kids = lookedUpObject(document, rawKids);
    if (kids instanceof PDFArray) {
      if (!reserveEdges(kids.size())) {
        malformedActionGraphCount += 1;
      } else {
        for (let index = 0; index < kids.size(); index += 1) {
          const child = lookedUpObject(document, kids.get(index));
          if (!(child instanceof PDFDict)) {
            malformedActionGraphCount += 1;
          } else if (queuedNameTrees.has(child)) {
            malformedActionGraphCount += 1;
          } else {
            queuedNameTrees.add(child);
            pendingNameTrees.push({ depth: depth + 1, tree: child });
          }
        }
      }
    } else if (rawKids !== undefined) {
      malformedActionGraphCount += 1;
    }
  }

  return { actions, triggers, malformedActionGraphCount };
}

function resolvedObject(
  dictionary: PDFDict,
  key: string,
): PDFObject | undefined {
  return dictionary.context.lookup(dictionary.get(PDFName.of(key)));
}

function dictionaryNumber(dictionary: PDFDict, key: string): number | null {
  const value = resolvedObject(dictionary, key);
  return value instanceof PDFNumber ? value.asNumber() : null;
}

function byteRange(
  dictionary: PDFDict,
): readonly [number, number, number, number] | null {
  const value = resolvedObject(dictionary, 'ByteRange');
  if (!(value instanceof PDFArray) || value.size() !== 4) return null;
  const numbers: number[] = [];
  for (let index = 0; index < value.size(); index += 1) {
    const item = value.lookup(index);
    if (!(item instanceof PDFNumber)) return null;
    const number = item.asNumber();
    if (!Number.isSafeInteger(number) || number < 0) return null;
    numbers.push(number);
  }
  return numbers as [number, number, number, number];
}

function byteRangeIsSane(
  range: readonly [number, number, number, number],
  sourceByteLength: number,
): boolean {
  const [firstOffset, firstLength, secondOffset, secondLength] = range;
  return (
    firstOffset === 0 &&
    firstLength > 0 &&
    secondOffset > firstOffset + firstLength &&
    secondLength > 0 &&
    secondOffset + secondLength <= sourceByteLength
  );
}

function byteRangeCoversWholeFile(
  range: readonly [number, number, number, number],
  sourceByteLength: number,
): boolean {
  return (
    byteRangeIsSane(range, sourceByteLength) &&
    range[2] + range[3] === sourceByteLength
  );
}

function signatureContentsPresent(signature: PDFDict): boolean {
  const contents = resolvedObject(signature, 'Contents');
  return (
    (contents instanceof PDFHexString || contents instanceof PDFString) &&
    contents.asBytes().length > 0
  );
}

function recognizedSignatureStructure(
  signature: PDFDict,
  sourceByteLength: number,
): boolean {
  const range = byteRange(signature);
  return (
    dictionaryName(signature, 'Type') === 'Sig' &&
    range !== null &&
    byteRangeIsSane(range, sourceByteLength) &&
    signatureContentsPresent(signature)
  );
}

interface SignatureReferenceList {
  readonly present: boolean;
  readonly valid: boolean;
  readonly references: readonly PDFDict[];
}

function signatureReferenceList(signature: PDFDict): SignatureReferenceList {
  if (!signature.has(PDFName.of('Reference'))) {
    return { present: false, valid: true, references: [] };
  }
  const references = resolvedObject(signature, 'Reference');
  if (!(references instanceof PDFArray) || references.size() === 0) {
    return { present: true, valid: false, references: [] };
  }
  const output: PDFDict[] = [];
  for (let index = 0; index < references.size(); index += 1) {
    const reference = references.get(index);
    if (!(reference instanceof PDFDict)) {
      return { present: true, valid: false, references: output };
    }
    output.push(reference);
  }
  return { present: true, valid: true, references: output };
}

const SIGNATURE_REFERENCE_KEYS = new Set([
  'Type',
  'TransformMethod',
  'TransformParams',
  'Data',
  'DigestMethod',
  'DigestValue',
  'DigestLocation',
]);
const KNOWN_TRANSFORM_METHODS = new Set([
  'UR',
  'UR3',
  'DocMDP',
  'FieldMDP',
  'Identity',
]);
const TRANSFORM_METHOD_LABELS: Readonly<Record<string, string>> = {
  UR: 'ur',
  UR3: 'ur3',
  DocMDP: 'doc_mdp',
  FieldMDP: 'field_mdp',
  Identity: 'identity',
};
const USAGE_RIGHTS_PARAMETER_KEYS = new Set([
  'Type',
  'V',
  'Document',
  'Msg',
  'Annots',
  'Form',
  'Signature',
  'EF',
  'P',
]);
const DOC_MDP_PARAMETER_KEYS = new Set(['Type', 'P', 'V']);
const FIELD_MDP_PARAMETER_KEYS = new Set(['Type', 'Action', 'Fields', 'V']);
const USAGE_RIGHTS_VALUES = {
  Document: new Set(['FullSave']),
  Annots: new Set([
    'Create',
    'Delete',
    'Modify',
    'Copy',
    'Import',
    'Export',
    'Online',
  ]),
  Form: new Set([
    'Add',
    'Delete',
    'FillIn',
    'Import',
    'Export',
    'SubmitStandalone',
    'SpawnTemplate',
    'BarcodePlaintext',
    'Online',
  ]),
  Signature: new Set(['Modify']),
  EF: new Set(['Create', 'Delete', 'Modify', 'Import']),
} as const;

function dictionaryHasOnlyKeys(
  dictionary: PDFDict,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return dictionary.keys().every((key) => allowedKeys.has(key.decodeText()));
}

function optionalNameEquals(
  dictionary: PDFDict,
  key: string,
  expected: string,
): boolean {
  return (
    !dictionary.has(PDFName.of(key)) ||
    dictionaryName(dictionary, key) === expected
  );
}

function nameArrayUsesOnly(
  dictionary: PDFDict,
  key: keyof typeof USAGE_RIGHTS_VALUES,
): boolean {
  if (!dictionary.has(PDFName.of(key))) return true;
  const value = resolvedObject(dictionary, key);
  if (!(value instanceof PDFArray) || value.size() === 0) return false;
  for (let index = 0; index < value.size(); index += 1) {
    const item = value.lookup(index);
    if (
      !(item instanceof PDFName) ||
      !USAGE_RIGHTS_VALUES[key].has(item.decodeText() as never)
    ) {
      return false;
    }
  }
  return true;
}

function recognizedUsageRightsTransformParams(reference: PDFDict): boolean {
  const parameters = reference.get(PDFName.of('TransformParams'));
  if (!(parameters instanceof PDFDict)) return false;
  if (!dictionaryHasOnlyKeys(parameters, USAGE_RIGHTS_PARAMETER_KEYS)) {
    return false;
  }
  if (
    !optionalNameEquals(parameters, 'Type', 'TransformParams') ||
    !optionalNameEquals(parameters, 'V', '2.2')
  ) {
    return false;
  }
  const p = resolvedObject(parameters, 'P');
  if (p !== undefined && !(p instanceof PDFBool)) return false;
  const message = resolvedObject(parameters, 'Msg');
  if (
    message !== undefined &&
    !(message instanceof PDFString) &&
    !(message instanceof PDFHexString)
  ) {
    return false;
  }
  const rightKeys = Object.keys(
    USAGE_RIGHTS_VALUES,
  ) as (keyof typeof USAGE_RIGHTS_VALUES)[];
  return rightKeys.every((key) => nameArrayUsesOnly(parameters, key));
}

function recognizedDocMdpTransformParams(reference: PDFDict): boolean {
  const parameters = reference.get(PDFName.of('TransformParams'));
  if (
    !(parameters instanceof PDFDict) ||
    !dictionaryHasOnlyKeys(parameters, DOC_MDP_PARAMETER_KEYS) ||
    !optionalNameEquals(parameters, 'Type', 'TransformParams') ||
    !optionalNameEquals(parameters, 'V', '1.2')
  ) {
    return false;
  }
  const permission = dictionaryNumber(parameters, 'P');
  return permission === 1 || permission === 2 || permission === 3;
}

function textStringArray(value: PDFObject | undefined): boolean {
  if (!(value instanceof PDFArray)) return false;
  for (let index = 0; index < value.size(); index += 1) {
    const item = value.lookup(index);
    if (!(item instanceof PDFString) && !(item instanceof PDFHexString)) {
      return false;
    }
  }
  return true;
}

function recognizedFieldMdpTransformParams(reference: PDFDict): boolean {
  const parameters = reference.get(PDFName.of('TransformParams'));
  if (
    !(parameters instanceof PDFDict) ||
    !dictionaryHasOnlyKeys(parameters, FIELD_MDP_PARAMETER_KEYS) ||
    !optionalNameEquals(parameters, 'Type', 'TransformParams') ||
    !optionalNameEquals(parameters, 'V', '1.2')
  ) {
    return false;
  }
  const action = dictionaryName(parameters, 'Action');
  if (action !== 'All' && action !== 'Include' && action !== 'Exclude') {
    return false;
  }
  const fieldsPresent = parameters.has(PDFName.of('Fields'));
  if ((action === 'Include' || action === 'Exclude') && !fieldsPresent) {
    return false;
  }
  return (
    !fieldsPresent || textStringArray(resolvedObject(parameters, 'Fields'))
  );
}

function recognizedSignatureReferenceBase(
  reference: PDFDict,
  method: string,
): boolean {
  if (
    !dictionaryHasOnlyKeys(reference, SIGNATURE_REFERENCE_KEYS) ||
    !optionalNameEquals(reference, 'Type', 'SigRef') ||
    dictionaryName(reference, 'TransformMethod') !== method
  ) {
    return false;
  }

  const rawData = reference.get(PDFName.of('Data'));
  const dataRequired = method === 'FieldMDP' || method === 'Identity';
  if (
    (dataRequired && !(rawData instanceof PDFRef)) ||
    (rawData !== undefined && !(rawData instanceof PDFRef)) ||
    (rawData instanceof PDFRef &&
      reference.context.lookup(rawData) === undefined)
  ) {
    return false;
  }
  const digestMethod = resolvedObject(reference, 'DigestMethod');
  if (
    digestMethod !== undefined &&
    (!(digestMethod instanceof PDFName) ||
      (digestMethod.decodeText() !== 'MD5' &&
        digestMethod.decodeText() !== 'SHA1'))
  ) {
    return false;
  }
  const digestValue = resolvedObject(reference, 'DigestValue');
  if (
    digestValue !== undefined &&
    !(digestValue instanceof PDFString) &&
    !(digestValue instanceof PDFHexString)
  ) {
    return false;
  }
  const digestLocation = resolvedObject(reference, 'DigestLocation');
  if (digestLocation !== undefined) {
    if (!(digestLocation instanceof PDFArray) || digestLocation.size() !== 2) {
      return false;
    }
    for (let index = 0; index < digestLocation.size(); index += 1) {
      const item = digestLocation.lookup(index);
      if (
        !(item instanceof PDFNumber) ||
        !Number.isSafeInteger(item.asNumber()) ||
        item.asNumber() < 0
      ) {
        return false;
      }
    }
  }
  return true;
}

function recognizedTransformReference(
  reference: PDFDict,
  method: string,
): boolean {
  if (!recognizedSignatureReferenceBase(reference, method)) return false;
  if (method === 'UR' || method === 'UR3') {
    return recognizedUsageRightsTransformParams(reference);
  }
  if (method === 'DocMDP') {
    return recognizedDocMdpTransformParams(reference);
  }
  if (method === 'FieldMDP') {
    return recognizedFieldMdpTransformParams(reference);
  }
  return method === 'Identity' && !reference.has(PDFName.of('TransformParams'));
}

function docMdpPermission(signature: PDFDict): 1 | 2 | 3 | null {
  const state = signatureReferenceList(signature);
  if (!state.valid) return null;
  for (const reference of state.references) {
    if (dictionaryName(reference, 'TransformMethod') !== 'DocMDP') continue;
    const parameters = reference.get(PDFName.of('TransformParams'));
    if (!(parameters instanceof PDFDict)) return null;
    const permission = dictionaryNumber(parameters, 'P');
    if (permission === 1 || permission === 2 || permission === 3) {
      return permission;
    }
    return null;
  }
  return null;
}

function countReferenceInObject(
  object: PDFObject,
  target: PDFRef,
  seen: Set<PDFObject>,
): number {
  if (object instanceof PDFRef) {
    return object.toString() === target.toString() ? 1 : 0;
  }
  if (seen.has(object)) return 0;
  seen.add(object);

  if (object instanceof PDFStream) {
    return countReferenceInObject(object.dict, target, seen);
  }
  if (object instanceof PDFDict) {
    return object
      .values()
      .reduce(
        (count, value) => count + countReferenceInObject(value, target, seen),
        0,
      );
  }
  if (object instanceof PDFArray) {
    let count = 0;
    for (let index = 0; index < object.size(); index += 1) {
      count += countReferenceInObject(object.get(index), target, seen);
    }
    return count;
  }
  return 0;
}

function indirectReferenceCount(document: PDFDocument, target: PDFRef): number {
  let count = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    count += countReferenceInObject(object, target, new Set());
  }
  return count;
}

function analyzeProtection(
  document: PDFDocument,
  dictionaries: readonly PDFDict[],
  form: PDFForm,
  sourceByteLength: number,
  unreachableSignatureDictionaries: readonly PDFDict[],
  revisionHistory: PdfRevisionHistorySummary,
): PdfProtectionAnalysis {
  const catalogPermsPresent = document.catalog.has(PDFName.of('Perms'));
  const rawPerms = document.catalog.get(PDFName.of('Perms'));
  const resolvedPerms = document.context.lookup(rawPerms);
  const perms = resolvedPerms instanceof PDFDict ? resolvedPerms : null;
  const permsKeys =
    perms
      ?.keys()
      .map((key) => key.decodeText())
      .sort() ?? [];
  const unknownStructures = new Set<string>();
  const usageRightsKeys: ('UR' | 'UR3')[] = [];
  const usageRightsSignatures = new Set<PDFDict>();
  const usageRightsRefs: PDFRef[] = [];
  const docMdpSignatures = new Set<PDFDict>();
  const signatureCandidates = new Set<PDFDict>();
  const signatureDictionaries = new Set<PDFDict>();
  const signedFieldSignatures = new Set<PDFDict>();
  let docMdpReferenceObserved = false;
  let fieldMdpPresent = false;

  if (unreachableSignatureDictionaries.length > 0) {
    unknownStructures.add('historical_or_unreachable_signature_structure');
  }

  if (catalogPermsPresent && perms === null) {
    unknownStructures.add('catalog_perms_not_dictionary');
  }
  if (perms && permsKeys.length === 0) {
    unknownStructures.add('catalog_perms_empty');
  }
  for (const key of permsKeys) {
    if (key !== 'UR' && key !== 'UR3' && key !== 'DocMDP') {
      unknownStructures.add(`catalog_perms_${key}`);
    }
  }

  for (const dictionary of dictionaries) {
    const signatureLike =
      dictionaryName(dictionary, 'Type') === 'Sig' ||
      dictionary.has(PDFName.of('ByteRange'));
    if (!signatureLike) continue;

    const recognized = recognizedSignatureStructure(
      dictionary,
      sourceByteLength,
    );
    signatureCandidates.add(dictionary);
    if (recognized) signatureDictionaries.add(dictionary);
    else unknownStructures.add('signature_structure_unrecognized');

    const referenceState = signatureReferenceList(dictionary);
    if (referenceState.present && !referenceState.valid) {
      unknownStructures.add('signature_reference_structure_unrecognized');
    }

    const methods: string[] = [];
    for (const reference of referenceState.references) {
      const method = dictionaryName(reference, 'TransformMethod');
      if (method === null || !KNOWN_TRANSFORM_METHODS.has(method)) {
        unknownStructures.add('signature_transform_method_unrecognized');
        continue;
      }
      methods.push(method);
      if (!recognizedTransformReference(reference, method)) {
        const label = TRANSFORM_METHOD_LABELS[method] ?? 'signature';
        unknownStructures.add(`${label}_transform_params_unrecognized`);
      }
    }

    const docMdpReferenceCount = methods.filter(
      (method) => method === 'DocMDP',
    ).length;
    if (docMdpReferenceCount > 0) {
      docMdpReferenceObserved = true;
      if (docMdpReferenceCount !== 1) {
        unknownStructures.add('doc_mdp_reference_count_invalid');
      } else if (
        recognized &&
        referenceState.valid &&
        referenceState.references.every((reference) => {
          const method = dictionaryName(reference, 'TransformMethod');
          return (
            method !== null && recognizedTransformReference(reference, method)
          );
        })
      ) {
        docMdpSignatures.add(dictionary);
      } else {
        unknownStructures.add('doc_mdp_structure_unrecognized');
      }
    }

    if (methods.includes('FieldMDP')) {
      fieldMdpPresent = true;
      if (
        methods.filter((method) => method === 'FieldMDP').length !== 1 ||
        !recognized
      ) {
        unknownStructures.add('field_mdp_structure_unrecognized');
      }
    }
  }

  for (const key of ['UR', 'UR3'] as const) {
    if (!perms?.has(PDFName.of(key))) continue;
    const rawSignature = perms.get(PDFName.of(key));
    const signature = document.context.lookup(rawSignature);
    const referenceState =
      signature instanceof PDFDict
        ? signatureReferenceList(signature)
        : { present: false, valid: false, references: [] };
    const range = signature instanceof PDFDict ? byteRange(signature) : null;
    const referencesRecognized =
      referenceState.valid &&
      referenceState.references.length === 1 &&
      referenceState.references.every((reference) =>
        recognizedTransformReference(reference, key),
      );
    if (referenceState.present && !referencesRecognized) {
      unknownStructures.add(
        `${key.toLowerCase()}_transform_params_unrecognized`,
      );
    }
    const valid =
      signature instanceof PDFDict &&
      rawSignature instanceof PDFRef &&
      recognizedSignatureStructure(signature, sourceByteLength) &&
      range !== null &&
      byteRangeCoversWholeFile(range, sourceByteLength) &&
      dictionaryName(signature, 'Filter') === 'Adobe.PPKLite' &&
      dictionaryName(signature, 'SubFilter') === 'adbe.pkcs7.detached' &&
      referencesRecognized;
    if (!valid || !(signature instanceof PDFDict)) {
      unknownStructures.add(`${key.toLowerCase()}_structure_unrecognized`);
      continue;
    }
    usageRightsKeys.push(key);
    usageRightsSignatures.add(signature);
    if (rawSignature instanceof PDFRef) {
      usageRightsRefs.push(rawSignature);
      if (indirectReferenceCount(document, rawSignature) !== 1) {
        unknownStructures.add(
          `${key.toLowerCase()}_signature_shared_reference`,
        );
      }
    }
  }
  if (usageRightsKeys.length > 1) {
    unknownStructures.add('multiple_usage_rights_entries');
  }

  const catalogDocMdpPresent = perms?.has(PDFName.of('DocMDP')) ?? false;
  if (catalogDocMdpPresent) {
    const rawSignature = perms?.get(PDFName.of('DocMDP'));
    const signature = document.context.lookup(rawSignature);
    if (
      !(rawSignature instanceof PDFRef) ||
      !(signature instanceof PDFDict) ||
      !docMdpSignatures.has(signature)
    ) {
      unknownStructures.add('doc_mdp_structure_unrecognized');
    }
  }
  if (docMdpReferenceObserved && !catalogDocMdpPresent) {
    unknownStructures.add('doc_mdp_not_catalog_perms');
  }
  if (docMdpSignatures.size > 1) {
    unknownStructures.add('multiple_doc_mdp_signatures');
  }

  const signatureFields = form
    .getFields()
    .filter((field): field is PDFSignature => field instanceof PDFSignature);
  for (const field of signatureFields) {
    const value = field.acroField.V();
    if (value === undefined || value === PDFNull) continue;
    if (
      value instanceof PDFDict &&
      recognizedSignatureStructure(value, sourceByteLength)
    ) {
      signedFieldSignatures.add(value);
    } else {
      unknownStructures.add('signed_signature_field_value_unrecognized');
    }
  }

  const documentSignatures = [...signedFieldSignatures].filter(
    (signature) =>
      !usageRightsSignatures.has(signature) && !docMdpSignatures.has(signature),
  );
  const unclassifiedSignatures = [...signatureDictionaries].filter(
    (signature) =>
      !usageRightsSignatures.has(signature) &&
      !docMdpSignatures.has(signature) &&
      !documentSignatures.includes(signature),
  );
  if (unclassifiedSignatures.length > 0) {
    unknownStructures.add('unclassified_signature_dictionary');
  }
  const docMdpPermissions = [...docMdpSignatures]
    .map(docMdpPermission)
    .filter((value): value is 1 | 2 | 3 => value !== null);
  if (docMdpSignatures.size > 0 && docMdpPermissions.length === 0) {
    unknownStructures.add('doc_mdp_permission_missing_or_invalid');
  }
  if (new Set(docMdpPermissions).size > 1) {
    unknownStructures.add('doc_mdp_permissions_conflict');
  }

  const byteRangeEntries = [...signatureCandidates].filter((signature) =>
    signature.has(PDFName.of('ByteRange')),
  );
  const malformedByteRangeCount = byteRangeEntries.filter((signature) => {
    const range = byteRange(signature);
    return range === null || !byteRangeIsSane(range, sourceByteLength);
  }).length;
  const byteRanges = [...signatureCandidates]
    .map(byteRange)
    .filter(
      (value): value is readonly [number, number, number, number] =>
        value !== null,
    );
  const byteRangesCoverWholeFile =
    byteRangeEntries.length === 0
      ? null
      : malformedByteRangeCount > 0
        ? false
        : byteRanges.every((range) =>
            byteRangeCoversWholeFile(range, sourceByteLength),
          );
  if (revisionHistory.historicalByteRangeNameCount > 0) {
    unknownStructures.add('historical_byte_range_changed_or_missing');
  }
  if (revisionHistory.historicalSignatureStructureCount > 0) {
    unknownStructures.add('historical_signature_structure_changed_or_missing');
  }
  if (!revisionHistory.complete) {
    unknownStructures.add('historical_scan_inconclusive');
  }

  const acroForm = document.catalog.AcroForm();
  const xfaPresent = acroForm?.has(PDFName.of('XFA')) ?? false;
  const sigFlagsPresent = acroForm?.has(PDFName.of('SigFlags')) ?? false;
  const sigFlagsValue = acroForm
    ? dictionaryNumber(acroForm, 'SigFlags')
    : null;
  if (
    sigFlagsPresent &&
    (sigFlagsValue === null ||
      !Number.isSafeInteger(sigFlagsValue) ||
      sigFlagsValue < 0 ||
      sigFlagsValue > 3)
  ) {
    unknownStructures.add('sig_flags_unrecognized');
  }
  if (
    (sigFlagsValue === 1 || sigFlagsValue === 3) &&
    signatureFields.length === 0
  ) {
    unknownStructures.add('sig_flags_signatures_exist_without_field');
  }
  if (
    (sigFlagsValue === 2 || sigFlagsValue === 3) &&
    signatureDictionaries.size === 0
  ) {
    unknownStructures.add('sig_flags_append_only_without_signature');
  }
  const permsRef = rawPerms instanceof PDFRef ? rawPerms : null;
  if (permsRef && indirectReferenceCount(document, permsRef) !== 1) {
    unknownStructures.add('catalog_perms_shared_reference');
  }
  const extensions = resolvedObject(document.catalog, 'Extensions');
  const adbe =
    extensions instanceof PDFDict ? resolvedObject(extensions, 'ADBE') : null;
  const adbeExtension =
    adbe instanceof PDFDict
      ? {
          baseVersion: dictionaryName(adbe, 'BaseVersion'),
          extensionLevel: dictionaryNumber(adbe, 'ExtensionLevel'),
        }
      : null;

  let protectionType: PdfProtectionType;
  if (unknownStructures.size > 0) protectionType = 'unknown';
  else if (docMdpSignatures.size > 0) protectionType = 'doc_mdp';
  else if (documentSignatures.length > 0) {
    protectionType = 'document_signature';
  } else if (usageRightsSignatures.size > 0) protectionType = 'usage_rights';
  else protectionType = 'none';

  const hasCmsCandidate =
    signatureCandidates.size > 0 ||
    revisionHistory.historicalByteRangeNameCount > 0 ||
    revisionHistory.historicalSignatureStructureCount > 0;
  return {
    protectionType,
    evidence: {
      catalogPermsPresent,
      permsKeys,
      usageRightsKeys,
      byteRangeEntryCount: byteRangeEntries.length,
      rawByteRangeNameCount: revisionHistory.byteRangeNameCount,
      historicalByteRangeNameCount:
        revisionHistory.historicalByteRangeNameCount,
      revisionMarkerCount: revisionHistory.revisionMarkerCount,
      historyScanComplete: revisionHistory.complete,
      historyScanIssues: revisionHistory.issues,
      malformedByteRangeCount,
      byteRanges,
      byteRangesCoverWholeFile,
      signatureDictionaryCount: signatureDictionaries.size,
      usageRightsSignatureCount: usageRightsSignatures.size,
      documentSignatureCount: documentSignatures.length,
      unclassifiedSignatureDictionaryCount: unclassifiedSignatures.length,
      unreachableSignatureDictionaryCount:
        unreachableSignatureDictionaries.length,
      signatureFieldCount: signatureFields.length,
      signedSignatureFieldCount: signedFieldSignatures.size,
      docMdpPresent: catalogDocMdpPresent || docMdpReferenceObserved,
      docMdpSignatureDictionaryCount: docMdpSignatures.size,
      docMdpPermission: docMdpPermissions[0] ?? null,
      fieldMdpPresent,
      adbeExtension,
      xfaPresent,
      sigFlags:
        sigFlagsValue !== null && Number.isSafeInteger(sigFlagsValue)
          ? sigFlagsValue
          : null,
      unknownStructures: [...unknownStructures].sort(),
      cmsIntegrity: hasCmsCandidate
        ? 'not_verified_in_browser'
        : 'not_applicable',
      signerTrust: hasCmsCandidate ? 'not_verified' : 'not_applicable',
    },
    usageRightsRefs,
    permsRef,
  };
}

interface PdfContentAnalysis {
  readonly activeContent: PdfActiveContentSummary;
  readonly contentRisk: PdfContentRisk;
}

function isReachableFileSpec(dictionary: PDFDict): boolean {
  return (
    dictionaryName(dictionary, 'Type') === 'Filespec' ||
    dictionary.has(PDFName.of('EF'))
  );
}

function summarizeReachablePayloads(
  document: PDFDocument,
  dictionaries: readonly PDFDict[],
): PdfPayloadSummary {
  const embeddedFiles = new Set<PDFDict>();
  const associatedFiles = new Set<PDFDict>();
  const fileAttachments = new Set<PDFDict>();
  const richMediaAnnotations = new Set<PDFDict>();
  const multimediaEntries = new Set<PDFDict>();
  let malformedPayloadEntryCount = 0;

  const names = lookedUpObject(
    document,
    document.catalog.get(PDFName.of('Names')),
  );
  const embeddedFilesEntry =
    names instanceof PDFDict
      ? names.get(PDFName.of('EmbeddedFiles'))
      : undefined;
  const embeddedFilesRoot = lookedUpObject(document, embeddedFilesEntry);
  if (
    embeddedFilesEntry !== undefined &&
    !(embeddedFilesRoot instanceof PDFDict)
  ) {
    malformedPayloadEntryCount += 1;
  }
  if (embeddedFilesRoot instanceof PDFDict) {
    const seen = new Set<PDFDict>();
    const queued = new Set<PDFDict>([embeddedFilesRoot]);
    const pending: Array<{ readonly depth: number; readonly tree: PDFDict }> = [
      { depth: 0, tree: embeddedFilesRoot },
    ];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      if (
        current.depth > MAX_ACTION_GRAPH_DEPTH ||
        seen.has(current.tree) ||
        seen.size >= MAX_ACTION_GRAPH_NODES
      ) {
        malformedPayloadEntryCount += 1;
        continue;
      }
      seen.add(current.tree);

      const rawEntries = current.tree.get(PDFName.of('Names'));
      const entries = lookedUpObject(document, rawEntries);
      if (entries instanceof PDFArray) {
        if (entries.size() % 2 !== 0) malformedPayloadEntryCount += 1;
        for (let index = 1; index < entries.size(); index += 2) {
          const fileSpec = lookedUpObject(document, entries.get(index));
          if (fileSpec instanceof PDFDict && isReachableFileSpec(fileSpec)) {
            embeddedFiles.add(fileSpec);
          } else {
            malformedPayloadEntryCount += 1;
          }
        }
      } else if (rawEntries !== undefined) {
        malformedPayloadEntryCount += 1;
      }

      const rawKids = current.tree.get(PDFName.of('Kids'));
      const kids = lookedUpObject(document, rawKids);
      if (kids instanceof PDFArray) {
        for (let index = 0; index < kids.size(); index += 1) {
          const child = lookedUpObject(document, kids.get(index));
          if (!(child instanceof PDFDict) || queued.has(child)) {
            malformedPayloadEntryCount += 1;
          } else {
            queued.add(child);
            pending.push({ depth: current.depth + 1, tree: child });
          }
        }
      } else if (rawKids !== undefined) {
        malformedPayloadEntryCount += 1;
      }
    }
  }

  for (const dictionary of dictionaries) {
    const type = dictionaryName(dictionary, 'Type');
    const subtype = dictionaryName(dictionary, 'Subtype');
    if (dictionary === document.catalog || type === 'Page') {
      const rawAssociatedFiles = dictionary.get(PDFName.of('AF'));
      if (rawAssociatedFiles !== undefined) {
        const associated = lookedUpObject(document, rawAssociatedFiles);
        if (!(associated instanceof PDFArray)) {
          malformedPayloadEntryCount += 1;
        } else {
          for (let index = 0; index < associated.size(); index += 1) {
            const fileSpec = lookedUpObject(document, associated.get(index));
            if (fileSpec instanceof PDFDict && isReachableFileSpec(fileSpec)) {
              associatedFiles.add(fileSpec);
            } else {
              malformedPayloadEntryCount += 1;
            }
          }
        }
      }
    }
    if (subtype === 'FileAttachment') {
      fileAttachments.add(dictionary);
      const rawFileSpec = dictionary.get(PDFName.of('FS'));
      if (rawFileSpec !== undefined) {
        const fileSpec = lookedUpObject(document, rawFileSpec);
        if (!(fileSpec instanceof PDFDict) || !isReachableFileSpec(fileSpec)) {
          malformedPayloadEntryCount += 1;
        }
      }
    } else if (subtype === 'RichMedia') {
      richMediaAnnotations.add(dictionary);
    } else if (
      subtype === '3D' ||
      subtype === 'Sound' ||
      subtype === 'Movie' ||
      subtype === 'Screen'
    ) {
      multimediaEntries.add(dictionary);
    }
  }

  return {
    embeddedFileCount: embeddedFiles.size,
    associatedFileCount: associatedFiles.size,
    fileAttachmentAnnotationCount: fileAttachments.size,
    richMediaAnnotationCount: richMediaAnnotations.size,
    multimediaAnnotationCount: multimediaEntries.size,
    malformedPayloadEntryCount,
  };
}

function summarizeActiveContent(
  document: PDFDocument,
  dictionaries: readonly PDFDict[],
  fieldAndWidgetDictionaries: ReadonlySet<PDFDict>,
): PdfContentAnalysis {
  const referencedActionSummary = explicitlyReferencedActions(
    document,
    dictionaries,
    fieldAndWidgetDictionaries,
  );
  const referencedActions = referencedActionSummary.actions;
  const additionalActions = new Set<PDFDict>();
  let javascriptActionCount = 0;
  let uriActionCount = 0;
  let multimediaActionCount = 0;
  let externalActionCount = 0;
  let highRiskActionCount = referencedActionSummary.malformedActionGraphCount;
  let otherActionCount = 0;

  for (const dictionary of dictionaries) {
    const additionalAction = document.context.lookup(
      dictionary.get(PDFName.of('AA')),
    );
    if (additionalAction instanceof PDFDict) {
      additionalActions.add(additionalAction);
    }

    const actionType = referencedActions.has(dictionary)
      ? dictionaryName(dictionary, 'S')
      : null;
    if (actionType === 'JavaScript') javascriptActionCount += 1;
    else if (actionType === 'URI') {
      uriActionCount += 1;
      externalActionCount += 1;
    } else if (
      actionType === 'Launch' ||
      actionType === 'GoToR' ||
      actionType === 'GoToE' ||
      actionType === 'SubmitForm' ||
      actionType === 'ImportData'
    ) {
      externalActionCount += 1;
      highRiskActionCount += 1;
    } else if (
      actionType === 'Sound' ||
      actionType === 'Movie' ||
      actionType === 'Rendition' ||
      actionType === 'GoTo3DView' ||
      actionType === 'RichMediaExecute'
    ) {
      multimediaActionCount += 1;
      otherActionCount += 1;
    } else if (
      actionType !== null &&
      REPORT_ONLY_ACTION_TYPES.has(actionType)
    ) {
      otherActionCount += 1;
    } else if (actionType !== null && referencedActions.has(dictionary)) {
      highRiskActionCount += 1;
    }
  }

  const activeContent = {
    javascriptActionCount,
    additionalActionDictionaryCount: additionalActions.size,
    openActionCount: document.catalog.has(PDFName.of('OpenAction')) ? 1 : 0,
    externalActionCount,
    highRiskActionCount,
    otherActionCount,
  };
  const payloadSummary = summarizeReachablePayloads(document, dictionaries);
  const reasons: PdfContentRiskReason[] = [];
  const addReason = (code: PdfContentRiskReasonCode, count: number): void => {
    if (count > 0) reasons.push({ code, count });
  };
  addReason('javascript_present', javascriptActionCount);
  addReason('external_link_present', uriActionCount);
  addReason(
    'dangerous_or_unknown_action_present',
    highRiskActionCount + multimediaActionCount,
  );
  addReason('embedded_file_present', payloadSummary.embeddedFileCount);
  addReason('associated_file_present', payloadSummary.associatedFileCount);
  addReason(
    'file_attachment_present',
    payloadSummary.fileAttachmentAnnotationCount,
  );
  addReason('rich_media_present', payloadSummary.richMediaAnnotationCount);
  addReason('multimedia_present', payloadSummary.multimediaAnnotationCount);
  addReason(
    'unclassified_payload_entry',
    payloadSummary.malformedPayloadEntryCount,
  );

  const actionTriggerCounts: Record<PdfActionTriggerKind, number> = {
    open_action: 0,
    additional_action: 0,
    direct_action: 0,
    javascript_name_tree: 0,
  };
  for (const actionTriggers of referencedActionSummary.triggers.values()) {
    for (const trigger of actionTriggers) actionTriggerCounts[trigger] += 1;
  }
  const blocksPdfExport = reasons.length > 0;
  return {
    activeContent,
    contentRisk: {
      blocksPdfExport,
      blocksInteractivePreview: blocksPdfExport,
      reasons,
      actionTriggerCounts,
      payloadSummary,
    },
  };
}

function hasActiveContent(summary: PdfActiveContentSummary): boolean {
  return (
    summary.javascriptActionCount > 0 ||
    summary.additionalActionDictionaryCount > 0 ||
    summary.openActionCount > 0 ||
    summary.externalActionCount > 0 ||
    summary.highRiskActionCount > 0 ||
    summary.otherActionCount > 0
  );
}

function createProtectionReport(
  analysis: PdfProtectionAnalysis,
  fields: readonly PdfFieldDescriptor[],
  contentRisk: PdfContentRisk,
): PdfProtectionReport {
  const allowedMutations: PdfAllowedMutation[] = ['inspect_fields'];
  const exportStrategies: PdfExportStrategy[] = [];
  const canStage = fields.some(
    (field) =>
      !field.readOnly &&
      !field.humanOnly &&
      field.type !== 'signature' &&
      field.type !== 'unsupported',
  );
  if (canStage && analysis.protectionType !== 'unknown') {
    allowedMutations.push('stage_field_values');
  }

  const pdfContentAllowsExport = !contentRisk.blocksPdfExport;
  if (canStage && analysis.protectionType !== 'unknown') {
    allowedMutations.push('create_fill_package');
    exportStrategies.push('fill_package');
  }
  if (
    canStage &&
    pdfContentAllowsExport &&
    analysis.protectionType === 'none' &&
    !analysis.evidence.xfaPresent
  ) {
    allowedMutations.push('create_filled_pdf');
    exportStrategies.unshift('filled_pdf');
  }
  if (
    canStage &&
    pdfContentAllowsExport &&
    analysis.protectionType === 'usage_rights' &&
    !analysis.evidence.xfaPresent
  ) {
    allowedMutations.push('create_plain_derivative_pdf');
    exportStrategies.unshift('confirmed_plain_derivative_pdf');
  }

  let signatureImpact: PdfSignatureImpact;
  switch (analysis.protectionType) {
    case 'none':
      signatureImpact = 'none';
      break;
    case 'usage_rights':
      signatureImpact = exportStrategies.includes(
        'confirmed_plain_derivative_pdf',
      )
        ? 'usage_rights_removed_in_plain_derivative'
        : 'rewrite_would_invalidate_usage_rights';
      break;
    case 'document_signature':
      signatureImpact = 'rewrite_blocked_to_preserve_document_signature';
      break;
    case 'doc_mdp':
      signatureImpact = 'rewrite_blocked_to_preserve_certification';
      break;
    case 'unknown':
      signatureImpact = 'rewrite_blocked_for_unknown_protection';
      break;
  }

  return {
    protectionType: analysis.protectionType,
    allowedMutations,
    exportStrategies,
    signatureImpact,
    requiresHumanConfirmation: exportStrategies.includes(
      'confirmed_plain_derivative_pdf',
    ),
    evidence: analysis.evidence,
  };
}

function inspectionForm(document: PDFDocument): PDFForm {
  const acroForm = document.catalog.getAcroForm();
  return acroForm ? PDFForm.of(acroForm, document) : document.getForm();
}

async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  let document: PDFDocument;
  const preflightScan = preflightPdfBytes(bytes);

  try {
    document = await PDFDocument.load(copyBytes(bytes), {
      updateMetadata: false,
    });
  } catch (cause) {
    if (
      cause instanceof EncryptedPDFError ||
      (cause instanceof Error && /encrypted/i.test(cause.message))
    ) {
      throw new PdfEngineError(
        'PDF_ENCRYPTED',
        'Encrypted PDFs are not supported. Decrypt the file before importing it.',
        { cause },
      );
    }

    throw new PdfEngineError(
      'PDF_LOAD_FAILED',
      'The file could not be parsed as a PDF.',
      { cause },
    );
  }

  try {
    if (
      !(document.catalog instanceof PDFDict) ||
      dictionaryName(document.catalog, 'Type') !== 'Catalog'
    ) {
      malformedPdfObjectGraph('catalog_invalid');
    }

    validatePageTree(document);
    const fieldAndWidgetDictionaries = validateAcroFormFieldGraph(document);
    const dictionaries = collectPdfDictionaries(document);
    const unreachableSignatureDictionaries =
      collectUnreachableSignatureDictionaries(document, dictionaries);
    const { activeContent, contentRisk } = summarizeActiveContent(
      document,
      dictionaries,
      fieldAndWidgetDictionaries,
    );
    const xfaSemantics = extractXfaSemantics(document);
    const form = inspectionForm(document);
    const revisionHistory = await inspectPdfRevisionHistory(
      bytes,
      document,
      preflightScan,
    );
    const protectionAnalysis = analyzeProtection(
      document,
      [...dictionaries, ...unreachableSignatureDictionaries],
      form,
      bytes.byteLength,
      unreachableSignatureDictionaries,
      revisionHistory,
    );

    return {
      document,
      form,
      activeContent,
      contentRisk,
      protectionAnalysis,
      xfaSemantics,
    };
  } catch (cause) {
    if (cause instanceof PdfEngineError) throw cause;
    throw new PdfEngineError(
      'PDF_LOAD_FAILED',
      'The PDF structure could not be inspected safely.',
      { cause },
    );
  }
}

function recoveredCheckBoxRadioOptions(field: PDFField): string[] | null {
  if (!(field instanceof PDFCheckBox)) return null;

  const options: string[] = [];
  const seen = new Set<string>();
  for (const widget of field.acroField.getWidgets()) {
    const option = widget.getOnValue()?.decodeText();
    if (
      option === undefined ||
      option === 'Off' ||
      option.trim().length === 0 ||
      seen.has(option)
    ) {
      continue;
    }
    seen.add(option);
    options.push(option);
  }

  return options.length > 1 ? options : null;
}

function fieldType(field: PDFField): PdfFieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) {
    return recoveredCheckBoxRadioOptions(field) ? 'radio' : 'checkbox';
  }
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'option_list';
  if (field instanceof PDFSignature) return 'signature';
  return 'unsupported';
}

function decodePdfText(value: unknown): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return null;
}

function fieldTooltip(field: PDFField): string | null {
  return decodePdfText(
    field.acroField.getInheritableAttribute(PDFName.of('TU')),
  );
}

function normalizedSemanticFieldLabel(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.replace(HUMAN_ONLY_MARKER_GLOBAL, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.toLowerCase() === 'undefined' ||
    normalized.toLowerCase() === 'null'
  ) {
    return null;
  }
  return normalized;
}

function conciseXfaSecurityLabel(
  value: string | null | undefined,
): string | null {
  const normalized = normalizedSemanticFieldLabel(value);
  return normalized !== null &&
    normalized.length <= MAX_SEMANTIC_FIELD_LABEL_LENGTH &&
    /[\p{L}\p{N}]/u.test(normalized)
    ? normalized
    : null;
}

function effectiveXfaSecurityLabel(
  tooltip: string | null,
  speak: string | null | undefined,
  caption: string | null | undefined,
): string | null {
  if (normalizedSemanticFieldLabel(tooltip) !== null) return null;
  return conciseXfaSecurityLabel(speak) ?? conciseXfaSecurityLabel(caption);
}

function fieldDiscoveryAliases(
  fieldName: string,
  tooltip: string | null,
  xfaDiscoverySpeak: string | undefined,
): PdfFieldDiscoveryAlias[] {
  if (normalizedSemanticFieldLabel(tooltip) !== null) return [];

  const aliases: PdfFieldDiscoveryAlias[] = [];
  if (xfaDiscoverySpeak !== undefined) {
    aliases.push({
      value: xfaDiscoverySpeak,
      source: 'xfa_disabled_speak',
    });
  }
  if (
    fieldName
      .normalize('NFKC')
      .split(/[^\p{L}\p{N}]+/u)
      .includes('SSN')
  ) {
    aliases.push({
      value: 'social security number',
      source: 'standard_initialism',
    });
  }
  return aliases;
}

function isSignatureSemanticTextField(
  field: PDFField,
  tooltip: string | null,
  xfaLabel: string | null = null,
): boolean {
  if (!(field instanceof PDFTextField)) return false;
  return hasExplicitSignatureFieldSemantics(field.getName(), tooltip, xfaLabel);
}

function hasExplicitSignatureSemantics(
  fieldName: string,
  tooltip: string | null,
): boolean {
  if (SIGNATURE_DATE_FIELD.test(fieldName)) return false;
  if (DIRECT_SIGNATURE_FIELD_NAME.test(fieldName)) return true;
  if (EXPLICIT_SIGNATURE_FIELD.test(fieldName)) return true;
  if (/\bdate\b/i.test(fieldName)) return false;
  return tooltip !== null && EXPLICIT_SIGNATURE_FIELD.test(tooltip);
}

function hasExplicitSignatureFieldSemantics(
  fieldName: string,
  tooltip: string | null,
  xfaLabel: string | null = null,
): boolean {
  return (
    hasExplicitSignatureSemantics(fieldName, tooltip) ||
    (xfaLabel !== null && hasExplicitSignatureSemantics(fieldName, xfaLabel))
  );
}

function isHumanOnly(
  field: PDFField,
  type: PdfFieldType,
  tooltip: string | null,
  xfaLabel: string | null = null,
): boolean {
  return (
    type === 'signature' ||
    isSignatureSemanticTextField(field, tooltip, xfaLabel) ||
    HUMAN_ONLY_MARKER.test(field.getName()) ||
    (tooltip !== null && HUMAN_ONLY_MARKER.test(tooltip))
  );
}

function fieldChoices(field: PDFField): PdfChoiceDescriptor[] {
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const choices: PdfChoiceDescriptor[] = [];
    const seen = new Set<string>();
    for (const { value, display } of field.acroField.getOptions()) {
      const decodedValue = value.decodeText();
      if (decodedValue.trim().length === 0 || seen.has(decodedValue)) continue;

      const decodedDisplay = display.decodeText();
      seen.add(decodedValue);
      choices.push({
        value: decodedValue,
        label:
          decodedDisplay.trim().length === 0 ? decodedValue : decodedDisplay,
        labelSource: 'acroform',
      });
    }
    return choices;
  }
  const recoveredOptions = recoveredCheckBoxRadioOptions(field);
  if (recoveredOptions) {
    return recoveredOptions.map((value) => ({
      value,
      label: value,
      labelSource: 'acroform',
    }));
  }
  if (field instanceof PDFRadioGroup) {
    return field.getOptions().map((value) => ({
      value,
      label: value,
      labelSource: 'acroform',
    }));
  }
  return [];
}

function exactXfaStaticChoiceLabels(
  type: PdfFieldType,
  choices: readonly PdfChoiceDescriptor[],
  xfa: XfaFieldSemantics | undefined,
): PdfChoiceDescriptor[] {
  if (type !== 'radio' || xfa?.staticChoices === undefined) {
    return [...choices];
  }

  const labelsByValue = new Map<string, string>();
  const labels = new Set<string>();
  for (const choice of xfa.staticChoices) {
    const labelKey = choice.label
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase();
    if (
      labelsByValue.has(choice.value) ||
      /\p{C}/u.test(choice.label) ||
      !/[\p{L}\p{N}\p{P}\p{S}]/u.test(choice.label) ||
      labels.has(labelKey)
    ) {
      return [...choices];
    }
    labelsByValue.set(choice.value, choice.label);
    labels.add(labelKey);
  }
  const acroValues = new Set(choices.map(({ value }) => value));
  if (
    acroValues.size !== choices.length ||
    labelsByValue.size !== choices.length ||
    choices.some(({ value }) => !labelsByValue.has(value))
  ) {
    return [...choices];
  }

  return choices.map((choice) => ({
    ...choice,
    label: labelsByValue.get(choice.value)!,
    labelSource: 'xfa_static_exact_som',
  }));
}

function fieldAllowsMultiple(field: PDFField): boolean {
  return (
    (field instanceof PDFDropdown || field instanceof PDFOptionList) &&
    field.isMultiselect()
  );
}

function fieldValue(field: PDFField): PdfFieldValue {
  if (field instanceof PDFTextField) return field.getText() ?? '';
  if (field instanceof PDFCheckBox) {
    const recoveredOptions = recoveredCheckBoxRadioOptions(field);
    if (recoveredOptions) {
      const current = field.acroField.getValue().decodeText();
      return recoveredOptions.includes(current) ? current : null;
    }
    return field.isChecked();
  }
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? null;
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const selected = field
      .getSelected()
      .filter(
        (value, index, values) =>
          value.trim().length > 0 && values.indexOf(value) === index,
      );
    if (field.isMultiselect()) return selected;
    return selected[0] ?? null;
  }
  return null;
}

function widgetAppearanceExists(widget: {
  getAppearances(): { normal: PDFStream | PDFDict } | undefined;
}): boolean {
  try {
    const normal = widget.getAppearances()?.normal;
    if (normal instanceof PDFStream) return normal.getContentsSize() > 0;
    if (normal instanceof PDFDict) return normal.keys().length > 0;
    return false;
  } catch {
    return false;
  }
}

function widgetRefs(field: PDFField): PDFRef[] {
  const kids = field.acroField.Kids();
  if (!kids) return [field.ref];

  const refs: PDFRef[] = [];
  for (let index = 0; index < kids.size(); index += 1) {
    const ref = kids.get(index);
    if (ref instanceof PDFRef) refs.push(ref);
  }
  return refs;
}

function describeWidgets(
  document: PDFDocument,
  field: PDFField,
): PdfWidgetDescriptor[] {
  const widgets = field.acroField.getWidgets();
  const refs = widgetRefs(field);
  const pages = document.getPages();
  const recoveredOptions = recoveredCheckBoxRadioOptions(field);
  const radioExportValues =
    field instanceof PDFRadioGroup
      ? field.acroField.getExportValues()?.map((value) => value.decodeText())
      : undefined;

  return widgets.map((widget, index) => {
    const annotationRef = refs[index];
    let pageIndex = annotationRef
      ? pages.indexOf(document.findPageForAnnotationRef(annotationRef)!)
      : -1;

    if (pageIndex < 0) {
      const pageRef = widget.P();
      pageIndex = pageRef
        ? pages.findIndex((page) => page.ref.toString() === pageRef.toString())
        : -1;
    }

    return {
      page: pageIndex < 0 ? null : pageIndex + 1,
      rect: widget.getRectangle(),
      hasAppearance: widgetAppearanceExists(widget),
      appearanceState: widget.getOnValue()?.decodeText() ?? null,
      choiceValue:
        field instanceof PDFRadioGroup
          ? (radioExportValues?.[index] ?? field.getOptions()[index] ?? null)
          : recoveredOptions
            ? (recoveredOptions[index] ?? null)
            : null,
    };
  });
}

function describeField(
  document: PDFDocument,
  field: PDFField,
  xfaSemantics?: XfaSemanticsResult,
): PdfFieldDescriptor {
  const type = fieldType(field);
  const tooltip = fieldTooltip(field);
  const widgets = describeWidgets(document, field);
  const acroFormChoices = fieldChoices(field);
  const xfa =
    xfaSemantics?.status === 'available'
      ? xfaSemantics.byExactSomName.get(field.getName())
      : undefined;
  const choices = exactXfaStaticChoiceLabels(type, acroFormChoices, xfa);
  const xfaSignatureWidget =
    xfaSemantics?.status === 'available' &&
    xfaSemantics.humanOnlyExactSomNames.has(field.getName());
  const xfaReadOnly =
    xfaSemantics?.status === 'available' &&
    xfaSemantics.readOnlyExactSomNames.has(field.getName());
  const xfaSemanticsUnavailable =
    (document.catalog.AcroForm()?.has(PDFName.of('XFA')) ?? false) &&
    xfaSemantics?.status === 'unavailable';
  const xfaSecurityLabel = effectiveXfaSecurityLabel(
    tooltip,
    xfa?.speak,
    xfa?.caption,
  );
  const discoveryAliases = fieldDiscoveryAliases(
    field.getName(),
    tooltip,
    xfa?.discoverySpeak,
  );

  return {
    name: field.getName(),
    type,
    current: fieldValue(field),
    options: choices.map((choice) => choice.value),
    choices,
    multiSelect: fieldAllowsMultiple(field),
    ...(field instanceof PDFTextField && field.isMultiline()
      ? { multiline: true }
      : {}),
    required: field.isRequired(),
    readOnly: field.isReadOnly() || xfaReadOnly,
    humanOnly:
      xfaSemanticsUnavailable ||
      xfaSignatureWidget ||
      isHumanOnly(field, type, tooltip, xfaSecurityLabel),
    page: widgets[0]?.page ?? null,
    rect: widgets[0]?.rect ?? null,
    maxLength:
      field instanceof PDFTextField ? (field.getMaxLength() ?? null) : null,
    tooltip,
    xfaSomNameMatched: xfa !== undefined,
    ...(xfaSignatureWidget ? { xfaSignatureWidget: true } : {}),
    xfaSpeak: xfa?.speak ?? null,
    xfaCaption: xfa?.caption ?? null,
    ...(discoveryAliases.length === 0 ? {} : { discoveryAliases }),
    widgetCount: widgets.length,
    widgets,
  };
}

function inspectionWarnings(
  fields: PdfFieldDescriptor[],
  activeContent: PdfActiveContentSummary,
  contentRisk: PdfContentRisk,
  protection: PdfProtectionReport,
  xfaSemantics: XfaSemanticsResult,
): PdfEngineWarning[] {
  const warnings: PdfEngineWarning[] = [];

  if (fields.length === 0) {
    warnings.push({
      code: 'NO_ACROFORM_FIELDS',
      message: 'The PDF does not contain any AcroForm fields.',
    });
  }
  if (hasActiveContent(activeContent)) {
    warnings.push({
      code: 'ACTIVE_CONTENT_PRESERVED',
      message:
        'The original PDF contains scripts or actions. FormProof does not execute or validate them.',
    });
  }
  if (activeContent.javascriptActionCount > 0) {
    warnings.push({
      code: 'JAVASCRIPT_UNVALIDATED',
      message:
        'The original PDF contains JavaScript. FormProof does not execute or semantically validate it.',
    });
  }
  if (contentRisk.blocksPdfExport) {
    warnings.push({
      code: 'PDF_EXPORT_BLOCKED_BY_CONTENT',
      message:
        'PDF byte export and interactive preview are disabled because copying this unvalidated content into a PDF with new field data is not supported. A fill package may still be available when document protection permits it.',
    });
  }
  if (protection.protectionType === 'usage_rights') {
    warnings.push({
      code: 'USAGE_RIGHTS_DETECTED',
      message:
        'The PDF contains Reader Extensions usage rights. Rewriting would invalidate those rights; FormProof does not treat this as a user signature.',
    });
  } else if (protection.protectionType === 'document_signature') {
    warnings.push({
      code: 'DOCUMENT_SIGNATURE_PROTECTED',
      message:
        'The PDF contains a document signature. FormProof can inspect fields but will not rewrite the PDF.',
    });
  } else if (protection.protectionType === 'doc_mdp') {
    warnings.push({
      code: 'DOC_MDP_PROTECTED',
      message:
        'The PDF contains DocMDP certification. FormProof cannot independently preserve or validate that certification after a rewrite.',
    });
  } else if (protection.protectionType === 'unknown') {
    warnings.push({
      code: 'UNKNOWN_PROTECTION',
      message:
        'The PDF contains an unrecognized or malformed protection structure. PDF and fill-package export are refused.',
    });
  }
  if (protection.evidence.xfaPresent) {
    const exactMatchCount =
      xfaSemantics.status === 'available'
        ? fields.filter((field) => xfaSemantics.byExactSomName.has(field.name))
            .length
        : 0;
    const staticChoiceGroupCount = fields.filter(
      (field) =>
        field.type === 'radio' &&
        field.choices.length > 0 &&
        field.choices.every(
          ({ labelSource }) => labelSource === 'xfa_static_exact_som',
        ),
    ).length;
    warnings.push({
      code: 'XFA_PRESENT_INSPECTION_ONLY',
      message:
        xfaSemantics.status === 'available'
          ? `The PDF contains XFA. Bounded field text was read for ${exactMatchCount} of ${formatCount(fields.length, 'AcroForm fallback field')} only when full SOM names matched exactly; bounded static captions were recovered for ${formatCount(staticChoiceGroupCount, 'radio group')} only after exact export-value matching. XFA choice behavior, scripts, calculations, validation, and layout were not executed, and PDF rewriting remains disabled.`
          : 'The PDF contains XFA. Its AcroForm fallback fields remain inspectable, but agent staging is disabled because XFA field restrictions and meanings could not be resolved; PDF rewriting also remains disabled.',
    });
    if (xfaSemantics.status === 'unavailable') {
      warnings.push({
        code: 'XFA_SEMANTICS_UNAVAILABLE',
        message: `Bounded XFA field semantics were unavailable (${xfaSemantics.reason}); fallback fields are inspect-only and cannot be staged by an agent.`,
      });
    }
  }

  for (const field of fields) {
    if (field.type === 'signature') {
      warnings.push({
        code: 'SIGNATURE_FIELD_HUMAN_ONLY',
        fieldName: field.name,
        message:
          'Signature fields are shown for review but can only be completed by a person.',
      });
    } else if (field.type === 'text' && field.xfaSignatureWidget === true) {
      warnings.push({
        code: 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY',
        fieldName: field.name,
        message:
          'XFA declares this fallback text field as a signature widget, so it is reserved for human completion.',
      });
    } else if (
      field.type === 'text' &&
      hasExplicitSignatureFieldSemantics(
        field.name,
        field.tooltip,
        effectiveXfaSecurityLabel(
          field.tooltip,
          field.xfaSpeak,
          field.xfaCaption,
        ),
      )
    ) {
      warnings.push({
        code: 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY',
        fieldName: field.name,
        message:
          'This text field explicitly requests a signature and is reserved for human completion.',
      });
    } else if (field.type === 'unsupported') {
      warnings.push({
        code: 'UNSUPPORTED_FIELD_TYPE',
        fieldName: field.name,
        message: 'This AcroForm field type cannot be filled by FormProof.',
      });
    }

    if (field.widgets.some((widget) => widget.page === null)) {
      warnings.push({
        code: 'WIDGET_PAGE_UNKNOWN',
        fieldName: field.name,
        message: 'At least one widget could not be mapped to a PDF page.',
      });
    }

    if (field.widgets.some((widget) => !widget.hasAppearance)) {
      warnings.push({
        code: 'APPEARANCE_UNAVAILABLE',
        fieldName: field.name,
        message:
          'At least one widget has no verifiable normal appearance stream.',
      });
    }
  }

  return warnings;
}

function inspectLoadedPdf(
  document: PDFDocument,
  form: ReturnType<PDFDocument['getForm']>,
  sourceHash: string,
  activeContent: PdfActiveContentSummary,
  contentRisk: PdfContentRisk,
  protectionAnalysis: PdfProtectionAnalysis,
  xfaSemantics: XfaSemanticsResult,
): PdfInspection {
  const fields = form
    .getFields()
    .map((field) => describeField(document, field, xfaSemantics));
  const protection = createProtectionReport(
    protectionAnalysis,
    fields,
    contentRisk,
  );
  return {
    sourceHash,
    pageCount: document.getPageCount(),
    fieldCount: fields.length,
    widgetCount: fields.reduce((total, field) => total + field.widgetCount, 0),
    activeContent,
    contentRisk,
    protection,
    fields,
    warnings: inspectionWarnings(
      fields,
      activeContent,
      contentRisk,
      protection,
      xfaSemantics,
    ),
  };
}

export async function inspectPdf(source: Uint8Array): Promise<PdfInspection> {
  const sourceHash = await sha256Hex(source);
  const {
    document,
    form,
    activeContent,
    contentRisk,
    protectionAnalysis,
    xfaSemantics,
  } = await loadPdf(source);
  return inspectLoadedPdf(
    document,
    form,
    sourceHash,
    activeContent,
    contentRisk,
    protectionAnalysis,
    xfaSemantics,
  );
}

function invalidValueType(fieldName: string, expected: string): PdfEngineError {
  return new PdfEngineError(
    'FIELD_VALUE_TYPE_INVALID',
    `Field "${fieldName}" expects ${expected}.`,
    { fieldName, details: { expected } },
  );
}

function validateText(
  descriptor: PdfFieldDescriptor,
  value: PdfFieldValue,
): string {
  if (value !== null && typeof value !== 'string') {
    throw invalidValueType(descriptor.name, 'a string or null');
  }

  const normalized = typeof value === 'string' ? value : '';
  const length = Array.from(normalized).length;
  if (descriptor.maxLength !== null && length > descriptor.maxLength) {
    throw new PdfEngineError(
      'FIELD_VALUE_TOO_LONG',
      `Field "${descriptor.name}" is limited to ${descriptor.maxLength} characters.`,
      {
        fieldName: descriptor.name,
        details: { actualLength: length, maxLength: descriptor.maxLength },
      },
    );
  }

  return normalized;
}

function validateChoice(
  descriptor: PdfFieldDescriptor,
  value: PdfFieldValue,
): string | string[] | null {
  const expected = descriptor.multiSelect
    ? 'a string array or null'
    : 'a string or null';
  let selections: string[];

  if (value === null) selections = [];
  else if (descriptor.multiSelect && Array.isArray(value)) {
    selections = [...value];
  } else if (!descriptor.multiSelect && typeof value === 'string') {
    selections = [value];
  } else throw invalidValueType(descriptor.name, expected);

  if (!selections.every((item) => typeof item === 'string')) {
    throw invalidValueType(descriptor.name, expected);
  }

  const invalid = selections.find(
    (selection) => !descriptor.options.includes(selection),
  );
  if (invalid !== undefined) {
    throw new PdfEngineError(
      'FIELD_OPTION_INVALID',
      `"${invalid}" is not an available option for field "${descriptor.name}".`,
      {
        fieldName: descriptor.name,
        details: { invalidOption: invalid, options: descriptor.options },
      },
    );
  }

  return descriptor.multiSelect ? selections : (selections[0] ?? null);
}

type ValidatedValue = string | boolean | string[] | null;

function validateValue(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: PdfFieldValue,
): ValidatedValue {
  if (field instanceof PDFTextField) {
    return validateText(descriptor, value);
  }

  if (field instanceof PDFCheckBox) {
    if (descriptor.type === 'radio') {
      return validateChoice(descriptor, value);
    }
    if (typeof value !== 'boolean') {
      throw invalidValueType(descriptor.name, 'a boolean');
    }
    return value;
  }

  if (
    field instanceof PDFRadioGroup ||
    field instanceof PDFDropdown ||
    field instanceof PDFOptionList
  ) {
    return validateChoice(descriptor, value);
  }

  throw new PdfEngineError(
    'FIELD_TYPE_UNSUPPORTED',
    `Field "${descriptor.name}" has an unsupported AcroForm type.`,
    { fieldName: descriptor.name, details: { type: descriptor.type } },
  );
}

function validateGlyphs(
  fieldName: string,
  textValues: string[],
  encode: (text: string) => unknown,
): void {
  for (const text of textValues) {
    try {
      encode(text);
    } catch (cause) {
      throw new PdfEngineError(
        'FIELD_GLYPH_UNSUPPORTED',
        `Field "${fieldName}" contains characters that cannot be rendered with the built-in PDF font.`,
        { fieldName, details: { value: text }, cause },
      );
    }
  }
}

function selectedChoiceValues(value: ValidatedValue): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function choiceLabel(descriptor: PdfFieldDescriptor, value: string): string {
  return (
    descriptor.choices.find((choice) => choice.value === value)?.label ?? value
  );
}

function multilineAppearanceTextValues(value: string): string[] {
  const lines = [''];
  for (const character of value) {
    if (
      character === '\t' ||
      character === '\u0085' ||
      character === '\u2028' ||
      character === '\u2029'
    ) {
      lines[lines.length - 1] += '    ';
    } else if (character === '\u0008' || character === '\u000B') {
      continue;
    } else if (character === '\n' || character === '\f' || character === '\r') {
      lines.push('');
    } else {
      lines[lines.length - 1] += character;
    }
  }
  return lines;
}

function appearanceTextValues(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: ValidatedValue,
): string[] {
  if (field instanceof PDFTextField) {
    if (typeof value !== 'string') return [];
    return field.isMultiline() ? multilineAppearanceTextValues(value) : [value];
  }
  if (field instanceof PDFOptionList) {
    return descriptor.choices.map((choice) => choice.label);
  }
  if (field instanceof PDFDropdown) {
    return selectedChoiceValues(value).map((selection) =>
      choiceLabel(descriptor, selection),
    );
  }
  return [];
}

function decodedDefaultAppearance(field: PDFField): string | null {
  const appearance = field.acroField.DA();
  if (appearance instanceof PDFString || appearance instanceof PDFHexString) {
    return appearance.decodeText();
  }
  return null;
}

function fieldFontSize(appearance: string | null): number | null {
  if (!appearance) return null;

  const matches = [
    ...appearance.matchAll(/([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+Tf\b/g),
  ];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function preserveFieldTypography(
  field: PDFField,
  defaultAppearance: string | null,
  fontSize: number | null,
): void {
  if (fontSize === null) return;
  if (
    field instanceof PDFTextField ||
    field instanceof PDFDropdown ||
    field instanceof PDFOptionList
  ) {
    if (defaultAppearance !== null) {
      field.acroField.setDefaultAppearance(defaultAppearance);
    }
    field.setFontSize(fontSize);
  }
}

function applyValue(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: ValidatedValue,
): void {
  if (field instanceof PDFTextField && typeof value === 'string') {
    field.setText(value);
    return;
  }

  if (field instanceof PDFCheckBox && descriptor.type === 'radio') {
    const option = typeof value === 'string' ? value : null;
    field.acroField.dict.set(PDFName.of('V'), PDFName.of(option ?? 'Off'));

    let selected = false;
    for (const widget of field.acroField.getWidgets()) {
      const onValue = widget.getOnValue();
      const matches =
        !selected && option !== null && onValue?.decodeText() === option;
      widget.setAppearanceState(matches ? onValue : PDFName.of('Off'));
      if (matches) selected = true;
    }
    return;
  }

  if (field instanceof PDFCheckBox && typeof value === 'boolean') {
    if (value) field.check();
    else field.uncheck();
    return;
  }

  if (field instanceof PDFRadioGroup) {
    if (typeof value === 'string') field.select(value);
    else field.clear();
    return;
  }

  if (field instanceof PDFDropdown) {
    const wasEditable = field.isEditable();
    const labels = selectedChoiceValues(value).map((selection) =>
      choiceLabel(descriptor, selection),
    );
    if (labels.length === 0) field.clear();
    else field.select(labels.length === 1 ? labels[0] : labels);
    if (wasEditable) field.enableEditing();
    else field.disableEditing();
    return;
  }

  if (field instanceof PDFOptionList) {
    const labels = selectedChoiceValues(value).map((selection) =>
      choiceLabel(descriptor, selection),
    );
    if (labels.length === 0) field.clear();
    else field.select(labels);
  }
}

function restoreChoiceExportValues(
  field: PDFField,
  value: ValidatedValue,
): void {
  if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) return;

  const selections = selectedChoiceValues(value);
  const dictionary = field.acroField.dict;
  if (selections.length === 0) {
    dictionary.delete(PDFName.of('V'));
    dictionary.delete(PDFName.of('I'));
    return;
  }

  const encoded = selections.map((selection) =>
    PDFHexString.fromText(selection),
  );
  if (encoded.length === 1) {
    dictionary.set(PDFName.of('V'), encoded[0]);
    dictionary.delete(PDFName.of('I'));
    return;
  }

  dictionary.set(PDFName.of('V'), dictionary.context.obj(encoded));
  const rawOptions = field.acroField.getOptions();
  const indices = selections
    .map((selection) =>
      rawOptions.findIndex(({ value }) => value.decodeText() === selection),
    )
    .sort((left, right) => left - right);
  dictionary.set(PDFName.of('I'), dictionary.context.obj(indices));
}

function valuesMatch(actual: PdfFieldValue, expected: ValidatedValue): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    const actualItems = Array.isArray(actual) ? [...actual].sort() : [];
    const expectedItems = Array.isArray(expected) ? [...expected].sort() : [];
    return JSON.stringify(actualItems) === JSON.stringify(expectedItems);
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function verifyButtonWidgetValues(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  expected: ValidatedValue,
): void {
  if (!(field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) return;

  const states = field.acroField
    .getWidgets()
    .map((widget) => widget.getAppearanceState()?.decodeText() ?? null);

  if (field instanceof PDFCheckBox) {
    if (descriptor.type === 'radio') {
      const selectedStates = states.filter((state) => state !== 'Off');
      const matches =
        expected === null
          ? states.every((state) => state === 'Off')
          : typeof expected === 'string' &&
            selectedStates.length === 1 &&
            selectedStates[0] === expected;
      if (matches) return;
    } else {
      const matches = expected
        ? states.every((state) => state !== null && state !== 'Off')
        : states.every((state) => state === 'Off');
      if (matches) return;
    }
  } else {
    const exportValues = field.acroField.getExportValues();
    const optionIndex =
      typeof expected === 'string'
        ? (exportValues ?? []).findIndex(
            (value) => value.decodeText() === expected,
          )
        : -1;
    const expectedAppearance =
      optionIndex >= 0
        ? (field.acroField.getOnValues()[optionIndex]?.decodeText() ?? expected)
        : expected;
    const matches =
      expected === null
        ? states.every((state) => state === 'Off')
        : states.some((state) => state === expectedAppearance) &&
          states.every(
            (state) => state === expectedAppearance || state === 'Off',
          );
    if (matches) return;
  }

  throw new PdfEngineError(
    'PDF_VERIFY_WIDGET_VALUE_MISMATCH',
    `Widget appearance states do not match field "${descriptor.name}".`,
    {
      fieldName: descriptor.name,
      details: { expected, states },
    },
  );
}

function clearSignatureFlags(document: PDFDocument): void {
  const acroForm = document.catalog.AcroForm();
  if (!acroForm) return;
  const flags = dictionaryNumber(acroForm, 'SigFlags');
  if (
    flags === null ||
    !Number.isSafeInteger(flags) ||
    flags < 0 ||
    flags > 3
  ) {
    return;
  }
  acroForm.delete(PDFName.of('SigFlags'));
}

function removeUsageRightsForDerivative(
  document: PDFDocument,
  analysis: PdfProtectionAnalysis,
): void {
  document.catalog.delete(PDFName.of('Perms'));
  for (const reference of analysis.usageRightsRefs) {
    document.context.delete(reference);
  }
  if (analysis.permsRef) document.context.delete(analysis.permsRef);
  clearSignatureFlags(document);
}

function mutationError(
  report: PdfProtectionReport,
  strategy: 'filled_pdf' | 'confirmed_plain_derivative_pdf',
): PdfEngineError | null {
  if (report.protectionType === 'unknown') {
    return new PdfEngineError(
      'PDF_UNKNOWN_PROTECTION_UNSUPPORTED',
      'This PDF contains an unknown or malformed protection structure. FormProof refuses PDF and fill-package export.',
      {
        details: {
          strategy,
          unknownStructures: report.evidence.unknownStructures,
        },
      },
    );
  }
  if (report.protectionType === 'document_signature') {
    return new PdfEngineError(
      'PDF_SIGNED_UNSUPPORTED',
      'This PDF contains a document signature. FormProof will not rewrite it because pdf-lib cannot make an incremental update and independently verify the signature afterward.',
      { details: { strategy } },
    );
  }
  if (report.protectionType === 'doc_mdp') {
    return new PdfEngineError(
      'PDF_CERTIFIED_UNSUPPORTED',
      'This PDF contains DocMDP certification. FormProof will not rewrite it because the certification permission and signature cannot be preserved and independently verified.',
      {
        details: {
          strategy,
          docMdpPermission: report.evidence.docMdpPermission,
        },
      },
    );
  }
  if (report.evidence.xfaPresent) {
    return new PdfEngineError(
      'PDF_XFA_UNSUPPORTED',
      'This PDF contains XFA. FormProof can inspect its AcroForm fallback and create a fill package, but will not rewrite the PDF because XFA behavior cannot be preserved or verified.',
      { details: { strategy } },
    );
  }
  if (strategy === 'filled_pdf' && report.protectionType === 'usage_rights') {
    return new PdfEngineError(
      'PDF_DERIVATIVE_CONFIRMATION_REQUIRED',
      'This PDF has Reader Extensions usage rights. A person must explicitly choose the ordinary derivative strategy, which removes those rights.',
      { details: { strategy } },
    );
  }
  if (
    strategy === 'confirmed_plain_derivative_pdf' &&
    report.protectionType !== 'usage_rights'
  ) {
    return new PdfEngineError(
      'PDF_DERIVATIVE_CONFIRMATION_REQUIRED',
      'The ordinary derivative strategy is available only for recognized usage-rights-only AcroForms.',
      {
        details: {
          strategy,
          protectionType: report.protectionType,
        },
      },
    );
  }
  return null;
}

async function applyValues(
  source: Uint8Array,
  values: Record<string, PdfFieldValue>,
  exportStrategy: 'filled_pdf' | 'confirmed_plain_derivative_pdf',
  humanConfirmedDerivative: boolean,
): Promise<ApplyResult> {
  const sourceHash = await sha256Hex(source);
  const loaded = await loadPdf(source);
  const {
    document,
    form,
    activeContent,
    contentRisk,
    protectionAnalysis,
    xfaSemantics,
  } = loaded;
  const descriptors = form
    .getFields()
    .map((field) => describeField(document, field, xfaSemantics));
  const sourceProtection = createProtectionReport(
    protectionAnalysis,
    descriptors,
    contentRisk,
  );

  if (
    exportStrategy === 'confirmed_plain_derivative_pdf' &&
    !humanConfirmedDerivative
  ) {
    throw new PdfEngineError(
      'PDF_DERIVATIVE_CONFIRMATION_REQUIRED',
      'A person must confirm that Reader Extensions usage rights will be removed before creating an ordinary derivative PDF.',
    );
  }
  const blocked = mutationError(sourceProtection, exportStrategy);
  if (blocked) throw blocked;

  if (contentRisk.blocksPdfExport) {
    throw new PdfEngineError(
      'PDF_HIGH_RISK_ACTION_UNSUPPORTED',
      'This PDF contains unvalidated active content, external links, or embedded payloads. FormProof will not copy it into a PDF containing new field data.',
      {
        details: {
          reasonCodes: contentRisk.reasons.map(({ code }) => code),
        },
      },
    );
  }

  if (exportStrategy === 'confirmed_plain_derivative_pdf') {
    removeUsageRightsForDerivative(document, protectionAnalysis);
  }

  const entries = Object.entries(values);
  if (entries.length === 0 && exportStrategy === 'filled_pdf') {
    const unchanged = copyBytes(source);
    const inspection = inspectLoadedPdf(
      document,
      form,
      sourceHash,
      activeContent,
      contentRisk,
      protectionAnalysis,
      xfaSemantics,
    );
    return {
      bytes: unchanged,
      sourceHash,
      outputHash: sourceHash,
      fieldCount: inspection.fieldCount,
      widgetCount: inspection.widgetCount,
      activeContent: inspection.activeContent,
      contentRisk: inspection.contentRisk,
      exportStrategy,
      sourceProtection,
      outputProtection: sourceProtection,
      verifiedFields: [],
      warnings: inspection.warnings,
    };
  }

  const font = await document.embedFont(StandardFonts.Helvetica);
  const validated = new Map<
    string,
    {
      field: PDFField;
      descriptor: PdfFieldDescriptor;
      value: ValidatedValue;
      defaultAppearance: string | null;
      fontSize: number | null;
    }
  >();

  for (const [fieldName, requestedValue] of entries) {
    const field = form.getFieldMaybe(fieldName);
    if (!field) {
      throw new PdfEngineError(
        'FIELD_NOT_FOUND',
        `Field "${fieldName}" does not exist in this PDF.`,
        { fieldName },
      );
    }

    const descriptor = describeField(document, field);
    if (field instanceof PDFSignature) {
      throw new PdfEngineError(
        'FIELD_SIGNATURE_UNSUPPORTED',
        `Signature field "${fieldName}" must be completed by a person in a PDF reader.`,
        { fieldName },
      );
    }
    if (descriptor.readOnly) {
      throw new PdfEngineError(
        'FIELD_READ_ONLY',
        `Field "${fieldName}" is read-only.`,
        { fieldName },
      );
    }
    if (descriptor.humanOnly) {
      throw new PdfEngineError(
        'FIELD_HUMAN_ONLY',
        `Field "${fieldName}" is reserved for human completion.`,
        { fieldName },
      );
    }
    if (descriptor.type === 'unsupported') {
      throw new PdfEngineError(
        'FIELD_TYPE_UNSUPPORTED',
        `Field "${fieldName}" has an unsupported AcroForm type.`,
        { fieldName },
      );
    }

    const value = validateValue(field, descriptor, requestedValue);
    validateGlyphs(
      fieldName,
      appearanceTextValues(field, descriptor, value),
      (text) => font.encodeText(text),
    );
    const defaultAppearance = decodedDefaultAppearance(field);
    validated.set(fieldName, {
      field,
      descriptor,
      value,
      defaultAppearance,
      fontSize: fieldFontSize(defaultAppearance),
    });
  }

  try {
    for (const {
      field,
      descriptor,
      value,
      defaultAppearance,
      fontSize,
    } of validated.values()) {
      applyValue(field, descriptor, value);
      preserveFieldTypography(field, defaultAppearance, fontSize);
    }
    for (const { field, descriptor, value } of validated.values()) {
      if (
        field instanceof PDFTextField ||
        field instanceof PDFDropdown ||
        field instanceof PDFOptionList
      ) {
        field.defaultUpdateAppearances(font);
      } else if (field instanceof PDFCheckBox && descriptor.type !== 'radio') {
        field.defaultUpdateAppearances();
      } else if (field instanceof PDFRadioGroup) {
        field.defaultUpdateAppearances();
      }
      restoreChoiceExportValues(field, value);
    }
  } catch (cause) {
    if (cause instanceof PdfEngineError) throw cause;
    throw new PdfEngineError(
      'PDF_APPLY_FAILED',
      'The approved field values could not be applied to a fresh PDF copy.',
      { cause },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await document.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: true,
    });
  } catch (cause) {
    throw new PdfEngineError(
      'PDF_APPLY_FAILED',
      'The updated PDF could not be serialized.',
      { cause },
    );
  }

  const outputHash = await sha256Hex(bytes);
  const reopened = await loadPdf(bytes);
  const verifiedFields: VerifiedPdfField[] = [];

  for (const [fieldName, planned] of validated) {
    const reopenedField = reopened.form.getFieldMaybe(fieldName);
    if (!reopenedField) {
      throw new PdfEngineError(
        'PDF_VERIFY_FIELD_MISSING',
        `Field "${fieldName}" disappeared after saving the PDF.`,
        { fieldName },
      );
    }

    const descriptor = describeField(reopened.document, reopenedField);
    if (!valuesMatch(descriptor.current, planned.value)) {
      throw new PdfEngineError(
        'PDF_VERIFY_VALUE_MISMATCH',
        `Field "${fieldName}" did not retain its approved value after reopening.`,
        {
          fieldName,
          details: { expected: planned.value, actual: descriptor.current },
        },
      );
    }
    if (descriptor.widgetCount === 0) {
      throw new PdfEngineError(
        'PDF_VERIFY_WIDGET_MISSING',
        `Field "${fieldName}" has no widget after saving.`,
        { fieldName },
      );
    }
    if (descriptor.widgets.some((widget) => widget.page === null)) {
      throw new PdfEngineError(
        'PDF_VERIFY_WIDGET_PAGE_MISSING',
        `A widget for field "${fieldName}" is no longer attached to a page.`,
        { fieldName },
      );
    }
    if (descriptor.widgets.some((widget) => !widget.hasAppearance)) {
      throw new PdfEngineError(
        'PDF_VERIFY_APPEARANCE_MISSING',
        `A widget for field "${fieldName}" has no normal appearance stream after saving.`,
        { fieldName },
      );
    }

    verifyButtonWidgetValues(reopenedField, descriptor, planned.value);
    verifiedFields.push({
      name: fieldName,
      type: descriptor.type,
      value: descriptor.current,
      widgetCount: descriptor.widgetCount,
      normalAppearancePresent: true,
    });
  }

  const inspection = inspectLoadedPdf(
    reopened.document,
    reopened.form,
    outputHash,
    reopened.activeContent,
    reopened.contentRisk,
    reopened.protectionAnalysis,
    reopened.xfaSemantics,
  );
  if (
    inspection.protection.protectionType !== 'none' ||
    inspection.protection.evidence.xfaPresent
  ) {
    throw new PdfEngineError(
      'PDF_VERIFY_PROTECTION_MISMATCH',
      'The exported PDF still contains an active signature, certification, usage-rights, XFA, or unknown protection structure.',
      {
        details: {
          protectionType: inspection.protection.protectionType,
          xfaPresent: inspection.protection.evidence.xfaPresent,
        },
      },
    );
  }

  return {
    bytes,
    sourceHash,
    outputHash,
    fieldCount: inspection.fieldCount,
    widgetCount: inspection.widgetCount,
    activeContent: inspection.activeContent,
    contentRisk: inspection.contentRisk,
    exportStrategy,
    sourceProtection,
    outputProtection: inspection.protection,
    verifiedFields,
    warnings: inspection.warnings,
  };
}

export async function applyApprovedValues(
  source: Uint8Array,
  values: Record<string, PdfFieldValue>,
): Promise<ApplyResult> {
  return applyValues(source, values, 'filled_pdf', false);
}

export async function applyConfirmedDerivativeValues(
  source: Uint8Array,
  values: Record<string, PdfFieldValue>,
  options: { readonly humanConfirmedProtectionLoss: boolean },
): Promise<ApplyResult> {
  return applyValues(
    source,
    values,
    'confirmed_plain_derivative_pdf',
    options.humanConfirmedProtectionLoss,
  );
}
