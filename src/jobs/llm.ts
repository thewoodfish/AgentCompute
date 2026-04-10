import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5';

interface SummarizeResult {
  summary: string;
  word_count: number;
}

interface ClassifyResult {
  label: string;
  confidence: number;
  reasoning: string;
}

interface AnalyzeResult {
  answer: string;
  key_points: string[];
}

export async function summarize(text: string): Promise<SummarizeResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Summarize the following text concisely. Respond with valid JSON only:
{"summary": "<summary text>", "word_count": <number of words in summary>}

Text to summarize:
${text}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type from LLM');

  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in LLM response');

  return JSON.parse(jsonMatch[0]) as SummarizeResult;
}

export async function classify(text: string, labels: string[]): Promise<ClassifyResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `Classify the following text into one of these labels: ${labels.join(', ')}.
Respond with valid JSON only:
{"label": "<one of the provided labels>", "confidence": <0.0-1.0>, "reasoning": "<brief reasoning>"}

Text to classify:
${text}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type from LLM');

  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in LLM response');

  return JSON.parse(jsonMatch[0]) as ClassifyResult;
}

export async function analyze(text: string, question: string): Promise<AnalyzeResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Analyze the following text and answer the question.
Respond with valid JSON only:
{"answer": "<answer to the question>", "key_points": ["<point1>", "<point2>", ...]}

Text:
${text}

Question: ${question}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error('Unexpected response type from LLM');

  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in LLM response');

  return JSON.parse(jsonMatch[0]) as AnalyzeResult;
}
