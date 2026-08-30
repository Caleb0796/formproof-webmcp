import {
  EncryptedPDFError,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFHexString,
  PDFName,
  PDFNull,
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
    'XFA forms',
    'signed PDFs',
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
  | 'PDF_VERIFY_WIDGET_VALUE_MISMATCH';

export type PdfEngineWarningCode =
  | 'NO_ACROFORM_FIELDS'
  | 'SIGNATURE_FIELD_HUMAN_ONLY'
  | 'SIGNATURE_TEXT_FIELD_HUMAN_ONLY'
  | 'UNSUPPORTED_FIELD_TYPE'
  | 'WIDGET_PAGE_UNKNOWN'
  | 'APPEARANCE_UNAVAILABLE'
  | 'JAVASCRIPT_UNVALIDATED'
  | 'ACTIVE_CONTENT_PRESERVED';

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
  fields: PdfFieldDescriptor[];
  warnings: PdfEngineWarning[];
}

export interface VerifiedPdfField {
  name: string;
  type: PdfFieldType;
  value: PdfFieldValue;
  widgetCount: number;
  appearanceVerified: boolean;
}

export interface ApplyResult {
  bytes: Uint8Array;
  sourceHash: string;
  outputHash: string;
  fieldCount: number;
  widgetCount: number;
  activeContent: PdfActiveContentSummary;
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

function ensureNoRestrictedSignatureStructures(
  document: PDFDocument,
  dictionaries: readonly PDFDict[],
): void {
  let structure: string | null = document.catalog.has(PDFName.of('Perms'))
    ? 'catalog /Perms'
    : null;
  let fieldName: string | undefined;
  const signatureFieldValues = new Map<PDFObject, string>();

  for (const dictionary of dictionaries) {
    if (dictionaryName(dictionary, 'FT') !== 'Sig') continue;
    const value = dictionary.context.lookup(dictionary.get(PDFName.of('V')));
    const partialName = dictionary.context.lookup(
      dictionary.get(PDFName.of('T')),
    );
    if (
      value !== undefined &&
      (partialName instanceof PDFString || partialName instanceof PDFHexString)
    ) {
      signatureFieldValues.set(value, partialName.decodeText());
    }
  }

  for (const dictionary of dictionaries) {
    if (structure !== null) break;

    const type = dictionaryName(dictionary, 'Type');
    const transformMethod = dictionaryName(dictionary, 'TransformMethod');
    if (type === 'Sig') structure = 'signature dictionary';
    else if (dictionary.has(PDFName.of('ByteRange'))) {
      structure = '/ByteRange';
    } else if (
      dictionary.has(PDFName.of('DocMDP')) ||
      transformMethod === 'DocMDP'
    ) {
      structure = '/DocMDP';
    } else if (dictionary.has(PDFName.of('UR3')) || transformMethod === 'UR3') {
      structure = '/UR3';
    }

    if (structure !== null) fieldName = signatureFieldValues.get(dictionary);
  }

  if (structure !== null) {
    throw new PdfEngineError(
      'PDF_SIGNED_UNSUPPORTED',
      'Signed or usage-rights-certified PDFs cannot be modified because saving could invalidate their protections.',
      { fieldName, details: { structure } },
    );
  }
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
  ensureNoRestrictedSignatureStructures(document, dictionaries);
  const activeContent = summarizeActiveContent(document, dictionaries);

  const acroFormDictionary = document.catalog.AcroForm();
  if (acroFormDictionary?.has(PDFName.of('XFA'))) {
    throw new PdfEngineError(
      'PDF_XFA_UNSUPPORTED',
      'XFA forms are not supported. Use a standard AcroForm PDF.',
    );
  }

  const form = document.getForm();
  ensureNoExistingSignatures(form);

  return { document, form, activeContent };
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
): PdfInspection {
  const fields = form
    .getFields()
    .map((field) => describeField(document, field));
  return {
    sourceHash,
    pageCount: document.getPageCount(),
    fieldCount: fields.length,
    widgetCount: fields.reduce((total, field) => total + field.widgetCount, 0),
    activeContent,
    fields,
    warnings: inspectionWarnings(fields, activeContent),
  };
}

export async function inspectPdf(source: Uint8Array): Promise<PdfInspection> {
  const sourceHash = await sha256Hex(source);
  const { document, form, activeContent } = await loadPdf(source);
  return inspectLoadedPdf(document, form, sourceHash, activeContent);
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

function ensureNoExistingSignatures(
  form: ReturnType<PDFDocument['getForm']>,
): void {
  const signedField = form
    .getFields()
    .find(
      (field) =>
        field instanceof PDFSignature &&
        field.acroField.V() !== undefined &&
        field.acroField.V() !== PDFNull,
    );

  if (signedField) {
    throw new PdfEngineError(
      'PDF_SIGNED_UNSUPPORTED',
      'Signed PDFs cannot be modified because saving would invalidate the existing signature.',
      { fieldName: signedField.getName() },
    );
  }
}

export async function applyApprovedValues(
  source: Uint8Array,
  values: Record<string, PdfFieldValue>,
): Promise<ApplyResult> {
  const sourceHash = await sha256Hex(source);
  const { document, form, activeContent } = await loadPdf(source);

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

  const entries = Object.entries(values);
  if (entries.length === 0) {
    const unchanged = copyBytes(source);
    const inspection = inspectLoadedPdf(
      document,
      form,
      sourceHash,
      activeContent,
    );
    return {
      bytes: unchanged,
      sourceHash,
      outputHash: sourceHash,
      fieldCount: inspection.fieldCount,
      widgetCount: inspection.widgetCount,
      activeContent: inspection.activeContent,
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
      appearanceVerified: true,
    });
  }

  const inspection = inspectLoadedPdf(
    reopened.document,
    reopened.form,
    outputHash,
    reopened.activeContent,
  );

  return {
    bytes,
    sourceHash,
    outputHash,
    fieldCount: inspection.fieldCount,
    widgetCount: inspection.widgetCount,
    activeContent: inspection.activeContent,
    verifiedFields,
    warnings: inspection.warnings,
  };
}
