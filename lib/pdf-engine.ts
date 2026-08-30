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
  | 'USAGE_RIGHTS_DETECTED'
  | 'XFA_PRESENT_INSPECTION_ONLY'
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
}

export interface PdfFieldDescriptor {
  name: string;
  type: PdfFieldType;
  current: PdfFieldValue;
  options: string[];
  choices: PdfChoiceDescriptor[];
  multiSelect: boolean;
  required: boolean;
  readOnly: boolean;
  humanOnly: boolean;
  page: number | null;
  rect: PdfRect | null;
  maxLength: number | null;
  tooltip: string | null;
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
  protectionAnalysis: PdfProtectionAnalysis;
}

interface PdfProtectionAnalysis {
  protectionType: PdfProtectionType;
  evidence: PdfProtectionEvidence;
  usageRightsRefs: PDFRef[];
  permsRef: PDFRef | null;
}

const HUMAN_ONLY_MARKER = /\[\s*HUMAN[_ -]?ONLY\s*\]/i;
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

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
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

  while (pending.length > 0) {
    const object = pending.pop();
    if (object === undefined || seen.has(object)) continue;
    seen.add(object);

    if (object instanceof PDFRef) {
      const resolved = document.context.lookup(object);
      if (resolved !== undefined) pending.push(resolved);
    } else if (object instanceof PDFStream) {
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      dictionaries.push(object);
      pending.push(...object.values());
    } else if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index += 1) {
        pending.push(object.get(index));
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
  const unreachable: PDFDict[] = [];
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (
      object instanceof PDFDict &&
      !reachable.has(object) &&
      (dictionaryName(object, 'Type') === 'Sig' ||
        object.has(PDFName.of('ByteRange')))
    ) {
      unreachable.push(object);
    }
  }
  return unreachable;
}

function dictionaryName(dictionary: PDFDict, key: string): string | null {
  const value = dictionary.context.lookup(dictionary.get(PDFName.of(key)));
  return value instanceof PDFName ? value.decodeText() : null;
}

function explicitlyReferencedActions(
  document: PDFDocument,
  dictionaries: readonly PDFDict[],
): ReadonlySet<PDFDict> {
  const actions = new Set<PDFDict>();
  const pending: PDFDict[] = [];

  const addAction = (object: PDFObject | undefined) => {
    if (object === undefined) return;
    const resolved = document.context.lookup(object);
    if (resolved instanceof PDFArray) {
      for (let index = 0; index < resolved.size(); index += 1) {
        addAction(resolved.get(index));
      }
    } else if (
      resolved instanceof PDFDict &&
      dictionaryName(resolved, 'S') !== null &&
      !actions.has(resolved)
    ) {
      actions.add(resolved);
      pending.push(resolved);
    }
  };

  for (const dictionary of dictionaries) {
    addAction(dictionary.get(PDFName.of('A')));
    addAction(dictionary.get(PDFName.of('NA')));
    const additionalActions = document.context.lookup(
      dictionary.get(PDFName.of('AA')),
    );
    if (additionalActions instanceof PDFDict) {
      for (const action of additionalActions.values()) addAction(action);
    }
  }
  addAction(document.catalog.get(PDFName.of('OpenAction')));

  const names = document.context.lookup(
    document.catalog.get(PDFName.of('Names')),
  );
  const javaScriptNameTree =
    names instanceof PDFDict
      ? document.context.lookup(names.get(PDFName.of('JavaScript')))
      : undefined;
  const seenNameTrees = new Set<PDFDict>();
  const pendingNameTrees =
    javaScriptNameTree instanceof PDFDict ? [javaScriptNameTree] : [];
  while (pendingNameTrees.length > 0) {
    const tree = pendingNameTrees.pop();
    if (tree === undefined || seenNameTrees.has(tree)) continue;
    seenNameTrees.add(tree);

    const entries = document.context.lookup(tree.get(PDFName.of('Names')));
    if (entries instanceof PDFArray) {
      for (let index = 1; index < entries.size(); index += 2) {
        addAction(entries.get(index));
      }
    }
    const kids = document.context.lookup(tree.get(PDFName.of('Kids')));
    if (kids instanceof PDFArray) {
      for (let index = 0; index < kids.size(); index += 1) {
        const child = document.context.lookup(kids.get(index));
        if (child instanceof PDFDict) pendingNameTrees.push(child);
      }
    }
  }

  while (pending.length > 0) {
    addAction(pending.pop()?.get(PDFName.of('Next')));
  }
  return actions;
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

  const hasCmsCandidate = signatureCandidates.size > 0;
  return {
    protectionType,
    evidence: {
      catalogPermsPresent,
      permsKeys,
      usageRightsKeys,
      byteRangeEntryCount: byteRangeEntries.length,
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

function summarizeActiveContent(
  document: PDFDocument,
  dictionaries: readonly PDFDict[],
): PdfActiveContentSummary {
  const referencedActions = explicitlyReferencedActions(document, dictionaries);
  const additionalActions = new Set<PDFDict>();
  let javascriptActionCount = 0;
  let externalActionCount = 0;
  let highRiskActionCount = 0;
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
      actionType !== null &&
      REPORT_ONLY_ACTION_TYPES.has(actionType)
    ) {
      otherActionCount += 1;
    } else if (actionType !== null && referencedActions.has(dictionary)) {
      highRiskActionCount += 1;
    }
  }

  return {
    javascriptActionCount,
    additionalActionDictionaryCount: additionalActions.size,
    openActionCount: document.catalog.has(PDFName.of('OpenAction')) ? 1 : 0,
    externalActionCount,
    highRiskActionCount,
    otherActionCount,
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
  activeContent: PdfActiveContentSummary,
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
  if (canStage) allowedMutations.push('stage_field_values');

  const pdfActionsAllowExport = activeContent.highRiskActionCount === 0;
  if (canStage && analysis.protectionType !== 'unknown') {
    allowedMutations.push('create_fill_package');
    exportStrategies.push('fill_package');
  }
  if (
    canStage &&
    pdfActionsAllowExport &&
    analysis.protectionType === 'none' &&
    !analysis.evidence.xfaPresent
  ) {
    allowedMutations.push('create_filled_pdf');
    exportStrategies.unshift('filled_pdf');
  }
  if (
    canStage &&
    pdfActionsAllowExport &&
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

  const dictionaries = collectPdfDictionaries(document);
  const unreachableSignatureDictionaries =
    collectUnreachableSignatureDictionaries(document, dictionaries);
  const activeContent = summarizeActiveContent(document, dictionaries);
  const form = inspectionForm(document);
  const protectionAnalysis = analyzeProtection(
    document,
    [...dictionaries, ...unreachableSignatureDictionaries],
    form,
    bytes.byteLength,
    unreachableSignatureDictionaries,
  );

  return { document, form, activeContent, protectionAnalysis };
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

function isSignatureSemanticTextField(
  field: PDFField,
  tooltip: string | null,
): boolean {
  if (!(field instanceof PDFTextField)) return false;
  return hasExplicitSignatureSemantics(field.getName(), tooltip);
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

function isHumanOnly(
  field: PDFField,
  type: PdfFieldType,
  tooltip: string | null,
): boolean {
  return (
    type === 'signature' ||
    isSignatureSemanticTextField(field, tooltip) ||
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
      });
    }
    return choices;
  }
  const recoveredOptions = recoveredCheckBoxRadioOptions(field);
  if (recoveredOptions) {
    return recoveredOptions.map((value) => ({ value, label: value }));
  }
  if (field instanceof PDFRadioGroup) {
    return field.getOptions().map((value) => ({ value, label: value }));
  }
  return [];
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
): PdfFieldDescriptor {
  const type = fieldType(field);
  const tooltip = fieldTooltip(field);
  const widgets = describeWidgets(document, field);
  const choices = fieldChoices(field);

  return {
    name: field.getName(),
    type,
    current: fieldValue(field),
    options: choices.map((choice) => choice.value),
    choices,
    multiSelect: fieldAllowsMultiple(field),
    required: field.isRequired(),
    readOnly: field.isReadOnly(),
    humanOnly: isHumanOnly(field, type, tooltip),
    page: widgets[0]?.page ?? null,
    rect: widgets[0]?.rect ?? null,
    maxLength:
      field instanceof PDFTextField ? (field.getMaxLength() ?? null) : null,
    tooltip,
    widgetCount: widgets.length,
    widgets,
  };
}

function inspectionWarnings(
  fields: PdfFieldDescriptor[],
  activeContent: PdfActiveContentSummary,
  protection: PdfProtectionReport,
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
        'The PDF contains scripts or actions. They are preserved, but FormProof does not execute or validate them.',
    });
  }
  if (activeContent.javascriptActionCount > 0) {
    warnings.push({
      code: 'JAVASCRIPT_UNVALIDATED',
      message:
        'The PDF contains JavaScript that is preserved, but FormProof does not execute or semantically validate it.',
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
    warnings.push({
      code: 'XFA_PRESENT_INSPECTION_ONLY',
      message:
        'The PDF contains XFA. Only its AcroForm fallback fields are inspected; XFA scripts, validation, layout, and semantics are not evaluated, so PDF rewriting is disabled.',
    });
  }

  for (const field of fields) {
    if (field.type === 'signature') {
      warnings.push({
        code: 'SIGNATURE_FIELD_HUMAN_ONLY',
        fieldName: field.name,
        message:
          'Signature fields are shown for review but can only be completed by a person.',
      });
    } else if (
      field.type === 'text' &&
      hasExplicitSignatureSemantics(field.name, field.tooltip)
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
  protectionAnalysis: PdfProtectionAnalysis,
): PdfInspection {
  const fields = form
    .getFields()
    .map((field) => describeField(document, field));
  const protection = createProtectionReport(
    protectionAnalysis,
    fields,
    activeContent,
  );
  return {
    sourceHash,
    pageCount: document.getPageCount(),
    fieldCount: fields.length,
    widgetCount: fields.reduce((total, field) => total + field.widgetCount, 0),
    activeContent,
    protection,
    fields,
    warnings: inspectionWarnings(fields, activeContent, protection),
  };
}

export async function inspectPdf(source: Uint8Array): Promise<PdfInspection> {
  const sourceHash = await sha256Hex(source);
  const { document, form, activeContent, protectionAnalysis } =
    await loadPdf(source);
  return inspectLoadedPdf(
    document,
    form,
    sourceHash,
    activeContent,
    protectionAnalysis,
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

function appearanceTextValues(
  field: PDFField,
  descriptor: PdfFieldDescriptor,
  value: ValidatedValue,
): string[] {
  if (field instanceof PDFTextField) {
    return typeof value === 'string' ? [value] : [];
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
  const { document, form, activeContent, protectionAnalysis } = loaded;
  const descriptors = form
    .getFields()
    .map((field) => describeField(document, field));
  const sourceProtection = createProtectionReport(
    protectionAnalysis,
    descriptors,
    activeContent,
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

  if (activeContent.highRiskActionCount > 0) {
    throw new PdfEngineError(
      'PDF_HIGH_RISK_ACTION_UNSUPPORTED',
      'PDFs with external launch, remote navigation, submit, import, or unrecognized actions cannot be exported safely.',
      {
        details: {
          highRiskActionCount: activeContent.highRiskActionCount,
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
      protectionAnalysis,
    );
    return {
      bytes: unchanged,
      sourceHash,
      outputHash: sourceHash,
      fieldCount: inspection.fieldCount,
      widgetCount: inspection.widgetCount,
      activeContent: inspection.activeContent,
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
    reopened.protectionAnalysis,
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
