import Groq from 'groq-sdk';

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = 'llama-3.3-70b-versatile';

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

async function chat(prompt: string, maxTokens: number): Promise<string> {
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0].message.content ?? '';
}

function extractJSON(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in LLM response');
  return JSON.parse(match[0]);
}

export async function summarize(text: string): Promise<SummarizeResult> {
  const raw = await chat(
    `Summarize the following text concisely. Respond with valid JSON only:
{"summary": "<summary text>", "word_count": <number of words in summary>}

Text to summarize:
${text}`,
    512
  );
  return extractJSON(raw) as SummarizeResult;
}

export async function classify(text: string, labels: string[]): Promise<ClassifyResult> {
  const raw = await chat(
    `Classify the following text into one of these labels: ${labels.join(', ')}.
Respond with valid JSON only:
{"label": "<one of the provided labels>", "confidence": <0.0-1.0>, "reasoning": "<brief reasoning>"}

Text to classify:
${text}`,
    256
  );
  return extractJSON(raw) as ClassifyResult;
}

export async function analyze(text: string, question: string): Promise<AnalyzeResult> {
  const raw = await chat(
    `Analyze the following text and answer the question.
Respond with valid JSON only:
{"answer": "<answer to the question>", "key_points": ["<point1>", "<point2>", ...]}

Text:
${text}

Question: ${question}`,
    1024
  );
  return extractJSON(raw) as AnalyzeResult;
}
