import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * Validate the create_post isDraft flag at the tool boundary.
 *
 * Only a real boolean is accepted. An absent value means a draft, so the safe
 * default holds. Anything else (null, 0, "", "false", objects) is rejected
 * before any Blogger API call, rather than being coerced into a live publish.
 */
export function parseIsDraft(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `isDraft must be a boolean (true or false) or omitted to create a draft; received ${describeValue(value)}. No post was created.`
  );
}

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return `string ${JSON.stringify(value)}`;
  }

  return typeof value;
}
