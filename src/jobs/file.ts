import pdfParse from 'pdf-parse';

interface FileInput {
  file_base64: string;
  type: 'pdf';
}

interface FileResult {
  text: string;
  page_count: number;
  char_count: number;
}

export async function pdfToText(input: FileInput): Promise<FileResult> {
  if (input.type !== 'pdf') {
    throw new Error(`Unsupported file type: ${input.type}`);
  }

  const buffer = Buffer.from(input.file_base64, 'base64');
  const data = await pdfParse(buffer);

  return {
    text: data.text,
    page_count: data.numpages,
    char_count: data.text.length,
  };
}
