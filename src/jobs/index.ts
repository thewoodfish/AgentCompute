import { JobDefinition } from '../types';
import { summarize, classify, analyze } from './llm';
import { runCode } from './code';
import { csvInsights } from './data';
import { pdfToText } from './file';

export const JOB_REGISTRY: Record<string, JobDefinition> = {
  summarize: {
    name: 'summarize',
    price: '0.05',
    description: 'LLM-powered text summarization',
    estimated_duration_ms: 3000,
  },
  classify: {
    name: 'classify',
    price: '0.03',
    description: 'LLM-powered text classification',
    estimated_duration_ms: 2000,
  },
  analyze: {
    name: 'analyze',
    price: '0.08',
    description: 'LLM-powered text analysis and question answering',
    estimated_duration_ms: 4000,
  },
  'run-code': {
    name: 'run-code',
    price: '0.10',
    description: 'Sandboxed code execution (JavaScript or Python)',
    estimated_duration_ms: 8000,
  },
  'csv-insights': {
    name: 'csv-insights',
    price: '0.07',
    description: 'CSV data analysis with LLM insights',
    estimated_duration_ms: 6000,
  },
  'pdf-to-text': {
    name: 'pdf-to-text',
    price: '0.04',
    description: 'PDF text extraction',
    estimated_duration_ms: 3000,
  },
};

export function getJobDefinition(name: string): JobDefinition | undefined {
  return JOB_REGISTRY[name];
}

export function isLongJob(name: string): boolean {
  const job = JOB_REGISTRY[name];
  return job ? job.estimated_duration_ms >= 5000 : false;
}

export async function dispatchJob(
  job: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  switch (job) {
    case 'summarize':
      return summarize(payload.text as string);

    case 'classify':
      return classify(payload.text as string, payload.labels as string[]);

    case 'analyze':
      return analyze(payload.text as string, payload.question as string);

    case 'run-code':
      return runCode({
        language: payload.language as 'javascript' | 'python',
        code: payload.code as string,
      });

    case 'csv-insights':
      return csvInsights({
        csv: payload.csv as string,
        question: payload.question as string,
      });

    case 'pdf-to-text':
      return pdfToText({
        file_base64: payload.file_base64 as string,
        type: 'pdf',
      });

    default:
      throw new Error(`Unknown job: ${job}`);
  }
}
