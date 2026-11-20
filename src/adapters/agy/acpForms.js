// ACP elicitation follows the MCP primitive-field JSON Schema contract.
export function supportedAgyForm(schema) {
  if (schema?.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return false;
  const fields = Object.values(schema.properties);
  return fields.length <= 64 && fields.every(field => {
    if (!field || typeof field !== 'object') return false;
    if (['string', 'number', 'integer', 'boolean'].includes(field.type)) return true;
    return field.type === 'array' && field.items?.type === 'string';
  });
}

export function validAgyFormValues(schema, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || JSON.stringify(values).length > 64000) return false;
  if ((schema.required || []).some(key => !Object.hasOwn(values, key))) return false;
  return Object.entries(values).every(([key, value]) => {
    const field = schema.properties[key];
    if (!field) return false;
    const choice = (f, v) => (!Array.isArray(f.enum) || f.enum.includes(v)) &&
      (!Array.isArray(f.oneOf) || f.oneOf.some(option => option.const === v));
    if (field.type === 'array') return Array.isArray(value) && value.every(item => typeof item === 'string' && choice(field.items, item)) &&
      (field.minItems == null || value.length >= field.minItems) && (field.maxItems == null || value.length <= field.maxItems) &&
      (!field.uniqueItems || new Set(value).size === value.length);
    if (field.type === 'boolean') return typeof value === 'boolean';
    if (field.type === 'string') return typeof value === 'string' && choice(field, value) &&
      (field.minLength == null || value.length >= field.minLength) && (field.maxLength == null || value.length <= field.maxLength);
    return typeof value === 'number' && Number.isFinite(value) && (field.type !== 'integer' || Number.isInteger(value)) &&
      (field.minimum == null || value >= field.minimum) && (field.maximum == null || value <= field.maximum) && choice(field, value);
  });
}
