import { describe, it, expect } from 'vitest';
import { optionalText, textArg } from '../src/cli/args';

const fromFile = (content: string) => () => content;

describe('textArg: free text from a positional or from --file', () => {
  it('takes the positional unchanged when there is no file', () => {
    expect(textArg('  exactly this\n', undefined, 'question')).toBe('  exactly this\n');
  });

  it('reads the file when one is given', () => {
    expect(textArg(undefined, 'q.txt', 'question', fromFile('a question with "quotes" in it'))).toBe(
      'a question with "quotes" in it',
    );
  });

  it("drops the byte-order mark and the one trailing newline PowerShell's Out-File writes", () => {
    expect(textArg(undefined, 'q.txt', 'question', fromFile('\uFEFFline one\r\nline two\r\n'))).toBe(
      'line one\r\nline two',
    );
  });

  it('keeps a byte-order mark that is not at the start, and every newline but the last', () => {
    expect(textArg(undefined, 'q.txt', 'question', fromFile('a\uFEFFb\n\n'))).toBe('a\uFEFFb\n');
  });

  it('refuses both a positional and a file', () => {
    expect(() => textArg('inline', 'q.txt', 'question', fromFile('file'))).toThrow(/not both/);
  });

  it('refuses neither', () => {
    expect(() => textArg(undefined, undefined, 'question')).toThrow(/missing question/);
  });

  it('refuses a file with nothing in it', () => {
    expect(() => textArg(undefined, 'q.txt', 'question', fromFile('\uFEFF  \r\n'))).toThrow(/empty/);
  });
});

describe('optionalText: a field that may be left out', () => {
  it('is undefined when neither the option nor its file is given', () => {
    expect(optionalText(undefined, undefined, 'description')).toBeUndefined();
  });

  it('passes the inline value through, and reads the file', () => {
    expect(optionalText('inline', undefined, 'description')).toBe('inline');
    expect(optionalText(undefined, 'd.txt', 'description', fromFile('from "a" file\n'))).toBe('from "a" file');
  });

  it('refuses both, naming the two flags', () => {
    expect(() => optionalText('inline', 'd.txt', 'description', fromFile('file'))).toThrow(
      /--description or --description-file/,
    );
  });
});
