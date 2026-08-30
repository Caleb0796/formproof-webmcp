import type {
  ApplyResult,
  PdfFieldDescriptor,
  PdfFieldValue,
} from './pdf-engine.ts';

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'option-list'
  | 'signature';

export type FormFieldValue = string | boolean | readonly string[] | null;

export type ProvenanceKind =
  | 'user_instruction'
  | 'source_document'
  | 'agent_inference'
  | 'human_entry';

export type UpdateActor = 'agent' | 'human';

export interface SourceMetadata {
  readonly fileName: string;
  readonly sourceHash: string;
  readonly byteLength: number;
  readonly pageCount: number;
  readonly loadedAt?: string;
}

export interface FormFieldDefinition {
  readonly name: string;
  readonly label: string;
  readonly type: FormFieldType;
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly humanOnly: boolean;
  readonly options?: readonly string[];
  readonly multiSelect?: boolean;
  readonly maxLength?: number;
  readonly sourceValue: FormFieldValue;
}

const HUMAN_ONLY_MARKER = /\[\s*HUMAN[_ -]?ONLY\s*\]/gi;
// Long PDF help text is instruction content, not a concise field label.
const MAX_TOOLTIP_LABEL_LENGTH = 180;

export function createFormFieldDefinitionFromPdf(
  field: PdfFieldDescriptor,
): FormFieldDefinition {
  const tooltip = field.tooltip?.replace(HUMAN_ONLY_MARKER, '').trim();
  const normalizedTooltip =
    tooltip !== undefined &&
    tooltip.length <= MAX_TOOLTIP_LABEL_LENGTH &&
    tooltip.toLowerCase() !== 'undefined' &&
    tooltip.toLowerCase() !== 'null'
      ? tooltip
      : undefined;
  const label =
    normalizedTooltip?.split(/\s+[–—-]\s+/u)[0]?.trim() || field.name;
  const unsupported = field.type === 'unsupported';
  return {
    name: field.name,
    label,
    type:
      field.type === 'option_list'
        ? 'option-list'
        : field.type === 'unsupported'
          ? 'text'
          : field.type,
    required: field.required,
    readOnly: field.readOnly || unsupported,
    humanOnly: field.humanOnly || unsupported,
    ...(field.type === 'dropdown' || field.type === 'option_list'
      ? { multiSelect: field.multiSelect }
      : {}),
    ...(field.options.length > 0 ? { options: [...field.options] } : {}),
    ...(field.maxLength === null ? {} : { maxLength: field.maxLength }),
    sourceValue: Array.isArray(field.current)
      ? [...field.current]
      : field.current,
  };
}

export interface FieldProvenance {
  readonly kind: ProvenanceKind;
  readonly confidence: number;
  readonly evidence?: readonly string[];
  readonly rationale?: string;
}

export interface FieldUpdate {
  readonly fieldName: string;
  readonly value: FormFieldValue;
  readonly provenance: FieldProvenance;
}

export interface StagedFieldValue extends FieldUpdate {
  readonly actor: UpdateActor;
}

export interface ValidationIssue {
  readonly code:
    | 'required_missing'
    | 'human_completion_required'
    | 'inference_requires_review'
    | 'low_confidence_requires_review';
  readonly severity: 'error' | 'review';
  readonly fieldName: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly stateVersion: number;
  readonly issues: readonly ValidationIssue[];
  readonly blockerCount: number;
  readonly reviewCount: number;
  readonly reviewFieldNames: readonly string[];
  readonly structurallyValid: boolean;
  readonly completionStatus: 'incomplete' | 'unknown';
  readonly ruleCoverage: 'pdf_required_flags_only';
  readonly formCompletenessAssessed: false;
  readonly canApprove: boolean;
}

export interface ApprovalRecord {
  readonly sourceHash: string;
  readonly planHash: string;
  readonly stateVersion: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly confirmedFieldNames: readonly string[];
}

export interface OutputRecord {
  readonly sourceHash: string;
  readonly planHash: string;
  readonly stateVersion: number;
  readonly outputHash: string;
  readonly createdAt: string;
}

export interface VerificationRecord extends OutputRecord {
  readonly verifiedAt: string;
  readonly fieldValuesMatch: true;
  readonly appearancesPresent: true;
  readonly signatureIntegrityPreserved: true;
}

export interface FormState {
  readonly source: Readonly<SourceMetadata>;
  readonly fields: Readonly<Record<string, Readonly<FormFieldDefinition>>>;
  readonly draft: Readonly<Record<string, Readonly<StagedFieldValue>>>;
  readonly stateVersion: number;
  readonly planHash: string;
  readonly validation: Readonly<ValidationReport>;
  readonly approval: Readonly<ApprovalRecord> | null;
  readonly output: Readonly<OutputRecord> | null;
  readonly verification: Readonly<VerificationRecord> | null;
}

export type StateErrorCode =
  | 'invalid_request'
  | 'stale_state'
  | 'source_mismatch'
  | 'plan_mismatch'
  | 'duplicate_update'
  | 'unknown_field'
  | 'read_only'
  | 'human_only'
  | 'signature_locked'
  | 'invalid_type'
  | 'invalid_option'
  | 'invalid_provenance'
  | 'validation_failed'
  | 'review_unconfirmed'
  | 'approval_missing'
  | 'approval_stale'
  | 'trusted_export_required'
  | 'output_missing'
  | 'output_stale'
  | 'verification_failed'
  | 'verification_missing'
  | 'verification_stale';

export interface StateError {
  readonly code: StateErrorCode;
  readonly message: string;
  readonly fieldName?: string;
}

export interface StageFieldUpdatesRequest {
  readonly expectedStateVersion: number;
  readonly expectedSourceHash: string;
  readonly actor: UpdateActor;
  readonly updates: readonly FieldUpdate[];
}

export type StageResult =
  | {
      readonly ok: true;
      readonly state: FormState;
      readonly changedFields: readonly string[];
    }
  | {
      readonly ok: false;
      readonly state: FormState;
      readonly errors: readonly StateError[];
    };

export interface DiscardDraftRequest {
  readonly expectedStateVersion: number;
  readonly expectedSourceHash: string;
}

export interface ApproveDraftRequest {
  readonly expectedStateVersion: number;
  readonly expectedSourceHash: string;
  readonly expectedPlanHash: string;
  readonly approvedBy: string;
  readonly approvedAt?: string;
  readonly confirmedFieldNames: readonly string[];
}

export interface RecordOutputRequest {
  readonly expectedStateVersion: number;
  readonly expectedSourceHash: string;
  readonly expectedPlanHash: string;
  readonly outputHash: string;
  readonly createdAt?: string;
}

export interface RecordVerificationRequest {
  readonly expectedStateVersion: number;
  readonly expectedSourceHash: string;
  readonly expectedPlanHash: string;
  readonly outputHash: string;
  readonly fieldValuesMatch: boolean;
  readonly appearancesPresent: boolean;
  readonly signatureIntegrityPreserved: boolean;
  readonly verifiedAt?: string;
}

export type WorkflowResult =
  | { readonly ok: true; readonly state: FormState }
  | {
      readonly ok: false;
      readonly state: FormState;
      readonly errors: readonly StateError[];
    };

export type ExportApprovedPdfResult =
  | {
      readonly ok: true;
      readonly state: FormState;
      readonly result: ApplyResult;
    }
  | {
      readonly ok: false;
      readonly state: FormState;
      readonly errors: readonly StateError[];
    };

export interface GateResult {
  readonly open: boolean;
  readonly errors: readonly StateError[];
}

export interface FormContextField {
  readonly definition: Readonly<FormFieldDefinition>;
  readonly effectiveValue: FormFieldValue;
  readonly staged: Readonly<StagedFieldValue> | null;
}

export interface FormContext {
  readonly source: Readonly<SourceMetadata>;
  readonly stateVersion: number;
  readonly planHash: string;
  readonly fields: readonly FormContextField[];
  readonly validation: Readonly<ValidationReport>;
  readonly exportGate: Readonly<GateResult>;
  readonly releaseGate: Readonly<GateResult>;
}

const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

const FIELD_TYPES = new Set<FormFieldType>([
  'text',
  'checkbox',
  'radio',
  'dropdown',
  'option-list',
  'signature',
]);

const PROVENANCE_KINDS = new Set<ProvenanceKind>([
  'user_instruction',
  'source_document',
  'agent_inference',
  'human_entry',
]);

const trustedApprovedStates = new WeakSet<FormState>();
const trustedReleasedStates = new WeakSet<FormState>();

function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function ownValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function requiredOwnValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T {
  const value = ownValue(record, key);
  if (value === undefined) {
    throw new TypeError(`Missing own record entry: ${key}.`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }

  return value;
}

function cloneValue(value: FormFieldValue): FormFieldValue {
  return Array.isArray(value) ? [...value] : value;
}

function cloneProvenance(provenance: FieldProvenance): FieldProvenance {
  return {
    kind: provenance.kind,
    confidence: provenance.confidence,
    ...(provenance.evidence === undefined
      ? {}
      : { evidence: [...provenance.evidence] }),
    ...(provenance.rationale === undefined
      ? {}
      : { rationale: provenance.rationale }),
  };
}

function cloneDefinition(field: FormFieldDefinition): FormFieldDefinition {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    readOnly: field.readOnly,
    humanOnly: field.humanOnly,
    ...(field.options === undefined ? {} : { options: [...field.options] }),
    ...(field.multiSelect === undefined
      ? {}
      : { multiSelect: field.multiSelect }),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    sourceValue: cloneValue(field.sourceValue),
  };
}

function cloneSource(source: SourceMetadata): SourceMetadata {
  return {
    fileName: source.fileName,
    sourceHash: source.sourceHash,
    byteLength: source.byteLength,
    pageCount: source.pageCount,
    ...(source.loadedAt === undefined ? {} : { loadedAt: source.loadedAt }),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot hash a non-finite number.');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }

  throw new TypeError(`Cannot hash value of type ${typeof value}.`);
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  return `sha256:${await sha256Bytes(bytes)}`;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function calculatePlanHash(
  sourceHash: string,
  fields: Readonly<Record<string, Readonly<FormFieldDefinition>>>,
  draft: Readonly<Record<string, Readonly<StagedFieldValue>>>,
): Promise<string> {
  return sha256({
    sourceHash,
    fields: Object.keys(fields)
      .sort()
      .map((fieldName) => {
        const field = requiredOwnValue(fields, fieldName);
        const staged = ownValue(draft, fieldName);
        return {
          name: field.name,
          type: field.type,
          required: field.required,
          readOnly: field.readOnly,
          humanOnly: field.humanOnly,
          options: field.options ?? null,
          multiSelect: field.multiSelect ?? null,
          maxLength: field.maxLength ?? null,
          effectiveValue:
            staged === undefined ? field.sourceValue : staged.value,
          provenance: staged?.provenance ?? null,
          actor: staged?.actor ?? null,
        };
      }),
  });
}

function missingValue(value: FormFieldValue): boolean {
  return (
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    value === false
  );
}

function allowsMultiple(field: FormFieldDefinition): boolean {
  return (
    (field.type === 'dropdown' || field.type === 'option-list') &&
    (field.multiSelect ?? field.type === 'option-list')
  );
}

function normalizeDraftValue(
  field: FormFieldDefinition,
  value: FormFieldValue,
): FormFieldValue {
  if (field.type === 'text' && value === null) return '';
  if (allowsMultiple(field) && value === null) return [];
  return cloneValue(value);
}

function validateValue(
  field: FormFieldDefinition,
  value: FormFieldValue,
): StateError | null {
  if (field.type === 'checkbox') {
    return typeof value === 'boolean'
      ? null
      : {
          code: 'invalid_type',
          fieldName: field.name,
          message: `${field.name} requires a boolean.`,
        };
  }

  if (
    field.type === 'radio' ||
    field.type === 'dropdown' ||
    field.type === 'option-list'
  ) {
    const acceptsMany = allowsMultiple(field);
    if (value === null) return null;

    if (!acceptsMany) {
      if (typeof value !== 'string') {
        return {
          code: 'invalid_type',
          fieldName: field.name,
          message: `${field.name} requires a string or null.`,
        };
      }
      return (field.options ?? []).includes(value)
        ? null
        : {
            code: 'invalid_option',
            fieldName: field.name,
            message: `${JSON.stringify(value)} is not an allowed option for ${field.name}.`,
          };
    }

    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string')
    ) {
      return {
        code: 'invalid_type',
        fieldName: field.name,
        message: `${field.name} requires an array of option strings or null.`,
      };
    }

    if (new Set(value).size !== value.length) {
      return {
        code: 'invalid_option',
        fieldName: field.name,
        message: `${field.name} contains duplicate options.`,
      };
    }

    const options = new Set(field.options ?? []);
    const invalid = value.find((item) => !options.has(item));
    return invalid === undefined
      ? null
      : {
          code: 'invalid_option',
          fieldName: field.name,
          message: `${JSON.stringify(invalid)} is not an allowed option for ${field.name}.`,
        };
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return {
      code: 'invalid_type',
      fieldName: field.name,
      message: `${field.name} requires a string or null.`,
    };
  }

  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return {
      code: 'invalid_type',
      fieldName: field.name,
      message: `${field.name} exceeds its ${field.maxLength}-character limit.`,
    };
  }

  return null;
}

function validateProvenance(
  provenance: FieldProvenance,
  actor: UpdateActor,
  fieldName: string,
): StateError | null {
  if (
    !PROVENANCE_KINDS.has(provenance.kind) ||
    !Number.isFinite(provenance.confidence) ||
    provenance.confidence < 0 ||
    provenance.confidence > 1 ||
    (provenance.evidence !== undefined &&
      (!Array.isArray(provenance.evidence) ||
        provenance.evidence.some((item) => !isNonEmptyString(item)))) ||
    (provenance.rationale !== undefined &&
      !isNonEmptyString(provenance.rationale))
  ) {
    return {
      code: 'invalid_provenance',
      fieldName,
      message: `${fieldName} has malformed provenance.`,
    };
  }

  if (actor === 'agent' && provenance.kind === 'human_entry') {
    return {
      code: 'invalid_provenance',
      fieldName,
      message: `An agent cannot claim human provenance for ${fieldName}.`,
    };
  }

  if (actor === 'human' && provenance.kind !== 'human_entry') {
    return {
      code: 'invalid_provenance',
      fieldName,
      message: `A human edit to ${fieldName} must use human_entry provenance.`,
    };
  }

  if (
    provenance.kind === 'source_document' &&
    (provenance.evidence === undefined || provenance.evidence.length === 0)
  ) {
    return {
      code: 'invalid_provenance',
      fieldName,
      message: `Source-document provenance for ${fieldName} requires evidence.`,
    };
  }

  if (
    provenance.kind === 'agent_inference' &&
    !isNonEmptyString(provenance.rationale)
  ) {
    return {
      code: 'invalid_provenance',
      fieldName,
      message: `Agent inference for ${fieldName} requires a rationale.`,
    };
  }

  return null;
}

function buildValidationReport(
  stateVersion: number,
  fields: Readonly<Record<string, Readonly<FormFieldDefinition>>>,
  draft: Readonly<Record<string, Readonly<StagedFieldValue>>>,
): ValidationReport {
  const issues: ValidationIssue[] = [];

  for (const fieldName of Object.keys(fields).sort()) {
    const field = requiredOwnValue(fields, fieldName);
    const staged = ownValue(draft, fieldName);
    const value = staged === undefined ? field.sourceValue : staged.value;

    if (field.required && missingValue(value)) {
      const requiresHumanCompletion =
        field.humanOnly || field.type === 'signature';
      issues.push(
        requiresHumanCompletion
          ? {
              code: 'human_completion_required',
              severity: 'review',
              fieldName,
              message: `${field.label} must be completed by a human after export.`,
            }
          : {
              code: 'required_missing',
              severity: 'error',
              fieldName,
              message: `${field.label} is required.`,
            },
      );
    }

    if (staged?.provenance.kind === 'agent_inference') {
      issues.push({
        code: 'inference_requires_review',
        severity: 'review',
        fieldName,
        message: `${field.label} contains an agent inference.`,
      });
    }

    if (
      staged !== undefined &&
      staged.provenance.kind !== 'human_entry' &&
      staged.provenance.confidence < REVIEW_CONFIDENCE_THRESHOLD
    ) {
      issues.push({
        code: 'low_confidence_requires_review',
        severity: 'review',
        fieldName,
        message: `${field.label} has confidence below ${REVIEW_CONFIDENCE_THRESHOLD}.`,
      });
    }
  }

  const blockerCount = issues.filter(
    (issue) => issue.severity === 'error',
  ).length;
  const reviewCount = issues.filter(
    (issue) => issue.severity === 'review',
  ).length;
  const reviewFieldNames = [
    ...new Set(
      issues
        .filter((issue) => issue.severity === 'review')
        .map((issue) => issue.fieldName),
    ),
  ].sort();
  const hasRequiredMissing = issues.some(
    ({ code }) =>
      code === 'required_missing' || code === 'human_completion_required',
  );

  return deepFreeze({
    stateVersion,
    issues,
    blockerCount,
    reviewCount,
    reviewFieldNames,
    structurallyValid: blockerCount === 0,
    completionStatus: hasRequiredMissing ? 'incomplete' : 'unknown',
    ruleCoverage: 'pdf_required_flags_only',
    formCompletenessAssessed: false,
    canApprove: blockerCount === 0,
  });
}

function configurationErrors(
  source: SourceMetadata,
  fields: readonly FormFieldDefinition[],
): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(source.fileName))
    errors.push('source.fileName is required');
  if (!isNonEmptyString(source.sourceHash))
    errors.push('source.sourceHash is required');
  if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
    errors.push('source.byteLength must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(source.pageCount) || source.pageCount < 1) {
    errors.push('source.pageCount must be a positive safe integer');
  }

  const names = new Set<string>();
  for (const field of fields) {
    if (!isNonEmptyString(field.name)) errors.push('field.name is required');
    if (names.has(field.name))
      errors.push(`duplicate field name: ${field.name}`);
    names.add(field.name);
    if (!isNonEmptyString(field.label))
      errors.push(`${field.name}: label is required`);
    if (!FIELD_TYPES.has(field.type))
      errors.push(`${field.name}: unsupported field type`);
    if (
      field.maxLength !== undefined &&
      (!Number.isSafeInteger(field.maxLength) || field.maxLength < 0)
    ) {
      errors.push(
        `${field.name}: maxLength must be a non-negative safe integer`,
      );
    }
    if (
      field.multiSelect !== undefined &&
      typeof field.multiSelect !== 'boolean'
    ) {
      errors.push(`${field.name}: multiSelect must be a boolean`);
    }
    if (
      field.multiSelect !== undefined &&
      field.type !== 'dropdown' &&
      field.type !== 'option-list'
    ) {
      errors.push(
        `${field.name}: multiSelect is only allowed for dropdown and option-list fields`,
      );
    }
    if (
      field.type === 'radio' ||
      field.type === 'dropdown' ||
      field.type === 'option-list'
    ) {
      if (
        field.options === undefined ||
        field.options.length === 0 ||
        field.options.some((option) => !isNonEmptyString(option)) ||
        new Set(field.options).size !== field.options.length
      ) {
        errors.push(`${field.name}: options must be unique, non-empty strings`);
      }
    } else if (field.options !== undefined) {
      errors.push(`${field.name}: options are not allowed for ${field.type}`);
    }
    if (field.type === 'signature' && !field.humanOnly) {
      errors.push(`${field.name}: signature fields must be humanOnly`);
    }

    const valueError = validateValue(field, field.sourceValue);
    if (valueError !== null) errors.push(valueError.message);
  }

  return errors;
}

function freezeState(state: FormState): FormState {
  return deepFreeze(state);
}

function stateErrors(...errors: StateError[]): readonly StateError[] {
  return deepFreeze(errors);
}

function workflowFailure(
  state: FormState,
  ...errors: StateError[]
): WorkflowResult {
  return deepFreeze({ ok: false, state, errors: stateErrors(...errors) });
}

function preconditionErrors(
  state: FormState,
  expectedStateVersion: number,
  expectedSourceHash: string,
  expectedPlanHash?: string,
): StateError[] {
  const errors: StateError[] = [];
  if (expectedStateVersion !== state.stateVersion) {
    errors.push({
      code: 'stale_state',
      message: `Expected state version ${expectedStateVersion}, but current version is ${state.stateVersion}.`,
    });
  }
  if (expectedSourceHash !== state.source.sourceHash) {
    errors.push({
      code: 'source_mismatch',
      message: 'The request targets a different source document.',
    });
  }
  if (expectedPlanHash !== undefined && expectedPlanHash !== state.planHash) {
    errors.push({
      code: 'plan_mismatch',
      message: 'The request targets a different draft plan.',
    });
  }
  return errors;
}

function sameBinding(
  binding: Pick<ApprovalRecord, 'sourceHash' | 'planHash' | 'stateVersion'>,
  state: FormState,
): boolean {
  return (
    binding.sourceHash === state.source.sourceHash &&
    binding.planHash === state.planHash &&
    binding.stateVersion === state.stateVersion
  );
}

export async function createFormState(
  sourceInput: SourceMetadata,
  fieldInputs: readonly FormFieldDefinition[],
): Promise<FormState> {
  const errors = configurationErrors(sourceInput, fieldInputs);
  if (errors.length > 0) {
    throw new TypeError(`Invalid form configuration: ${errors.join('; ')}`);
  }

  const source = deepFreeze(cloneSource(sourceInput));
  const fields = createRecord<Readonly<FormFieldDefinition>>();
  for (const input of fieldInputs) {
    fields[input.name] = deepFreeze(cloneDefinition(input));
  }
  deepFreeze(fields);

  const draft = deepFreeze(createRecord<Readonly<StagedFieldValue>>());
  const stateVersion = 0;
  const planHash = await calculatePlanHash(source.sourceHash, fields, draft);
  const validation = buildValidationReport(stateVersion, fields, draft);

  return freezeState({
    source,
    fields,
    draft,
    stateVersion,
    planHash,
    validation,
    approval: null,
    output: null,
    verification: null,
  });
}

export function getEffectiveFieldValue(
  state: FormState,
  fieldName: string,
): FormFieldValue | undefined {
  const field = ownValue(state.fields, fieldName);
  if (field === undefined) return undefined;
  const staged = ownValue(state.draft, fieldName);
  return cloneValue(staged === undefined ? field.sourceValue : staged.value);
}

export function validateDraft(state: FormState): ValidationReport {
  return buildValidationReport(state.stateVersion, state.fields, state.draft);
}

export async function stageFieldUpdates(
  state: FormState,
  request: StageFieldUpdatesRequest,
): Promise<StageResult> {
  const preconditions = preconditionErrors(
    state,
    request.expectedStateVersion,
    request.expectedSourceHash,
  );
  if (preconditions.length > 0) {
    return deepFreeze({
      ok: false,
      state,
      errors: stateErrors(...preconditions),
    });
  }

  if (request.actor !== 'agent' && request.actor !== 'human') {
    return deepFreeze({
      ok: false,
      state,
      errors: stateErrors({
        code: 'invalid_request',
        message: 'actor must be agent or human.',
      }),
    });
  }

  if (request.updates.length === 0) {
    return deepFreeze({
      ok: false,
      state,
      errors: stateErrors({
        code: 'invalid_request',
        message: 'At least one field update is required.',
      }),
    });
  }

  const errors: StateError[] = [];
  const seen = new Set<string>();

  for (const update of request.updates) {
    if (seen.has(update.fieldName)) {
      errors.push({
        code: 'duplicate_update',
        fieldName: update.fieldName,
        message: `${update.fieldName} appears more than once in the same atomic update.`,
      });
      continue;
    }
    seen.add(update.fieldName);

    const field = ownValue(state.fields, update.fieldName);
    if (field === undefined) {
      errors.push({
        code: 'unknown_field',
        fieldName: update.fieldName,
        message: `Unknown field: ${update.fieldName}.`,
      });
      continue;
    }
    if (field.readOnly) {
      errors.push({
        code: 'read_only',
        fieldName: update.fieldName,
        message: `${update.fieldName} is read-only.`,
      });
    }
    if (field.type === 'signature') {
      errors.push({
        code: 'signature_locked',
        fieldName: update.fieldName,
        message: `${update.fieldName} is a signature field and cannot be staged.`,
      });
    }
    if (field.humanOnly && request.actor !== 'human') {
      errors.push({
        code: 'human_only',
        fieldName: update.fieldName,
        message: `${update.fieldName} may only be changed through the human UI.`,
      });
    }

    const valueError = validateValue(field, update.value);
    if (valueError !== null) errors.push(valueError);
    const provenanceError = validateProvenance(
      update.provenance,
      request.actor,
      update.fieldName,
    );
    if (provenanceError !== null) errors.push(provenanceError);
  }

  if (errors.length > 0) {
    return deepFreeze({ ok: false, state, errors: stateErrors(...errors) });
  }

  const nextDraft = createRecord<Readonly<StagedFieldValue>>();
  for (const fieldName of Object.keys(state.draft)) {
    nextDraft[fieldName] = requiredOwnValue(state.draft, fieldName);
  }
  const changedFields: string[] = [];
  for (const update of request.updates) {
    const next = deepFreeze({
      fieldName: update.fieldName,
      value: normalizeDraftValue(
        requiredOwnValue(state.fields, update.fieldName),
        update.value,
      ),
      provenance: cloneProvenance(update.provenance),
      actor: request.actor,
    });
    const current = ownValue(state.draft, update.fieldName);
    if (current === undefined || canonicalize(current) !== canonicalize(next)) {
      nextDraft[update.fieldName] = next;
      changedFields.push(update.fieldName);
    }
  }

  if (changedFields.length === 0) {
    return deepFreeze({ ok: true, state, changedFields: deepFreeze([]) });
  }

  deepFreeze(nextDraft);
  const stateVersion = state.stateVersion + 1;
  const planHash = await calculatePlanHash(
    state.source.sourceHash,
    state.fields,
    nextDraft,
  );
  const validation = buildValidationReport(
    stateVersion,
    state.fields,
    nextDraft,
  );
  const nextState = freezeState({
    source: state.source,
    fields: state.fields,
    draft: nextDraft,
    stateVersion,
    planHash,
    validation,
    approval: null,
    output: null,
    verification: null,
  });

  return deepFreeze({
    ok: true,
    state: nextState,
    changedFields: deepFreeze(changedFields.sort()),
  });
}

export async function discardDraft(
  state: FormState,
  request: DiscardDraftRequest,
): Promise<WorkflowResult> {
  const errors = preconditionErrors(
    state,
    request.expectedStateVersion,
    request.expectedSourceHash,
  );
  if (errors.length > 0) return workflowFailure(state, ...errors);
  if (Object.keys(state.draft).length === 0) {
    return deepFreeze({ ok: true, state });
  }

  const draft = deepFreeze(createRecord<Readonly<StagedFieldValue>>());
  const stateVersion = state.stateVersion + 1;
  const planHash = await calculatePlanHash(
    state.source.sourceHash,
    state.fields,
    draft,
  );
  return deepFreeze({
    ok: true,
    state: freezeState({
      source: state.source,
      fields: state.fields,
      draft,
      stateVersion,
      planHash,
      validation: buildValidationReport(stateVersion, state.fields, draft),
      approval: null,
      output: null,
      verification: null,
    }),
  });
}

export function getExportGate(state: FormState): GateResult {
  const errors: StateError[] = [];
  const validation = validateDraft(state);
  if (!validation.canApprove) {
    errors.push({
      code: 'validation_failed',
      message: 'The draft still has deterministic validation blockers.',
    });
  }
  if (state.approval === null) {
    errors.push({
      code: 'approval_missing',
      message: 'A human must approve this exact draft before export.',
    });
  } else if (
    !sameBinding(state.approval, state) ||
    !trustedApprovedStates.has(state)
  ) {
    errors.push({
      code: 'approval_stale',
      message:
        'The human approval does not match the current document and draft.',
    });
  }
  return deepFreeze({ open: errors.length === 0, errors });
}

export function getVerificationGate(state: FormState): GateResult {
  const exportGate = getExportGate(state);
  const errors = [...exportGate.errors];
  if (state.output === null) {
    errors.push({
      code: 'output_missing',
      message: 'No exported artifact is available to verify.',
    });
  } else if (!sameBinding(state.output, state)) {
    errors.push({
      code: 'output_stale',
      message:
        'The exported artifact does not match the current document and draft.',
    });
  }
  return deepFreeze({ open: errors.length === 0, errors });
}

export function getReleaseGate(state: FormState): GateResult {
  const verificationGate = getVerificationGate(state);
  const errors = [...verificationGate.errors];
  if (state.verification === null) {
    errors.push({
      code: 'verification_missing',
      message: 'The exported artifact has not passed post-export verification.',
    });
  } else if (
    !sameBinding(state.verification, state) ||
    state.output === null ||
    state.verification.outputHash !== state.output.outputHash ||
    !trustedReleasedStates.has(state)
  ) {
    errors.push({
      code: 'verification_stale',
      message: 'The verification does not match the current exported artifact.',
    });
  }
  return deepFreeze({ open: errors.length === 0, errors });
}

export function approveDraftFromUi(
  state: FormState,
  request: ApproveDraftRequest,
): WorkflowResult {
  const errors = preconditionErrors(
    state,
    request.expectedStateVersion,
    request.expectedSourceHash,
    request.expectedPlanHash,
  );
  if (!isNonEmptyString(request.approvedBy)) {
    errors.push({
      code: 'invalid_request',
      message: 'approvedBy is required.',
    });
  }

  const validation = validateDraft(state);
  if (!validation.canApprove) {
    errors.push({
      code: 'validation_failed',
      message: 'Resolve required-field blockers before approval.',
    });
  }

  const confirmations = new Set(request.confirmedFieldNames);
  const unknownConfirmations = [...confirmations].filter(
    (fieldName) => ownValue(state.fields, fieldName) === undefined,
  );
  if (
    confirmations.size !== request.confirmedFieldNames.length ||
    unknownConfirmations.length > 0
  ) {
    errors.push({
      code: 'invalid_request',
      message: 'confirmedFieldNames must be unique names from this form.',
    });
  }
  const requiredConfirmations = [
    ...new Set([...Object.keys(state.draft), ...validation.reviewFieldNames]),
  ].sort();
  const missingReviews = requiredConfirmations.filter(
    (fieldName) => !confirmations.has(fieldName),
  );
  if (missingReviews.length > 0) {
    errors.push({
      code: 'review_unconfirmed',
      message: `Explicitly confirm draft and review fields: ${missingReviews.join(', ')}.`,
    });
  }
  if (errors.length > 0) return workflowFailure(state, ...errors);

  const approval = deepFreeze({
    sourceHash: state.source.sourceHash,
    planHash: state.planHash,
    stateVersion: state.stateVersion,
    approvedBy: request.approvedBy.trim(),
    approvedAt: request.approvedAt ?? new Date().toISOString(),
    confirmedFieldNames: [...confirmations].sort(),
  });
  const approvedState = freezeState({
    ...state,
    validation,
    approval,
    output: null,
    verification: null,
  });
  trustedApprovedStates.add(approvedState);
  return deepFreeze({ ok: true, state: approvedState });
}

export function recordExportOutput(
  state: FormState,
  request: RecordOutputRequest,
): WorkflowResult {
  void request;
  return workflowFailure(state, {
    code: 'trusted_export_required',
    message: 'Output records can only be created by exportApprovedPdfFromUi.',
  });
}

export function recordOutputVerification(
  state: FormState,
  request: RecordVerificationRequest,
): WorkflowResult {
  void request;
  return workflowFailure(state, {
    code: 'trusted_export_required',
    message:
      'Verification records can only be created by exportApprovedPdfFromUi.',
  });
}

function approvedDraftValues(state: FormState): Record<string, PdfFieldValue> {
  const values = createRecord<PdfFieldValue>();
  for (const fieldName of Object.keys(state.draft).sort()) {
    const value = requiredOwnValue(state.draft, fieldName).value;
    values[fieldName] = Array.isArray(value)
      ? [...(value as readonly string[])]
      : (value as string | boolean | null);
  }
  return values;
}

function verifiedValueMatches(
  expected: PdfFieldValue,
  actual: PdfFieldValue,
): boolean {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    return (
      canonicalize([...expected].sort()) === canonicalize([...actual].sort())
    );
  }
  return expected === actual;
}

export async function exportApprovedPdfFromUi(
  state: FormState,
  sourceBytes: Uint8Array,
): Promise<ExportApprovedPdfResult> {
  const gate = getExportGate(state);
  if (!gate.open) {
    return deepFreeze({ ok: false, state, errors: gate.errors });
  }

  const source = Uint8Array.from(sourceBytes);
  const sourceHash = await sha256Bytes(source);
  if (sourceHash !== state.source.sourceHash) {
    return deepFreeze({
      ok: false,
      state,
      errors: stateErrors({
        code: 'source_mismatch',
        message:
          'The selected PDF does not match the approved source document.',
      }),
    });
  }

  const values = approvedDraftValues(state);
  const { applyApprovedValues } = await import(
    // @ts-expect-error -- Node's type-stripping test runner requires the explicit extension.
    './pdf-engine.ts'
  );
  const applyResult = await applyApprovedValues(source, values);
  const errors: StateError[] = [];

  if (applyResult.sourceHash !== sourceHash) {
    errors.push({
      code: 'source_mismatch',
      message: 'The PDF engine processed a different source document.',
    });
  }

  const outputHash = await sha256Bytes(applyResult.bytes);
  if (applyResult.outputHash !== outputHash) {
    errors.push({
      code: 'verification_failed',
      message: 'The exported bytes do not match the PDF engine output hash.',
    });
  }

  const expectedNames = Object.keys(values).sort();
  const verifiedByName = new Map(
    applyResult.verifiedFields.map((field) => [field.name, field] as const),
  );
  if (
    verifiedByName.size !== applyResult.verifiedFields.length ||
    verifiedByName.size !== expectedNames.length
  ) {
    errors.push({
      code: 'verification_failed',
      message:
        'The PDF engine did not verify exactly the approved draft fields.',
    });
  }

  for (const fieldName of expectedNames) {
    const verified = verifiedByName.get(fieldName);
    const expected = requiredOwnValue(values, fieldName);
    if (verified === undefined) {
      errors.push({
        code: 'verification_failed',
        fieldName,
        message: `${fieldName} was not verified after export.`,
      });
    } else if (!verifiedValueMatches(expected, verified.value)) {
      errors.push({
        code: 'verification_failed',
        fieldName,
        message: `${fieldName} does not contain its approved value after export.`,
      });
    } else if (!verified.appearanceVerified) {
      errors.push({
        code: 'verification_failed',
        fieldName,
        message: `${fieldName} has no verified appearance after export.`,
      });
    }
  }

  if (errors.length > 0) {
    return deepFreeze({ ok: false, state, errors: stateErrors(...errors) });
  }

  const recordedAt = new Date().toISOString();
  const output = deepFreeze({
    sourceHash,
    planHash: state.planHash,
    stateVersion: state.stateVersion,
    outputHash,
    createdAt: recordedAt,
  });
  const verification = deepFreeze({
    ...output,
    verifiedAt: recordedAt,
    fieldValuesMatch: true as const,
    appearancesPresent: true as const,
    signatureIntegrityPreserved: true as const,
  });
  const releasedState = freezeState({ ...state, output, verification });
  trustedApprovedStates.add(releasedState);
  trustedReleasedStates.add(releasedState);
  return {
    ok: true,
    state: releasedState,
    result: applyResult,
  };
}

export function getFormContext(state: FormState): FormContext {
  const fields = Object.keys(state.fields)
    .sort()
    .map((fieldName) => ({
      definition: requiredOwnValue(state.fields, fieldName),
      effectiveValue: getEffectiveFieldValue(state, fieldName) ?? null,
      staged: ownValue(state.draft, fieldName) ?? null,
    }));
  return deepFreeze({
    source: state.source,
    stateVersion: state.stateVersion,
    planHash: state.planHash,
    fields,
    validation: validateDraft(state),
    exportGate: getExportGate(state),
    releaseGate: getReleaseGate(state),
  });
}
