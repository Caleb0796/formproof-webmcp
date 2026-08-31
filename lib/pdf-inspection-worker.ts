import { inspectPdf, PdfEngineError, type PdfInspection } from './pdf-engine';

type PdfInspectionWorkerResponse =
  | { ok: true; inspection: PdfInspection }
  | { ok: false; code: string; message: string };

interface PdfInspectionWorkerScope {
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  postMessage(message: PdfInspectionWorkerResponse): void;
}

const workerScope = globalThis as unknown as PdfInspectionWorkerScope;

workerScope.onmessage = (event) => {
  void inspectPdf(new Uint8Array(event.data)).then(
    (inspection) => workerScope.postMessage({ ok: true, inspection }),
    (error: unknown) =>
      workerScope.postMessage({
        ok: false,
        code: error instanceof PdfEngineError ? error.code : 'PDF_LOAD_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'The PDF could not be inspected.',
      }),
  );
};
