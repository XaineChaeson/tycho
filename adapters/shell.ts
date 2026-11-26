// How a command an executor ran reads on the page: the script inside a shell it is known to
// wrap commands in, and whether that script plainly reads or searches. Conservative on
// purpose — anything with a pipe, a variable, a block or quoting it cannot follow is shown
// as it was written and counted as running a command, never guessed at (docs/design/
// phase1-design.md §8.1). Display only: nothing here changes a Run.
import type { ToolCategory } from './types.ts';

interface CommandReading {
  // The script without its wrapper, or the command as given.
  title: string;
  category: Extract<ToolCategory, 'read' | 'search' | 'run'>;
  paths?: string[];
}

type Dialect = 'posix' | 'powershell';

// Split POSIX-shell words: '…' literal, "…" with backslash before \ " $ ` and newline, a
// bare backslash escaping the next character. Undefined when a word is left open or the
// line holds an operator, a substitution or a redirect: then it is not a plain command.
function posixWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    // A line break outside quotes ends a statement; it is blank too, so it is caught first.
    if (char === '\n' || char === '\r') {
      return undefined;
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close < 0) return undefined;
      word = (word ?? '') + text.slice(at + 1, close);
      at = close;
    } else if (char === '"') {
      let piece = '';
      for (at += 1; at < text.length && text[at] !== '"'; at += 1) {
        if (text[at] === '\\' && '\\"$`\n'.includes(text[at + 1] ?? '')) at += 1;
        else if (text[at] === '$' || text[at] === '`') return undefined;
        piece += text[at];
      }
      if (at >= text.length) return undefined;
      word = (word ?? '') + piece;
    } else if (char === '\\') {
      // Before a line break it continues the line: more than one plain line, so not read.
      if (at + 1 >= text.length || '\r\n'.includes(text[at + 1]!)) return undefined;
      word = (word ?? '') + text[at + 1];
      at += 1;
    } else if (';|&<>()$`\n'.includes(char)) {
      return undefined;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

// PowerShell words for a script simple enough to read: '…' literal with '' for a quote,
// "…" only when nothing in it expands, a backslash an ordinary character (a Windows path).
// Undefined at a pipe, a statement separator, a block, a variable or a subexpression.
function powershellWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    // A line break outside quotes ends a statement; it is blank too, so it is caught first.
    if (char === '\n' || char === '\r') {
      return undefined;
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "'") {
      let piece = '';
      for (at += 1; ; at += 1) {
        if (at >= text.length) return undefined;
        if (text[at] === "'") {
          if (text[at + 1] !== "'") break;
          at += 1;
        }
        piece += text[at];
      }
      word = (word ?? '') + piece;
    } else if (char === '"') {
      const close = text.indexOf('"', at + 1);
      if (close < 0) return undefined;
      const piece = text.slice(at + 1, close);
      if (/[$`]/.test(piece)) return undefined;
      word = (word ?? '') + piece;
      at = close;
    } else if (';|&<>(){}$`@,\n'.includes(char)) {
      return undefined;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

const base = (program: string): string => program.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.exe$/, '');
// Switches PowerShell may carry before -Command without changing what the script is.
const POWERSHELL_FLAGS = new Set(['-noprofile', '-nologo', '-noninteractive']);

// The script inside `powershell.exe -Command "…"` or `bash -lc '…'`, when the line is
// exactly that and nothing else.
export function unwrapShell(command: string): { script: string; dialect: Dialect } | undefined {
  const words = posixWords(command);
  if (!words || words.length < 3) return undefined;
  const program = base(words[0]!);
  if (program === 'powershell' || program === 'pwsh') {
    let at = 1;
    while (at < words.length && POWERSHELL_FLAGS.has(words[at]!.toLowerCase())) at += 1;
    const flag = words[at]?.toLowerCase();
    if ((flag === '-command' || flag === '-c') && at + 2 === words.length) return { script: words[at + 1]!, dialect: 'powershell' };
    return undefined;
  }
  if (['bash', 'sh', 'zsh'].includes(program) && words.length === 3 && ['-c', '-lc'].includes(words[1]!)) {
    return { script: words[2]!, dialect: 'posix' };
  }
  return undefined;
}

// Options of a reading command that take the next word as their value, not as a file.
const VALUE_OPTIONS: Record<string, Set<string>> = {
  'get-content': new Set(['-encoding', '-totalcount', '-tail', '-head', '-first', '-last', '-readcount', '-delimiter', '-stream']),
  head: new Set(['-n', '-c']),
  tail: new Set(['-n', '-c']),
};
const READERS: Record<Dialect, Set<string>> = {
  posix: new Set(['cat', 'head', 'tail', 'nl']),
  powershell: new Set(['get-content', 'gc', 'cat', 'type']),
};
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'fd', 'find', 'ls', 'tree', 'select-string', 'sls', 'get-childitem', 'gci', 'dir', 'findstr']);
// The options of a searcher that run a program or write a file, by searcher.
const ACTING: Record<string, readonly string[]> = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  fd: ['-x', '-X', '--exec', '--exec-batch'],
  rg: ['--pre', '--hostname-bin'],
  tree: ['-o'],
  'git grep': ['-O', '--open-files-in-pager'],
};

// Whether an argument is one of these options however it is spelled: alone, `--key=value`,
// or a one-letter option with its value run on (`-Ovim`).
function acts(program: string, args: readonly string[]): boolean {
  const options = ACTING[program] ?? [];
  return args.some((arg) => options.some((option) =>
    arg === option || arg.startsWith(`${option}=`) || (/^-[A-Za-z]$/.test(option) && arg.startsWith(option))));
}

// A tool's input as the page shows it in full: a command's text as it was, anything else
// as JSON. Nothing when there was no input.
export function inputText(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  if (typeof command === 'string') return command;
  if (typeof input === 'object' && Object.keys(input).length === 0) return undefined;
  return JSON.stringify(input, null, 2);
}

// The files a reading command names: what is not an option and not an option's value.
function readPaths(program: string, args: string[]): string[] {
  const key = program === 'gc' || program === 'type' ? 'get-content' : program;
  const takesValue = VALUE_OPTIONS[key] ?? new Set<string>();
  const paths: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    const option = arg.toLowerCase();
    if (option === '-path' || option === '-literalpath') {
      if (args[at + 1] !== undefined) paths.push(args[at + 1]!);
      at += 1;
    } else if (takesValue.has(option)) {
      at += 1;
    } else if (!arg.startsWith('-')) {
      paths.push(arg);
    }
  }
  return paths;
}

// What a script plainly does, by its one command: read files, search or list, or run.
function classify(script: string, dialect: Dialect): Pick<CommandReading, 'category' | 'paths'> {
  const words = (dialect === 'posix' ? posixWords : powershellWords)(script.trim());
  if (!words?.length) return { category: 'run' };
  const program = dialect === 'posix' ? words[0]! : words[0]!.toLowerCase();
  const args = words.slice(1);
  if (READERS[dialect].has(program)) {
    const paths = readPaths(program, args);
    return paths.length ? { category: 'read', paths } : { category: 'run' };
  }
  // `sed -n '<range>p' <file>…`: printing lines of files and nothing else.
  if (dialect === 'posix' && program === 'sed' && args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1] ?? '') && args.length > 2 && args.slice(2).every((arg) => !arg.startsWith('-'))) {
    return { category: 'read', paths: args.slice(2) };
  }
  if (program === 'git' && ['grep', 'ls-files'].includes(args[0] ?? '')) return acts(`git ${args[0]}`, args.slice(1)) ? { category: 'run' } : { category: 'search' };
  // `find -delete`, `fd -x rm`, `rg --pre=helper`: a searcher that also acts is running a command.
  if (SEARCHERS.has(program)) return acts(program, args) ? { category: 'run' } : { category: 'search' };
  return { category: 'run' };
}

// A command as the page shows it: unwrapped when the wrapper is one known here, read as
// reading or searching only when its one command plainly is.
export function readCommand(command: string): CommandReading {
  const inner = unwrapShell(command);
  if (!inner) return { title: command, ...classify(command, 'posix') };
  return { title: inner.script, ...classify(inner.script, inner.dialect) };
}
