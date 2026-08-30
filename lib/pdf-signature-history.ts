import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

export type PdfSignatureRole =
  | 'document'
  | 'docmdp'
  | 'fieldmdp'
  | 'ur'
  | 'ur3';

export type PdfSignatureRawObjectForm =
  | { readonly kind: 'missing' }
  | { readonly kind: 'direct'; readonly objectType: string }
  | { readonly kind: 'indirect'; readonly reference: string };

export interface PdfSignedFieldAttachment {
  readonly fieldIdentity: string;
  readonly fieldRef: string | null;
  readonly fieldName: string | null;
  readonly rawValue: PdfSignatureRawObjectForm;
}

export interface PdfCatalogPermsAttachment {
  readonly permsContainer: PdfSignatureRawObjectForm;
  readonly key: string;
  readonly rawValue: PdfSignatureRawObjectForm;
}

export interface PdfSignatureFingerprint {
  readonly identity: string;
  readonly fingerprint: string | null;
  readonly inconclusive: boolean;
  readonly issues: readonly string[];
  readonly byteRangeRaw: PdfSignatureRawObjectForm;
  readonly byteRangeElementRaw: readonly PdfSignatureRawObjectForm[];
  readonly resolvedByteRange: readonly [number, number, number, number] | null;
  readonly contentsRaw: PdfSignatureRawObjectForm;
  readonly contentsSha256: string | null;
  readonly contentsLength: number | null;
  readonly type: string | null;
  readonly filter: string | null;
  readonly subFilter: string | null;
  readonly typeCanonical: string | null;
  readonly filterCanonical: string | null;
  readonly subFilterCanonical: string | null;
  readonly roles: readonly PdfSignatureRole[];
  readonly transformMethods: readonly string[];
  readonly signedFieldAttachments: readonly PdfSignedFieldAttachment[];
  readonly catalogPermsAttachments: readonly PdfCatalogPermsAttachment[];
  readonly referenceCanonical: string | null;
}

export interface PdfSignatureFingerprintSnapshot {
  readonly complete: boolean;
  readonly inconclusive: boolean;
  readonly issues: readonly string[];
  readonly signatures: readonly PdfSignatureFingerprint[];
  readonly fingerprintsByIdentity: Readonly<
    Record<string, PdfSignatureFingerprint>
  >;
}

export interface PdfSignatureFingerprintLimits {
  readonly maxSignatures?: number;
  readonly maxPhysicalNodes?: number;
  readonly maxFieldNodes?: number;
  readonly maxDepth?: number;
  readonly maxCanonicalNodes?: number;
  readonly maxCanonicalBytes?: number;
  readonly maxContentsBytes?: number;
  readonly maxArrayEntries?: number;
  readonly maxDictionaryEntries?: number;
  readonly maxAttachmentsPerSignature?: number;
  readonly maxIssues?: number;
}

interface NormalizedLimits {
  readonly maxSignatures: number;
  readonly maxPhysicalNodes: number;
  readonly maxFieldNodes: number;
  readonly maxDepth: number;
  readonly maxCanonicalNodes: number;
  readonly maxCanonicalBytes: number;
  readonly maxContentsBytes: number;
  readonly maxArrayEntries: number;
  readonly maxDictionaryEntries: number;
  readonly maxAttachmentsPerSignature: number;
  readonly maxIssues: number;
}

interface CandidateBuilder {
  readonly identity: string;
  readonly dictionary: PDFDict;
  readonly roles: Set<PdfSignatureRole>;
  readonly signedFieldAttachments: PdfSignedFieldAttachment[];
  readonly catalogPermsAttachments: PdfCatalogPermsAttachment[];
  readonly issues: Set<string>;
}

interface DiscoveryState {
  readonly document: PDFDocument;
  readonly limits: NormalizedLimits;
  readonly issues: Set<string>;
  readonly candidates: Map<string, CandidateBuilder>;
  readonly candidateByDictionary: Map<PDFDict, CandidateBuilder>;
  readonly physicalIdentityByDictionary: Map<PDFDict, string>;
  readonly indirectRefByDictionary: Map<PDFDict, PDFRef>;
  physicalNodeCount: number;
  fieldNodeCount: number;
}

interface CanonicalState {
  readonly document: PDFDocument;
  readonly limits: NormalizedLimits;
  readonly issues: Set<string>;
  readonly activeObjects: Set<PDFObject>;
  readonly activeRefs: Set<string>;
  nodeCount: number;
  byteCount: number;
}

interface CanonicalContext {
  readonly transformMethod: string | null;
  readonly dictionaryKind: 'ordinary' | 'transform_params';
  readonly sortArrayAsSet: boolean;
  readonly referenceOnly: boolean;
}

const DEFAULT_LIMITS: NormalizedLimits = {
  maxSignatures: 256,
  maxPhysicalNodes: 65_536,
  maxFieldNodes: 16_384,
  maxDepth: 128,
  maxCanonicalNodes: 16_384,
  maxCanonicalBytes: 2 * 1024 * 1024,
  maxContentsBytes: 4 * 1024 * 1024,
  maxArrayEntries: 16_384,
  maxDictionaryEntries: 4_096,
  maxAttachmentsPerSignature: 4_096,
  maxIssues: 256,
};
const MAX_DICTIONARY_KEY_BYTES = 1_024;
const MAX_FIELD_NAME_BYTES = 4_096;
const MAX_PHYSICAL_IDENTITY_LENGTH = 4_096;

const USAGE_RIGHTS_SET_KEYS = new Set([
  'Annots',
  'Document',
  'EF',
  'Form',
  'Signature',
]);

const EMPTY_CANONICAL_CONTEXT: CanonicalContext = {
  transformMethod: null,
  dictionaryKind: 'ordinary',
  sortArrayAsSet: false,
  referenceOnly: false,
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, fallback)
    : fallback;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeLimits(
  limits: PdfSignatureFingerprintLimits,
): NormalizedLimits {
  return {
    maxSignatures: positiveInteger(
      limits.maxSignatures,
      DEFAULT_LIMITS.maxSignatures,
    ),
    maxPhysicalNodes: positiveInteger(
      limits.maxPhysicalNodes,
      DEFAULT_LIMITS.maxPhysicalNodes,
    ),
    maxFieldNodes: positiveInteger(
      limits.maxFieldNodes,
      DEFAULT_LIMITS.maxFieldNodes,
    ),
    maxDepth: positiveInteger(limits.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxCanonicalNodes: positiveInteger(
      limits.maxCanonicalNodes,
      DEFAULT_LIMITS.maxCanonicalNodes,
    ),
    maxCanonicalBytes: positiveInteger(
      limits.maxCanonicalBytes,
      DEFAULT_LIMITS.maxCanonicalBytes,
    ),
    maxContentsBytes: positiveInteger(
      limits.maxContentsBytes,
      DEFAULT_LIMITS.maxContentsBytes,
    ),
    maxArrayEntries: positiveInteger(
      limits.maxArrayEntries,
      DEFAULT_LIMITS.maxArrayEntries,
    ),
    maxDictionaryEntries: positiveInteger(
      limits.maxDictionaryEntries,
      DEFAULT_LIMITS.maxDictionaryEntries,
    ),
    maxAttachmentsPerSignature: positiveInteger(
      limits.maxAttachmentsPerSignature,
      DEFAULT_LIMITS.maxAttachmentsPerSignature,
    ),
    maxIssues: positiveInteger(limits.maxIssues, DEFAULT_LIMITS.maxIssues),
  };
}

function addIssue(issues: Set<string>, issue: string, maxIssues: number): void {
  if (issues.has(issue)) return;
  if (issues.size < maxIssues) {
    issues.add(issue);
  } else {
    issues.add('issue_limit_exceeded');
  }
}

function referenceIdentity(reference: PDFRef): string {
  return `${reference.objectNumber}:${reference.generationNumber}`;
}

function objectType(object: PDFObject): string {
  if (object === PDFNull) return 'null';
  if (object instanceof PDFArray) return 'array';
  if (object instanceof PDFBool) return 'boolean';
  if (object instanceof PDFDict) return 'dictionary';
  if (object instanceof PDFHexString) return 'hex_string';
  if (object instanceof PDFName) return 'name';
  if (object instanceof PDFNumber) return 'number';
  if (object instanceof PDFRef) return 'reference';
  if (object instanceof PDFStream) return 'stream';
  if (object instanceof PDFString) return 'string';
  return 'unknown';
}

function rawObjectForm(
  object: PDFObject | undefined,
): PdfSignatureRawObjectForm {
  if (object === undefined) return { kind: 'missing' };
  if (object instanceof PDFRef) {
    return { kind: 'indirect', reference: referenceIdentity(object) };
  }
  return { kind: 'direct', objectType: objectType(object) };
}

function lookupReference(
  document: PDFDocument,
  reference: PDFRef,
  issues: Set<string>,
  maxIssues: number,
  issueCode: string,
): PDFObject | undefined {
  let resolved: PDFObject | undefined;
  try {
    resolved = document.context.lookup(reference);
  } catch {
    addIssue(issues, issueCode, maxIssues);
    return undefined;
  }
  if (resolved === undefined) addIssue(issues, issueCode, maxIssues);
  return resolved;
}

function resolveObject(
  document: PDFDocument,
  object: PDFObject | undefined,
  issues: Set<string>,
  maxIssues: number,
  issueCode: string,
): PDFObject | undefined {
  return object instanceof PDFRef
    ? lookupReference(document, object, issues, maxIssues, issueCode)
    : object;
}

function resolvedNameWithoutIssue(
  document: PDFDocument,
  object: PDFObject | undefined,
): string | null {
  try {
    const resolved =
      object instanceof PDFRef ? document.context.lookup(object) : object;
    return resolved instanceof PDFName ? resolved.decodeText() : null;
  } catch {
    return null;
  }
}

function isSignatureLike(document: PDFDocument, dictionary: PDFDict): boolean {
  return (
    dictionary.has(PDFName.of('ByteRange')) ||
    resolvedNameWithoutIssue(document, dictionary.get(PDFName.of('Type'))) ===
      'Sig'
  );
}

function encodedPathPart(value: string): string | null {
  try {
    const encoded = encodeURIComponent(value);
    return encoded.length <= MAX_DICTIONARY_KEY_BYTES ? encoded : null;
  } catch {
    return null;
  }
}

function dictionaryEntries(
  dictionary: PDFDict,
  issues: Set<string>,
  maxIssues: number,
  maxEntries: number,
  entryLimitIssue: string,
):
  | readonly {
      readonly key: PDFName;
      readonly name: string;
      readonly rawName: string;
      readonly value: PDFObject;
    }[]
  | null {
  const dictionaryMap = dictionary.asMap();
  if (dictionaryMap.size > maxEntries) {
    addIssue(issues, entryLimitIssue, maxIssues);
    return null;
  }
  const entries: {
    readonly key: PDFName;
    readonly name: string;
    readonly rawName: string;
    readonly value: PDFObject;
  }[] = [];
  for (const [key, value] of dictionaryMap) {
    if (
      key.sizeInBytes() > MAX_DICTIONARY_KEY_BYTES + 1 ||
      key.asBytes().byteLength > MAX_DICTIONARY_KEY_BYTES
    ) {
      addIssue(issues, 'dictionary_key_byte_limit_exceeded', maxIssues);
      return null;
    }
    let name: string;
    try {
      name = key.decodeText();
    } catch {
      name = key.toString();
      addIssue(issues, 'dictionary_key_decode_failed', maxIssues);
    }
    entries.push({ key, name, rawName: key.toString(), value });
  }
  entries.sort(
    (left, right) =>
      compareStrings(left.name, right.name) ||
      compareStrings(left.rawName, right.rawName),
  );
  return entries;
}

function ensureCandidate(
  state: DiscoveryState,
  dictionary: PDFDict,
  identityHint: string,
): CandidateBuilder | null {
  const existing = state.candidateByDictionary.get(dictionary);
  if (existing !== undefined) {
    if (existing.identity !== identityHint) {
      addIssue(
        existing.issues,
        'direct_signature_dictionary_has_multiple_physical_paths',
        state.limits.maxIssues,
      );
    }
    return existing;
  }
  if (state.candidates.size >= state.limits.maxSignatures) {
    addIssue(state.issues, 'signature_limit_exceeded', state.limits.maxIssues);
    return null;
  }

  const indirectRef = state.indirectRefByDictionary.get(dictionary);
  const identity =
    indirectRef === undefined
      ? identityHint
      : `ref:${referenceIdentity(indirectRef)}`;
  const collision = state.candidates.get(identity);
  if (collision !== undefined && collision.dictionary !== dictionary) {
    addIssue(
      state.issues,
      'signature_physical_identity_collision',
      state.limits.maxIssues,
    );
    return null;
  }

  const candidate: CandidateBuilder = {
    identity,
    dictionary,
    roles: new Set(),
    signedFieldAttachments: [],
    catalogPermsAttachments: [],
    issues: new Set(),
  };
  state.candidates.set(identity, candidate);
  state.candidateByDictionary.set(dictionary, candidate);
  return candidate;
}

function discoverPhysicalDictionaries(state: DiscoveryState): void {
  const roots: { readonly reference: PDFRef; readonly object: PDFObject }[] =
    [];
  for (const [
    reference,
    object,
  ] of state.document.context.enumerateIndirectObjects()) {
    if (roots.length >= state.limits.maxPhysicalNodes) {
      addIssue(
        state.issues,
        'indirect_object_limit_exceeded',
        state.limits.maxIssues,
      );
      break;
    }
    roots.push({ reference, object });
    if (object instanceof PDFDict) {
      state.indirectRefByDictionary.set(object, reference);
    }
  }

  for (const { reference, object } of roots) {
    if (state.physicalNodeCount >= state.limits.maxPhysicalNodes) break;
    const rootIdentity = `ref:${referenceIdentity(reference)}`;
    const active = new Set<PDFObject>();
    const seen = new Set<PDFObject>();

    const visit = (
      current: PDFObject,
      path: readonly string[],
      depth: number,
    ): void => {
      if (state.physicalNodeCount >= state.limits.maxPhysicalNodes) {
        addIssue(
          state.issues,
          'physical_node_limit_exceeded',
          state.limits.maxIssues,
        );
        return;
      }
      if (depth > state.limits.maxDepth) {
        addIssue(
          state.issues,
          'physical_depth_limit_exceeded',
          state.limits.maxIssues,
        );
        return;
      }
      if (current instanceof PDFRef) return;
      if (
        !(current instanceof PDFArray) &&
        !(current instanceof PDFDict) &&
        !(current instanceof PDFStream)
      ) {
        return;
      }
      state.physicalNodeCount += 1;
      if (active.has(current)) {
        addIssue(state.issues, 'physical_object_cycle', state.limits.maxIssues);
        return;
      }
      if (seen.has(current)) return;
      seen.add(current);
      active.add(current);

      if (current instanceof PDFStream) {
        visit(current.dict, [...path, '$stream'], depth + 1);
      } else if (current instanceof PDFArray) {
        if (current.size() > state.limits.maxArrayEntries) {
          addIssue(
            state.issues,
            'physical_array_entry_limit_exceeded',
            state.limits.maxIssues,
          );
        } else {
          for (let index = 0; index < current.size(); index += 1) {
            visit(current.get(index), [...path, `[${index}]`], depth + 1);
          }
        }
      } else {
        const directIdentity =
          path.length === 0
            ? rootIdentity
            : `direct:${referenceIdentity(reference)}:${path.join('/')}`;
        if (directIdentity.length > MAX_PHYSICAL_IDENTITY_LENGTH) {
          addIssue(
            state.issues,
            'physical_identity_length_exceeded',
            state.limits.maxIssues,
          );
          active.delete(current);
          return;
        }
        const priorIdentity = state.physicalIdentityByDictionary.get(current);
        if (priorIdentity === undefined) {
          state.physicalIdentityByDictionary.set(current, directIdentity);
        } else if (
          priorIdentity !== directIdentity &&
          isSignatureLike(state.document, current)
        ) {
          const candidate = state.candidateByDictionary.get(current);
          if (candidate !== undefined) {
            addIssue(
              candidate.issues,
              'direct_signature_dictionary_has_multiple_physical_paths',
              state.limits.maxIssues,
            );
          }
        }

        if (isSignatureLike(state.document, current)) {
          ensureCandidate(state, current, directIdentity);
        }
        const entries = dictionaryEntries(
          current,
          state.issues,
          state.limits.maxIssues,
          state.limits.maxDictionaryEntries,
          'physical_dictionary_entry_limit_exceeded',
        );
        if (entries !== null) {
          for (const { name, value } of entries) {
            const part = encodedPathPart(name);
            if (part === null) {
              addIssue(
                state.issues,
                'physical_path_component_limit_exceeded',
                state.limits.maxIssues,
              );
              continue;
            }
            visit(value, [...path, part], depth + 1);
          }
        }
      }
      active.delete(current);
    };

    visit(object, [], 0);
  }
}

function attachmentCandidate(
  state: DiscoveryState,
  value: PDFObject,
  identityHint: string,
  issueCode: string,
): CandidateBuilder | null {
  const resolved = resolveObject(
    state.document,
    value,
    state.issues,
    state.limits.maxIssues,
    `${issueCode}_lookup_failed`,
  );
  if (!(resolved instanceof PDFDict)) {
    addIssue(
      state.issues,
      `${issueCode}_not_dictionary`,
      state.limits.maxIssues,
    );
    return null;
  }
  return ensureCandidate(
    state,
    resolved,
    state.physicalIdentityByDictionary.get(resolved) ?? identityHint,
  );
}

function resolvedText(
  state: DiscoveryState,
  value: PDFObject | undefined,
  issueCode: string,
): string | null {
  if (value === undefined) return null;
  const resolved = resolveObject(
    state.document,
    value,
    state.issues,
    state.limits.maxIssues,
    `${issueCode}_lookup_failed`,
  );
  if (!(resolved instanceof PDFString) && !(resolved instanceof PDFHexString)) {
    addIssue(state.issues, `${issueCode}_not_text`, state.limits.maxIssues);
    return null;
  }
  if (resolved.sizeInBytes() > MAX_FIELD_NAME_BYTES + 2) {
    addIssue(
      state.issues,
      `${issueCode}_byte_limit_exceeded`,
      state.limits.maxIssues,
    );
    return null;
  }
  try {
    const text = resolved.decodeText();
    if (new TextEncoder().encode(text).byteLength > MAX_FIELD_NAME_BYTES) {
      addIssue(
        state.issues,
        `${issueCode}_byte_limit_exceeded`,
        state.limits.maxIssues,
      );
      return null;
    }
    return text;
  } catch {
    addIssue(
      state.issues,
      `${issueCode}_decode_failed`,
      state.limits.maxIssues,
    );
    return null;
  }
}

function discoverSignedFieldAttachments(state: DiscoveryState): void {
  const rawAcroForm = state.document.catalog.get(PDFName.of('AcroForm'));
  if (rawAcroForm === undefined) return;
  const acroForm = resolveObject(
    state.document,
    rawAcroForm,
    state.issues,
    state.limits.maxIssues,
    'acroform_lookup_failed',
  );
  if (!(acroForm instanceof PDFDict)) {
    addIssue(state.issues, 'acroform_not_dictionary', state.limits.maxIssues);
    return;
  }
  const rawFields = acroForm.get(PDFName.of('Fields'));
  if (rawFields === undefined) return;
  const fields = resolveObject(
    state.document,
    rawFields,
    state.issues,
    state.limits.maxIssues,
    'acroform_fields_lookup_failed',
  );
  if (!(fields instanceof PDFArray)) {
    addIssue(state.issues, 'acroform_fields_not_array', state.limits.maxIssues);
    return;
  }

  const activeRefs = new Set<string>();
  const activeDirect = new Set<PDFObject>();
  const visit = (
    rawField: PDFObject,
    inheritedType: string | null,
    parentName: string | null,
    depth: number,
    indexPath: string,
  ): void => {
    if (state.fieldNodeCount >= state.limits.maxFieldNodes) {
      addIssue(
        state.issues,
        'field_node_limit_exceeded',
        state.limits.maxIssues,
      );
      return;
    }
    if (depth > state.limits.maxDepth) {
      addIssue(
        state.issues,
        'field_depth_limit_exceeded',
        state.limits.maxIssues,
      );
      return;
    }
    state.fieldNodeCount += 1;

    const rawRef = rawField instanceof PDFRef ? rawField : null;
    const refIdentity = rawRef === null ? null : referenceIdentity(rawRef);
    const field = resolveObject(
      state.document,
      rawField,
      state.issues,
      state.limits.maxIssues,
      'field_lookup_failed',
    );
    if (!(field instanceof PDFDict)) {
      addIssue(state.issues, 'field_not_dictionary', state.limits.maxIssues);
      return;
    }
    if (refIdentity !== null) {
      if (activeRefs.has(refIdentity)) {
        addIssue(state.issues, 'field_tree_cycle', state.limits.maxIssues);
        return;
      }
      activeRefs.add(refIdentity);
    } else {
      if (activeDirect.has(field)) {
        addIssue(state.issues, 'field_tree_cycle', state.limits.maxIssues);
        return;
      }
      activeDirect.add(field);
    }

    const ownType = resolvedNameWithoutIssue(
      state.document,
      field.get(PDFName.of('FT')),
    );
    const fieldType = ownType ?? inheritedType;
    const partialName = resolvedText(
      state,
      field.get(PDFName.of('T')),
      'field_name',
    );
    let fieldName =
      partialName === null
        ? parentName
        : parentName === null || parentName.length === 0
          ? partialName
          : `${parentName}.${partialName}`;
    if (
      fieldName !== null &&
      new TextEncoder().encode(fieldName).byteLength > MAX_FIELD_NAME_BYTES
    ) {
      addIssue(
        state.issues,
        'field_name_byte_limit_exceeded',
        state.limits.maxIssues,
      );
      fieldName = null;
    }
    const fieldIdentity =
      refIdentity === null
        ? (state.physicalIdentityByDictionary.get(field) ??
          `direct:field:${indexPath}`)
        : `ref:${refIdentity}`;
    const rawValue = field.get(PDFName.of('V'));
    if (rawValue !== undefined && rawValue !== PDFNull) {
      const resolvedValue = resolveObject(
        state.document,
        rawValue,
        state.issues,
        state.limits.maxIssues,
        'field_value_lookup_failed',
      );
      const signatureLike =
        resolvedValue instanceof PDFDict &&
        isSignatureLike(state.document, resolvedValue);
      if (fieldType === 'Sig' || signatureLike) {
        const candidate = attachmentCandidate(
          state,
          rawValue,
          `direct:${fieldIdentity}:V`,
          'signed_field_value',
        );
        if (candidate !== null) {
          candidate.roles.add('document');
          if (
            candidate.signedFieldAttachments.length >=
            state.limits.maxAttachmentsPerSignature
          ) {
            addIssue(
              candidate.issues,
              'signed_field_attachment_limit_exceeded',
              state.limits.maxIssues,
            );
          } else {
            candidate.signedFieldAttachments.push({
              fieldIdentity,
              fieldRef: refIdentity,
              fieldName,
              rawValue: rawObjectForm(rawValue),
            });
          }
          if (fieldType !== 'Sig') {
            addIssue(
              candidate.issues,
              'signature_value_attached_to_non_signature_field',
              state.limits.maxIssues,
            );
          }
        }
      }
    }

    const rawKids = field.get(PDFName.of('Kids'));
    if (rawKids !== undefined) {
      const kids = resolveObject(
        state.document,
        rawKids,
        state.issues,
        state.limits.maxIssues,
        'field_kids_lookup_failed',
      );
      if (!(kids instanceof PDFArray)) {
        addIssue(state.issues, 'field_kids_not_array', state.limits.maxIssues);
      } else if (kids.size() > state.limits.maxArrayEntries) {
        addIssue(
          state.issues,
          'field_kids_entry_limit_exceeded',
          state.limits.maxIssues,
        );
      } else {
        for (let index = 0; index < kids.size(); index += 1) {
          const child = kids.get(index);
          const resolvedChild = resolveObject(
            state.document,
            child,
            state.issues,
            state.limits.maxIssues,
            'field_kid_lookup_failed',
          );
          if (
            resolvedChild instanceof PDFDict &&
            resolvedNameWithoutIssue(
              state.document,
              resolvedChild.get(PDFName.of('Subtype')),
            ) === 'Widget' &&
            !resolvedChild.has(PDFName.of('T')) &&
            !resolvedChild.has(PDFName.of('FT')) &&
            !resolvedChild.has(PDFName.of('Kids'))
          ) {
            continue;
          }
          visit(
            child,
            fieldType,
            fieldName,
            depth + 1,
            `${indexPath}.${index}`,
          );
        }
      }
    }

    if (refIdentity !== null) activeRefs.delete(refIdentity);
    else activeDirect.delete(field);
  };

  if (fields.size() > state.limits.maxArrayEntries) {
    addIssue(
      state.issues,
      'acroform_fields_entry_limit_exceeded',
      state.limits.maxIssues,
    );
    return;
  }
  for (let index = 0; index < fields.size(); index += 1) {
    visit(fields.get(index), null, null, 0, `${index}`);
  }
}

function permsRole(key: string): PdfSignatureRole | null {
  if (key === 'DocMDP') return 'docmdp';
  if (key === 'UR') return 'ur';
  if (key === 'UR3') return 'ur3';
  return null;
}

function discoverCatalogPermsAttachments(state: DiscoveryState): void {
  const rawPerms = state.document.catalog.get(PDFName.of('Perms'));
  if (rawPerms === undefined) return;
  const perms = resolveObject(
    state.document,
    rawPerms,
    state.issues,
    state.limits.maxIssues,
    'catalog_perms_lookup_failed',
  );
  if (!(perms instanceof PDFDict)) {
    addIssue(
      state.issues,
      'catalog_perms_not_dictionary',
      state.limits.maxIssues,
    );
    return;
  }
  const entries = dictionaryEntries(
    perms,
    state.issues,
    state.limits.maxIssues,
    state.limits.maxDictionaryEntries,
    'catalog_perms_entry_limit_exceeded',
  );
  if (entries === null) return;

  for (const { name: key, value } of entries) {
    const role = permsRole(key);
    const resolved = resolveObject(
      state.document,
      value,
      state.issues,
      state.limits.maxIssues,
      'catalog_perms_value_lookup_failed',
    );
    const signatureLike =
      resolved instanceof PDFDict && isSignatureLike(state.document, resolved);
    if (role === null && !signatureLike) {
      addIssue(
        state.issues,
        'catalog_perms_unknown_entry',
        state.limits.maxIssues,
      );
      continue;
    }
    const candidate = attachmentCandidate(
      state,
      value,
      `direct:catalog:Perms:${encodeURIComponent(key)}`,
      'catalog_perms_value',
    );
    if (candidate === null) continue;
    if (role !== null) candidate.roles.add(role);
    if (
      candidate.catalogPermsAttachments.length >=
      state.limits.maxAttachmentsPerSignature
    ) {
      addIssue(
        candidate.issues,
        'catalog_perms_attachment_limit_exceeded',
        state.limits.maxIssues,
      );
      continue;
    }
    candidate.catalogPermsAttachments.push({
      permsContainer: rawObjectForm(rawPerms),
      key,
      rawValue: rawObjectForm(value),
    });
  }
}

function canonicalBudget(
  state: CanonicalState,
  bytes: number,
  issue: string,
): boolean {
  if (state.nodeCount >= state.limits.maxCanonicalNodes) {
    addIssue(
      state.issues,
      'canonical_node_limit_exceeded',
      state.limits.maxIssues,
    );
    return false;
  }
  state.nodeCount += 1;
  if (bytes > state.limits.maxCanonicalBytes - state.byteCount) {
    addIssue(state.issues, issue, state.limits.maxIssues);
    return false;
  }
  state.byteCount += bytes;
  return true;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

function canonicalSetArray(
  method: string | null,
  dictionaryKind: CanonicalContext['dictionaryKind'],
  key: string,
): boolean {
  if (dictionaryKind !== 'transform_params') return false;
  if (method === 'FieldMDP' && key === 'Fields') return true;
  return (
    (method === 'UR' || method === 'UR3') && USAGE_RIGHTS_SET_KEYS.has(key)
  );
}

function canonicalObject(
  object: PDFObject,
  state: CanonicalState,
  depth: number,
  context: CanonicalContext,
): unknown {
  if (depth > state.limits.maxDepth) {
    addIssue(
      state.issues,
      'canonical_depth_limit_exceeded',
      state.limits.maxIssues,
    );
    return ['inconclusive', 'depth'];
  }
  if (!canonicalBudget(state, 8, 'canonical_byte_limit_exceeded')) {
    return ['inconclusive', 'budget'];
  }

  if (object instanceof PDFRef) {
    const identity = referenceIdentity(object);
    const resolved = lookupReference(
      state.document,
      object,
      state.issues,
      state.limits.maxIssues,
      'canonical_reference_lookup_failed',
    );
    if (resolved === undefined) return ['ref', identity, ['missing']];
    if (context.referenceOnly) return ['ref', identity];
    if (state.activeRefs.has(identity)) {
      addIssue(
        state.issues,
        'canonical_reference_cycle',
        state.limits.maxIssues,
      );
      return ['ref', identity, ['cycle']];
    }
    state.activeRefs.add(identity);
    const value = canonicalObject(resolved, state, depth + 1, {
      ...context,
      referenceOnly: false,
    });
    state.activeRefs.delete(identity);
    return ['ref', identity, value];
  }
  if (object === PDFNull) return ['null'];
  if (object instanceof PDFBool) return ['boolean', object.asBoolean()];
  if (object instanceof PDFNumber) {
    const number = object.asNumber();
    if (!Number.isFinite(number)) {
      addIssue(
        state.issues,
        'canonical_number_invalid',
        state.limits.maxIssues,
      );
      return ['number', 'invalid'];
    }
    return ['number', Object.is(number, -0) ? 0 : number];
  }
  if (object instanceof PDFName) {
    if (object.sizeInBytes() > state.limits.maxCanonicalBytes) {
      addIssue(
        state.issues,
        'canonical_byte_limit_exceeded',
        state.limits.maxIssues,
      );
      return ['name', 'truncated'];
    }
    let value: string;
    try {
      value = object.decodeText();
    } catch {
      addIssue(
        state.issues,
        'canonical_name_decode_failed',
        state.limits.maxIssues,
      );
      return ['name', 'invalid'];
    }
    if (
      !canonicalBudget(
        state,
        new TextEncoder().encode(value).byteLength,
        'canonical_byte_limit_exceeded',
      )
    ) {
      return ['name', 'truncated'];
    }
    return ['name', value];
  }
  if (object instanceof PDFString || object instanceof PDFHexString) {
    if (object.sizeInBytes() > state.limits.maxCanonicalBytes + 2) {
      addIssue(
        state.issues,
        'canonical_byte_limit_exceeded',
        state.limits.maxIssues,
      );
      return ['string', 'truncated'];
    }
    let bytes: Uint8Array;
    try {
      bytes = object.asBytes();
    } catch {
      addIssue(
        state.issues,
        'canonical_string_decode_failed',
        state.limits.maxIssues,
      );
      return ['string', 'invalid'];
    }
    if (
      bytes.byteLength > state.limits.maxCanonicalBytes ||
      !canonicalBudget(
        state,
        bytes.byteLength * 2,
        'canonical_byte_limit_exceeded',
      )
    ) {
      return ['string', 'truncated'];
    }
    return [
      object instanceof PDFHexString ? 'hex_string' : 'string',
      bytesToHex(bytes),
    ];
  }
  if (object instanceof PDFStream) {
    addIssue(
      state.issues,
      'canonical_stream_unsupported',
      state.limits.maxIssues,
    );
    return ['stream', 'unsupported'];
  }
  if (object instanceof PDFArray) {
    if (state.activeObjects.has(object)) {
      addIssue(state.issues, 'canonical_direct_cycle', state.limits.maxIssues);
      return ['array', ['cycle']];
    }
    if (object.size() > state.limits.maxArrayEntries) {
      addIssue(
        state.issues,
        'canonical_array_entry_limit_exceeded',
        state.limits.maxIssues,
      );
      return ['array', ['inconclusive', 'entry_limit']];
    }
    state.activeObjects.add(object);
    const values: unknown[] = [];
    for (let index = 0; index < object.size(); index += 1) {
      values.push(
        canonicalObject(object.get(index), state, depth + 1, {
          ...context,
          sortArrayAsSet: false,
          referenceOnly: false,
        }),
      );
    }
    state.activeObjects.delete(object);
    if (context.sortArrayAsSet) {
      values.sort((left, right) =>
        compareStrings(JSON.stringify(left), JSON.stringify(right)),
      );
    }
    return ['array', values];
  }
  if (object instanceof PDFDict) {
    if (state.activeObjects.has(object)) {
      addIssue(state.issues, 'canonical_direct_cycle', state.limits.maxIssues);
      return ['dictionary', ['cycle']];
    }
    const entries = dictionaryEntries(
      object,
      state.issues,
      state.limits.maxIssues,
      state.limits.maxDictionaryEntries,
      'canonical_dictionary_entry_limit_exceeded',
    );
    if (entries === null) {
      return ['dictionary', ['inconclusive', 'entry_limit']];
    }
    const ownTransformMethod =
      resolvedNameWithoutIssue(
        state.document,
        object.get(PDFName.of('TransformMethod')),
      ) ?? context.transformMethod;
    state.activeObjects.add(object);
    const values = entries.map(({ name, value }) => {
      const isTransformParams = name === 'TransformParams';
      return [
        name,
        canonicalObject(value, state, depth + 1, {
          transformMethod: ownTransformMethod,
          dictionaryKind: isTransformParams ? 'transform_params' : 'ordinary',
          sortArrayAsSet: canonicalSetArray(
            ownTransformMethod,
            context.dictionaryKind,
            name,
          ),
          referenceOnly: name === 'Data',
        }),
      ];
    });
    state.activeObjects.delete(object);
    return ['dictionary', values];
  }

  addIssue(state.issues, 'canonical_unknown_object', state.limits.maxIssues);
  return ['unknown'];
}

function canonicalValue(
  document: PDFDocument,
  value: PDFObject | undefined,
  state: CanonicalState,
): string | null {
  if (value === undefined) return null;
  return JSON.stringify(
    canonicalObject(value, state, 0, EMPTY_CANONICAL_CONTEXT),
  );
}

function resolvedName(
  document: PDFDocument,
  dictionary: PDFDict,
  key: string,
  issues: Set<string>,
  maxIssues: number,
): string | null {
  const raw = dictionary.get(PDFName.of(key));
  if (raw === undefined) return null;
  const resolved = resolveObject(
    document,
    raw,
    issues,
    maxIssues,
    `${key.toLowerCase()}_lookup_failed`,
  );
  if (!(resolved instanceof PDFName)) {
    addIssue(issues, `${key.toLowerCase()}_not_name`, maxIssues);
    return null;
  }
  try {
    return resolved.decodeText();
  } catch {
    addIssue(issues, `${key.toLowerCase()}_decode_failed`, maxIssues);
    return null;
  }
}

function resolvedByteRange(
  document: PDFDocument,
  dictionary: PDFDict,
  issues: Set<string>,
  maxIssues: number,
): {
  readonly raw: PdfSignatureRawObjectForm;
  readonly elementRaw: readonly PdfSignatureRawObjectForm[];
  readonly value: readonly [number, number, number, number] | null;
} {
  const raw = dictionary.get(PDFName.of('ByteRange'));
  if (raw === undefined) {
    addIssue(issues, 'byte_range_missing', maxIssues);
    return { raw: rawObjectForm(raw), elementRaw: [], value: null };
  }
  const resolved = resolveObject(
    document,
    raw,
    issues,
    maxIssues,
    'byte_range_lookup_failed',
  );
  if (!(resolved instanceof PDFArray) || resolved.size() !== 4) {
    addIssue(issues, 'byte_range_not_four_item_array', maxIssues);
    return { raw: rawObjectForm(raw), elementRaw: [], value: null };
  }
  const values: number[] = [];
  const elementRaw: PdfSignatureRawObjectForm[] = [];
  for (let index = 0; index < resolved.size(); index += 1) {
    const rawItem = resolved.get(index);
    elementRaw.push(rawObjectForm(rawItem));
    const item = resolveObject(
      document,
      rawItem,
      issues,
      maxIssues,
      'byte_range_item_lookup_failed',
    );
    if (!(item instanceof PDFNumber)) {
      addIssue(issues, 'byte_range_item_not_number', maxIssues);
      continue;
    }
    const number = item.asNumber();
    if (!Number.isSafeInteger(number) || number < 0) {
      addIssue(issues, 'byte_range_item_invalid', maxIssues);
      continue;
    }
    values.push(number);
  }
  return {
    raw: rawObjectForm(raw),
    elementRaw,
    value:
      values.length === 4 ? (values as [number, number, number, number]) : null,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  try {
    const digest = await subtle.digest('SHA-256', buffer);
    return bytesToHex(new Uint8Array(digest));
  } catch {
    return null;
  }
}

async function signatureContents(
  document: PDFDocument,
  dictionary: PDFDict,
  issues: Set<string>,
  limits: NormalizedLimits,
): Promise<{
  readonly raw: PdfSignatureRawObjectForm;
  readonly sha256: string | null;
  readonly length: number | null;
}> {
  const raw = dictionary.get(PDFName.of('Contents'));
  if (raw === undefined) {
    addIssue(issues, 'contents_missing', limits.maxIssues);
    return { raw: rawObjectForm(raw), sha256: null, length: null };
  }
  const resolved = resolveObject(
    document,
    raw,
    issues,
    limits.maxIssues,
    'contents_lookup_failed',
  );
  if (!(resolved instanceof PDFString) && !(resolved instanceof PDFHexString)) {
    addIssue(issues, 'contents_not_string', limits.maxIssues);
    return { raw: rawObjectForm(raw), sha256: null, length: null };
  }
  if (resolved.sizeInBytes() > limits.maxContentsBytes + 2) {
    addIssue(issues, 'contents_byte_limit_exceeded', limits.maxIssues);
    return { raw: rawObjectForm(raw), sha256: null, length: null };
  }
  let bytes: Uint8Array;
  try {
    bytes = resolved.asBytes();
  } catch {
    addIssue(issues, 'contents_decode_failed', limits.maxIssues);
    return { raw: rawObjectForm(raw), sha256: null, length: null };
  }
  if (bytes.byteLength > limits.maxContentsBytes) {
    addIssue(issues, 'contents_byte_limit_exceeded', limits.maxIssues);
    return { raw: rawObjectForm(raw), sha256: null, length: bytes.byteLength };
  }
  const digest = await sha256Hex(bytes);
  if (digest === null) addIssue(issues, 'sha256_unavailable', limits.maxIssues);
  return {
    raw: rawObjectForm(raw),
    sha256: digest,
    length: bytes.byteLength,
  };
}

function inspectTransformMethods(
  document: PDFDocument,
  dictionary: PDFDict,
  candidate: CandidateBuilder,
  limits: NormalizedLimits,
): readonly string[] {
  const rawReference = dictionary.get(PDFName.of('Reference'));
  if (rawReference === undefined) return [];
  const reference = resolveObject(
    document,
    rawReference,
    candidate.issues,
    limits.maxIssues,
    'signature_reference_lookup_failed',
  );
  if (!(reference instanceof PDFArray)) {
    addIssue(
      candidate.issues,
      'signature_reference_not_array',
      limits.maxIssues,
    );
    return [];
  }
  if (reference.size() > limits.maxArrayEntries) {
    addIssue(
      candidate.issues,
      'signature_reference_entry_limit_exceeded',
      limits.maxIssues,
    );
    return [];
  }
  const methods = new Set<string>();
  for (let index = 0; index < reference.size(); index += 1) {
    const item = resolveObject(
      document,
      reference.get(index),
      candidate.issues,
      limits.maxIssues,
      'signature_reference_item_lookup_failed',
    );
    if (!(item instanceof PDFDict)) {
      addIssue(
        candidate.issues,
        'signature_reference_item_not_dictionary',
        limits.maxIssues,
      );
      continue;
    }
    const method = resolvedName(
      document,
      item,
      'TransformMethod',
      candidate.issues,
      limits.maxIssues,
    );
    if (method === null) continue;
    methods.add(method);
    if (method === 'DocMDP') candidate.roles.add('docmdp');
    else if (method === 'FieldMDP') candidate.roles.add('fieldmdp');
    else if (method === 'UR') candidate.roles.add('ur');
    else if (method === 'UR3') candidate.roles.add('ur3');
    else if (method !== 'Identity') {
      addIssue(
        candidate.issues,
        'signature_transform_method_unknown',
        limits.maxIssues,
      );
    }
  }
  return [...methods].sort();
}

function sortedUnique<T>(values: readonly T[]): T[] {
  const byCanonical = new Map<string, T>();
  for (const value of values) byCanonical.set(JSON.stringify(value), value);
  return [...byCanonical.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, value]) => value);
}

async function fingerprintCandidate(
  document: PDFDocument,
  candidate: CandidateBuilder,
  limits: NormalizedLimits,
): Promise<PdfSignatureFingerprint> {
  const issues = candidate.issues;
  const canonicalState: CanonicalState = {
    document,
    limits,
    issues,
    activeObjects: new Set(),
    activeRefs: new Set(),
    nodeCount: 0,
    byteCount: 0,
  };
  const type = resolvedName(
    document,
    candidate.dictionary,
    'Type',
    issues,
    limits.maxIssues,
  );
  if (type !== 'Sig')
    addIssue(issues, 'signature_type_not_sig', limits.maxIssues);
  const filter = resolvedName(
    document,
    candidate.dictionary,
    'Filter',
    issues,
    limits.maxIssues,
  );
  const subFilter = resolvedName(
    document,
    candidate.dictionary,
    'SubFilter',
    issues,
    limits.maxIssues,
  );
  const byteRange = resolvedByteRange(
    document,
    candidate.dictionary,
    issues,
    limits.maxIssues,
  );
  const contents = await signatureContents(
    document,
    candidate.dictionary,
    issues,
    limits,
  );
  const transformMethods = inspectTransformMethods(
    document,
    candidate.dictionary,
    candidate,
    limits,
  );
  if (candidate.roles.size === 0 && type === 'Sig') {
    candidate.roles.add('document');
  }

  const typeCanonical = canonicalValue(
    document,
    candidate.dictionary.get(PDFName.of('Type')),
    canonicalState,
  );
  const filterCanonical = canonicalValue(
    document,
    candidate.dictionary.get(PDFName.of('Filter')),
    canonicalState,
  );
  const subFilterCanonical = canonicalValue(
    document,
    candidate.dictionary.get(PDFName.of('SubFilter')),
    canonicalState,
  );
  const referenceCanonical = canonicalValue(
    document,
    candidate.dictionary.get(PDFName.of('Reference')),
    canonicalState,
  );
  const roles = [...candidate.roles].sort();
  const signedFieldAttachments = sortedUnique(candidate.signedFieldAttachments);
  const catalogPermsAttachments = sortedUnique(
    candidate.catalogPermsAttachments,
  );
  const inconclusive = issues.size > 0;
  const payload = JSON.stringify([
    ['byteRangeRaw', byteRange.raw],
    ['byteRangeElementRaw', byteRange.elementRaw],
    ['resolvedByteRange', byteRange.value],
    ['contentsRaw', contents.raw],
    ['contentsSha256', contents.sha256],
    ['contentsLength', contents.length],
    ['type', type],
    ['filter', filter],
    ['subFilter', subFilter],
    ['typeCanonical', typeCanonical],
    ['filterCanonical', filterCanonical],
    ['subFilterCanonical', subFilterCanonical],
    ['roles', roles],
    ['transformMethods', transformMethods],
    ['signedFieldAttachments', signedFieldAttachments],
    ['catalogPermsAttachments', catalogPermsAttachments],
    ['referenceCanonical', referenceCanonical],
  ]);
  const fingerprint = inconclusive
    ? null
    : await sha256Hex(new TextEncoder().encode(payload));
  if (!inconclusive && fingerprint === null) {
    addIssue(issues, 'sha256_unavailable', limits.maxIssues);
  }

  return {
    identity: candidate.identity,
    fingerprint: issues.size === 0 ? fingerprint : null,
    inconclusive: issues.size > 0,
    issues: [...issues].sort(),
    byteRangeRaw: byteRange.raw,
    byteRangeElementRaw: byteRange.elementRaw,
    resolvedByteRange: byteRange.value,
    contentsRaw: contents.raw,
    contentsSha256: contents.sha256,
    contentsLength: contents.length,
    type,
    filter,
    subFilter,
    typeCanonical,
    filterCanonical,
    subFilterCanonical,
    roles,
    transformMethods,
    signedFieldAttachments,
    catalogPermsAttachments,
    referenceCanonical,
  };
}

export async function fingerprintPdfSignatures(
  document: PDFDocument,
  limits: PdfSignatureFingerprintLimits = {},
): Promise<PdfSignatureFingerprintSnapshot> {
  const normalizedLimits = normalizeLimits(limits);
  const state: DiscoveryState = {
    document,
    limits: normalizedLimits,
    issues: new Set(),
    candidates: new Map(),
    candidateByDictionary: new Map(),
    physicalIdentityByDictionary: new Map(),
    indirectRefByDictionary: new Map(),
    physicalNodeCount: 0,
    fieldNodeCount: 0,
  };
  discoverPhysicalDictionaries(state);
  discoverSignedFieldAttachments(state);
  discoverCatalogPermsAttachments(state);

  const signatures: PdfSignatureFingerprint[] = [];
  for (const candidate of [...state.candidates.values()].sort((left, right) =>
    compareStrings(left.identity, right.identity),
  )) {
    const fingerprint = await fingerprintCandidate(
      document,
      candidate,
      normalizedLimits,
    );
    signatures.push(fingerprint);
    for (const issue of fingerprint.issues) {
      addIssue(
        state.issues,
        `signature:${candidate.identity}:${issue}`,
        normalizedLimits.maxIssues,
      );
    }
  }

  const fingerprintsByIdentity: Record<string, PdfSignatureFingerprint> = {};
  for (const signature of signatures) {
    fingerprintsByIdentity[signature.identity] = signature;
  }
  const issues = [...state.issues].sort();
  return {
    complete: issues.length === 0,
    inconclusive: issues.length > 0,
    issues,
    signatures,
    fingerprintsByIdentity,
  };
}
