import { describe, expect, it } from 'vitest';
import { openAIToCanonical, canonicalToOpenAIRequest } from '../../src/server/protocols/canonical';
import { anthropicToCanonical, canonicalToAnthropicRequest } from '../../src/server/protocols/anthropic';

const adapters = {
  openai: (parameters: Record<string, unknown>) => openAIToCanonical({
    model: 'test', messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'send_message', parameters } }],
  }),
  anthropic: (parameters: Record<string, unknown>) => anthropicToCanonical({
    model: 'test', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'send_message', input_schema: parameters }],
  }),
};

for (const [protocol, adapt] of Object.entries(adapters)) {
  describe(`${protocol} schema integers`, () => {
    it('normalizes send_message constraints before forwarding to either protocol without mutation', () => {
      const parameters = {
        type: 'object', minProperties: '1', maxProperties: '4',
        properties: {
          recipients: { type: 'array', minItems: '1', maxItems: '10', items: { type: 'string', minLength: '1', maxLength: '100' } },
        },
      };
      const original = structuredClone(parameters);
      const canonical = adapt(parameters);
      const expected = {
        type: 'object', minProperties: 1, maxProperties: 4,
        properties: {
          recipients: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 100 } },
        },
      };
      expect(canonical.tools?.[0]?.inputSchema).toEqual(expected);
      expect(canonicalToOpenAIRequest(canonical, 'upstream').tools?.[0]?.function.parameters).toEqual(expected);
      expect(canonicalToAnthropicRequest(canonical, 'upstream').tools?.[0]?.input_schema).toEqual(expected);
      expect(parameters).toEqual(original);
    });

    it.each(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'])(
      'walks the %s schema map without interpreting property names as keywords', (keyword) => {
        const parameters = { type: 'object', [keyword]: { minItems: { type: 'array', minItems: '1' } } };
        expect(adapt(parameters).tools?.[0]?.inputSchema).toEqual({
          type: 'object', [keyword]: { minItems: { type: 'array', minItems: 1 } },
        });
      },
    );

    it.each(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'])(
      'walks the %s subschema', (keyword) => {
        expect(adapt({ [keyword]: { minLength: '1' } }).tools?.[0]?.inputSchema).toEqual({ [keyword]: { minLength: 1 } });
      },
    );

    it.each(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'])(
      'walks %s schema arrays', (keyword) => {
        expect(adapt({ [keyword]: [{ minItems: '0', minContains: '1', maxContains: '3' }, false] }).tools?.[0]?.inputSchema)
          .toEqual({ [keyword]: [{ minItems: 0, minContains: 1, maxContains: 3 }, false] });
      },
    );

    it('preserves annotations, extensions, boolean schemas, property dependencies and refs', () => {
      const literal = { minItems: '1', properties: { minLength: '2' }, type: 'STRING' };
      const parameters = {
        type: ['object', 'null'], default: literal, const: literal, enum: ['1', literal], examples: [literal],
        'x-provider': literal, $ref: '#/$defs/payload', $defs: { payload: { type: 'object' } },
        dependencies: { payload: ['minItems'] }, dependentRequired: { payload: ['minLength'] },
        additionalProperties: false, properties: { payload: true, hidden: false }, required: ['payload'],
      };
      expect(adapt(parameters).tools?.[0]?.inputSchema).toEqual(parameters);
    });

    it.each(['1.5', '-1', 'NaN', 'Infinity', '1e2', '', ' ', '0x10', '9007199254740993', 1.5, -1, null, true, {}, []])(
      'rejects invalid integer bound %j without exposing its value', (value) => {
        expect(() => adapt({ properties: { recipients: { minItems: value } } })).toThrow(/minItems.*non-negative safe integer/);
      },
    );

    it.each(['0', 0, '1', 1, '9007199254740991', Number.MAX_SAFE_INTEGER])('preserves exact integer bound %j', (value) => {
      expect(adapt({ minItems: value }).tools?.[0]?.inputSchema.minItems).toBe(Number(value));
    });

    it('does not leak a rejected schema value in an error', () => {
      const secret = 'private-schema-value';
      expect(() => adapt({ minItems: secret })).toThrow('minItems');
      expect(() => adapt({ minItems: secret })).not.toThrow(secret);
    });

    it('preserves a __proto__ property without changing object prototypes', () => {
      const parameters = JSON.parse('{"properties":{"__proto__":{"minItems":"1"}}}');
      const result = adapt(parameters).tools?.[0]?.inputSchema;
      expect(result).toEqual(JSON.parse('{"properties":{"__proto__":{"minItems":1}}}'));
      expect(Object.getPrototypeOf(result?.properties)).toBe(Object.prototype);
      expect(Object.hasOwn(result?.properties as object, '__proto__')).toBe(true);
      expect(Object.hasOwn(Object.prototype, 'minItems')).toBe(false);
    });

    it('rejects excessive schema nesting with a client error instead of overflowing the stack', () => {
      let parameters: Record<string, unknown> = { minItems: '1' };
      for (let depth = 0; depth < 200; depth++) parameters = { items: parameters };
      expect(() => adapt(parameters)).toThrow(/schema.*nesting/i);
    });
  });
}

it('normalizes integer constraints in Chat structured-output schemas as well', () => {
  const canonical = openAIToCanonical({
    model: 'test', messages: [{ role: 'user', content: 'hello' }],
    response_format: { type: 'json_schema', json_schema: { schema: { type: 'array', minItems: '1', items: { type: 'string', default: '1' } } } },
  });
  expect(canonical.responseFormat?.jsonSchema).toEqual({ type: 'array', minItems: 1, items: { type: 'string', default: '1' } });
  expect(canonicalToOpenAIRequest(canonical, 'upstream').response_format?.json_schema?.schema).toEqual(canonical.responseFormat?.jsonSchema);
});
