import * as vm from 'vm';
import { spawn } from 'child_process';

interface CodeInput {
  language: 'javascript' | 'python';
  code: string;
}

interface CodeResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

const TIMEOUT_MS = 5000;

export async function runCode(input: CodeInput): Promise<CodeResult> {
  const { language, code } = input;

  if (language === 'javascript') {
    return runJavaScript(code);
  } else if (language === 'python') {
    return runPython(code);
  } else {
    throw new Error(`Unsupported language: ${language}`);
  }
}

function runJavaScript(code: string): CodeResult {
  const start = Date.now();
  let stdout = '';
  let stderr = '';
  let exit_code = 0;

  // Sandboxed context — no fs, net, or process access
  const sandbox = {
    console: {
      log: (...args: unknown[]) => { stdout += args.map(String).join(' ') + '\n'; },
      error: (...args: unknown[]) => { stderr += args.map(String).join(' ') + '\n'; },
      warn: (...args: unknown[]) => { stderr += args.map(String).join(' ') + '\n'; },
    },
    Math,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Date,
    RegExp,
    Error,
  };

  try {
    const context = vm.createContext(sandbox);
    vm.runInContext(code, context, {
      timeout: TIMEOUT_MS,
      filename: 'sandbox.js',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    stderr += message;
    exit_code = 1;
  }

  return {
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
    exit_code,
    duration_ms: Date.now() - start,
  };
}

function runPython(code: string): Promise<CodeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn('python3', ['-c', code], {
      timeout: TIMEOUT_MS,
      env: {
        // Minimal safe env — no network or fs tricks via env
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: '/tmp',
      },
    });

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exit_code: code ?? 1,
        duration_ms: Date.now() - start,
      });
    });

    proc.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: err.message,
        exit_code: 1,
        duration_ms: Date.now() - start,
      });
    });

    // Kill after timeout
    setTimeout(() => {
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);
  });
}
