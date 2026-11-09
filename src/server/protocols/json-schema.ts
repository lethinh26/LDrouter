import { GatewayError } from '../errors';

const integerKeywords = new Set(['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'minContains', 'maxContains']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const singleSchemas = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']);

export function normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new GatewayError('invalid_request_error', 'JSON schema must be an object');
  }
  return normalizeSchemaNode(schema, 0) as Record<string, unknown>;
}

function normalizeSchemaNode(schema: unknown, depth: number): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (depth > 128) throw new GatewayError('invalid_request_error', 'JSON schema exceeds maximum nesting depth of 128');

  return Object.fromEntries(Object.entries(schema).map(([keyword, value]) => {
    if (integerKeywords.has(keyword)) {
      const integer = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      if (typeof integer !== 'number' || !Number.isSafeInteger(integer) || integer < 0) {
        throw new GatewayError('invalid_request_error', `JSON schema ${keyword} must be a non-negative safe integer`);
      }
      return [keyword, integer];
    }
    if (schemaMaps.has(keyword) && value && typeof value === 'object' && !Array.isArray(value)) {
      return [keyword, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalizeSchemaNode(child, depth + 1)]))];
    }
    if (schemaArrays.has(keyword) && Array.isArray(value)) {
      return [keyword, value.map((child) => normalizeSchemaNode(child, depth + 1))];
    }
    if (singleSchemas.has(keyword)) return [keyword, normalizeSchemaNode(value, depth + 1)];
    return [keyword, value];
  }));
}
