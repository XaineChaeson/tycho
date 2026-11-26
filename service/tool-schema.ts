// The shape of a tool the Router or the knowledge MCP is offered, and the one check its
// arguments go through. The schema shown is also the check, so the two cannot drift.
import type { Ctx } from './db.ts';

export interface Schema {
  type: 'object' | 'string' | 'integer' | 'array' | 'boolean';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: string[] | undefined;
  // The store behind this argument reads null as "not filled", the way the console sends
  // an empty field. The console and the tool write the same row, so they take the same
  // values; the schema would otherwise be narrower than what it writes through.
  nullable?: boolean;
}

export type Args = Record<string, any>;

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export const STRING: Schema = { type: 'string' };
export const described = (description: string): Schema => ({ type: 'string', description });
// A field the store clears when it is not filled: the console sends null for those, and a
// value copied out of list_machines is null too.
export const optional = (description: string): Schema => ({ ...described(description), nullable: true });

export function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function matches(value: unknown, type: Schema['type']): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
  }
}

// The schema shown to the Router is also the check, so the two cannot drift.
export function problem(schema: Schema, value: unknown, at: string): string | undefined {
  if (value === null && schema.nullable) return undefined;
  if (!matches(value, schema.type)) return `${at} 应为 ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value as string)) return `${at} 只能是 ${schema.enum.join('、')}`;
  if (schema.type === 'array') {
    for (const [index, item] of (value as unknown[]).entries()) {
      const found = problem(schema.items!, item, `${at}[${index}]`);
      if (found) return found;
    }
  }
  if (schema.type === 'object') {
    const fields = value as Args;
    for (const name of schema.required ?? []) if (fields[name] === undefined) return `缺少 ${at}.${name}`;
    for (const [name, item] of Object.entries(fields)) {
      const inner = schema.properties?.[name];
      if (!inner) return `未知参数 ${at}.${name}`;
      const found = problem(inner, item, `${at}.${name}`);
      if (found) return found;
    }
  }
  return undefined;
}

export function toJsonSchema(schema: Schema): Record<string, unknown> {
  const { nullable, description, properties, items, ...rest } = schema;
  const base: Record<string, unknown> = { ...rest };
  if (base.enum === undefined) delete base.enum;
  if (properties !== undefined) {
    base.properties = Object.fromEntries(
      Object.entries(properties).map(([key, prop]) => [key, toJsonSchema(prop)]),
    );
  }
  if (items !== undefined) {
    base.items = toJsonSchema(items);
  }
  if (nullable) {
    return {
      anyOf: [base, { type: 'null' }],
      ...(description !== undefined ? { description } : {}),
    };
  }
  if (description !== undefined) base.description = description;
  return base;
}

export function toJsonSchemaToolsList(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { tools?: unknown }).tools)) return result;
  const payload = result as { tools: unknown[] };
  return {
    ...payload,
    tools: payload.tools.map((tool) => (
      tool && typeof tool === 'object' && 'inputSchema' in tool && tool.inputSchema && typeof tool.inputSchema === 'object'
        ? { ...(tool as Record<string, unknown>), inputSchema: toJsonSchema(tool.inputSchema as Schema) }
        : tool
    )),
  };
}

export const json = (value: unknown): string => JSON.stringify(value, null, 2);
