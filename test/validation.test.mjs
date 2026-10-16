import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { parseIsDraft } from '../dist/validation.js';

test('absent isDraft defaults to a draft', () => {
  assert.equal(parseIsDraft(undefined), true);
});

test('real booleans pass through', () => {
  assert.equal(parseIsDraft(true), true);
  assert.equal(parseIsDraft(false), false);
});

for (const value of [null, 0, 1, '', 'false', 'true', 'no', [], {}, Number.NaN]) {
  test(`non-boolean isDraft ${JSON.stringify(value)} is rejected, not published`, () => {
    assert.throws(
      () => parseIsDraft(value),
      (error) => error instanceof McpError && error.code === ErrorCode.InvalidParams && /isDraft must be a boolean/.test(error.message)
    );
  });
}
