import { writeFile } from 'node:fs/promises';

import type {
  FormProofAdapterResult,
  FormProofWebMcpAdapter,
} from '../lib/webmcp';

const { createFormProofToolDefinitions } = (await import(
  new URL('../lib/webmcp.ts', import.meta.url).href
)) as typeof import('../lib/webmcp');

const SOURCE_HASH = 'a'.repeat(64);

const success = (): FormProofAdapterResult => ({
  ok: true,
  stateVersion: 0,
  sourceHash: SOURCE_HASH,
  documentSessionId: '4'.repeat(32),
  data: {},
});

const adapter: FormProofWebMcpAdapter = {
  getPdfProtection: success,
  getFormContext: success,
  getFieldEvidence: success,
  stageFormValues: success,
  validateFillPlan: success,
  startFillReview: success,
};

const tools = createFormProofToolDefinitions(
  adapter,
  () => undefined,
  new AbortController().signal,
).map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

const outputPath = new URL('../evals/tools.json', import.meta.url);
await writeFile(outputPath, `${JSON.stringify({ tools }, null, 2)}\n`, 'utf8');
