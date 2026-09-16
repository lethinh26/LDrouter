import { describe, expect, it } from 'vitest';
import { parseQoderImportText, toQoderPreview, type NormalizedQoderToken } from '../../src/server/providers/qoder/qoder-import';

describe('Qoder PAT import', () => {
  it('accepts one token per line', () => {
    const result = parseQoderImportText('pt-aaa\npt-bbb\n');
    expect(result).toHaveLength(2);
    expect(result.every((item) => 'personalToken' in item)).toBe(true);
  });

  it('accepts a JSON array, an accounts wrapper, and JSONL objects', () => {
    expect(parseQoderImportText('["pt-a","pt-b"]')).toHaveLength(2);
    expect(parseQoderImportText('{"accounts":["pt-a"]}')).toHaveLength(1);
    const jsonl = parseQoderImportText('{"token":"pt-a","label":"A"}\n{"personal_token":"pt-b"}');
    expect(jsonl).toHaveLength(2);
    expect(jsonl[0]).toMatchObject({ personalToken: 'pt-a', label: 'A' });
  });

  it('strips a BOM and surrounding whitespace', () => {
    const result = parseQoderImportText('\uFEFF  pt-a  ');
    expect(result[0]).toMatchObject({ personalToken: 'pt-a' });
  });

  it('rejects a device or job token with a clear reason', () => {
    const [failure] = parseQoderImportText('dt-abc');
    expect(failure).toMatchObject({ error: expect.stringContaining('pt-') });
    const [jobFailure] = parseQoderImportText('jt-abc');
    expect(jobFailure).toMatchObject({ error: expect.stringContaining('pt-') });
  });

  it('reports empty and malformed input instead of inventing records', () => {
    expect(parseQoderImportText('   ')[0]).toMatchObject({ error: 'Input is empty' });
    expect(parseQoderImportText('not a token')[0]).toMatchObject({ error: expect.stringContaining('pt-') });
  });

  it('never exposes the raw token in a preview', () => {
    // The normalized record legitimately carries the token (the server exchanges it); the
    // wire boundary is the preview, which is what a client can ever see.
    const [record] = parseQoderImportText('pt-super-secret-value');
    const preview = toQoderPreview(record as NormalizedQoderToken);
    expect(JSON.stringify(preview)).not.toContain('pt-super-secret-value');
    expect(preview.personalTokenMasked).toBe('pt-s…alue');
  });
});
