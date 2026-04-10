import Papa from 'papaparse';
import Groq from 'groq-sdk';

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = 'llama-3.3-70b-versatile';

interface DataInput {
  csv: string;
  question: string;
}

interface DataResult {
  answer: string;
  row_count: number;
  columns: string[];
  insights: string[];
}

export async function csvInsights(input: DataInput): Promise<DataResult> {
  const { csv, question } = input;

  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  const rows = parsed.data;
  const columns = parsed.meta.fields || [];
  const row_count = rows.length;

  // Build a compact data summary for the LLM
  const sampleRows = rows.slice(0, 10);
  const dataSummary = JSON.stringify({ columns, row_count, sample: sampleRows }, null, 2);

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a data analyst. Analyze the following CSV data and answer the question.
Respond with valid JSON only:
{"answer": "<answer to question>", "insights": ["<insight1>", "<insight2>", ...]}

Data summary (${row_count} rows):
${dataSummary}

Question: ${question}`,
      },
    ],
  });

  const raw = response.choices[0].message.content ?? '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in LLM response');
  const llmResult = JSON.parse(jsonMatch[0]) as { answer: string; insights: string[] };

  return {
    answer: llmResult.answer,
    row_count,
    columns,
    insights: llmResult.insights || [],
  };
}
