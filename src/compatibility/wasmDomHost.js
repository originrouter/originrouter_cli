const decoder = new TextDecoder("utf-8", { fatal: true });

export const JSON_KIND = Object.freeze({
  missing: 0,
  null: 1,
  boolean: 2,
  number: 3,
  string: 4,
  array: 5,
  object: 6,
});

const MAX_HANDLES = 100_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ARRAY_ITEMS = 100_000;
const MAX_MEMORY_PAGES = 256;

function kind(value) {
  if (value === undefined) return JSON_KIND.missing;
  if (value === null) return JSON_KIND.null;
  if (typeof value === "boolean") return JSON_KIND.boolean;
  if (typeof value === "number") return JSON_KIND.number;
  if (typeof value === "string") return JSON_KIND.string;
  if (Array.isArray(value)) return JSON_KIND.array;
  if (value && typeof value === "object") return JSON_KIND.object;
  return JSON_KIND.missing;
}

class HandleTable {
  constructor(document, context, state) {
    this.values = [undefined];
    this.document = this.add(structuredClone(document));
    this.context = this.add(structuredClone(context));
    this.state = this.add(structuredClone(state));
  }

  add(value) {
    if (this.values.length >= MAX_HANDLES) throw new Error("WASM patch exceeded its JSON handle limit");
    this.values.push(value);
    return this.values.length - 1;
  }

  get(handle) {
    if (!Number.isInteger(handle) || handle <= 0 || handle >= this.values.length) {
      throw new Error(`WASM patch used invalid JSON handle ${handle}`);
    }
    return this.values[handle];
  }
}

function safeSet(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function validateModuleShape(module) {
  const allowed = new Set([
    "env:memory:memory",
    "env:abort:function",
    "originrouter_json_v1:kind:function",
    "originrouter_json_v1:clone:function",
    "originrouter_json_v1:object_get:function",
    "originrouter_json_v1:object_set:function",
    "originrouter_json_v1:object_delete:function",
    "originrouter_json_v1:object_length:function",
    "originrouter_json_v1:object_key_at:function",
    "originrouter_json_v1:array_length:function",
    "originrouter_json_v1:array_get:function",
    "originrouter_json_v1:array_set:function",
    "originrouter_json_v1:array_push:function",
    "originrouter_json_v1:create_null:function",
    "originrouter_json_v1:create_boolean:function",
    "originrouter_json_v1:create_number:function",
    "originrouter_json_v1:create_object:function",
    "originrouter_json_v1:create_array:function",
    "originrouter_json_v1:create_string_utf8:function",
    "originrouter_json_v1:boolean_value:function",
    "originrouter_json_v1:number_value:function",
    "originrouter_json_v1:string_equals_utf8:function",
    "originrouter_json_v1:string_equals:function",
    "originrouter_json_v1:string_length_utf8:function",
    "originrouter_json_v1:string_read_utf8:function",
  ]);
  const imports = WebAssembly.Module.imports(module);
  for (const entry of imports) {
    const key = `${entry.module}:${entry.name}:${entry.kind}`;
    if (!allowed.has(key)) throw new Error(`WASM patch imports forbidden capability '${key}'`);
  }
  if (!imports.some((entry) => entry.module === "env" && entry.name === "memory" && entry.kind === "memory")) {
    throw new Error("WASM patch must import host-limited env.memory");
  }
  const exports = WebAssembly.Module.exports(module);
  const apply = exports.find((entry) => entry.name === "originrouter_patch_apply");
  if (!apply || apply.kind !== "function") {
    throw new Error("WASM patch must export originrouter_patch_apply");
  }
  if (exports.some((entry) => entry.kind === "memory")) {
    throw new Error("WASM patch must not export or own unrestricted memory");
  }
}

export function validateCompatibilityWasmBytes(bytes) {
  const module = new WebAssembly.Module(bytes);
  validateModuleShape(module);
  return module;
}

export async function compileCompatibilityWasm(bytes) {
  return validateCompatibilityWasmBytes(bytes);
}

export function executeCompatibilityWasm(module, document, context, state = {}) {
  validateModuleShape(module);
  const table = new HandleTable(document, context, state);
  const memory = new WebAssembly.Memory({ initial: 2, maximum: MAX_MEMORY_PAGES });

  const readText = (pointer, length) => {
    if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 || length < 0
        || length > MAX_TEXT_BYTES || pointer + length > memory.buffer.byteLength) {
      throw new Error("WASM patch supplied an invalid UTF-8 memory range");
    }
    return decoder.decode(new Uint8Array(memory.buffer, pointer, length));
  };

  const requireObject = (handle) => {
    const value = table.get(handle);
    if (kind(value) !== JSON_KIND.object) throw new Error("WASM patch expected a JSON object");
    return value;
  };

  const requireArray = (handle) => {
    const value = table.get(handle);
    if (!Array.isArray(value)) throw new Error("WASM patch expected a JSON array");
    return value;
  };

  const imports = {
    env: {
      memory,
      abort() {
        throw new Error("WASM patch aborted");
      },
    },
    originrouter_json_v1: {
      kind(handle) {
        return handle === 0 ? JSON_KIND.missing : kind(table.get(handle));
      },
      clone(handle) {
        return table.add(structuredClone(table.get(handle)));
      },
      object_get(handle, pointer, length) {
        const object = requireObject(handle);
        const key = readText(pointer, length);
        return Object.prototype.hasOwnProperty.call(object, key) ? table.add(object[key]) : 0;
      },
      object_set(handle, pointer, length, valueHandle) {
        const object = requireObject(handle);
        const key = readText(pointer, length);
        safeSet(object, key, table.get(valueHandle));
        return 1;
      },
      object_delete(handle, pointer, length) {
        const object = requireObject(handle);
        const key = readText(pointer, length);
        return delete object[key] ? 1 : 0;
      },
      object_length(handle) {
        return Object.keys(requireObject(handle)).length;
      },
      object_key_at(handle, index) {
        const keys = Object.keys(requireObject(handle));
        return Number.isInteger(index) && index >= 0 && index < keys.length ? table.add(keys[index]) : 0;
      },
      array_length(handle) {
        return requireArray(handle).length;
      },
      array_get(handle, index) {
        const array = requireArray(handle);
        return Number.isInteger(index) && index >= 0 && index < array.length ? table.add(array[index]) : 0;
      },
      array_set(handle, index, valueHandle) {
        const array = requireArray(handle);
        if (!Number.isInteger(index) || index < 0 || index >= array.length) return 0;
        array[index] = table.get(valueHandle);
        return 1;
      },
      array_push(handle, valueHandle) {
        const array = requireArray(handle);
        if (array.length >= MAX_ARRAY_ITEMS) throw new Error("WASM patch exceeded its JSON array limit");
        array.push(table.get(valueHandle));
        return array.length;
      },
      create_object() {
        return table.add({});
      },
      create_null() {
        return table.add(null);
      },
      create_boolean(value) {
        return table.add(value !== 0);
      },
      create_number(value) {
        if (!Number.isFinite(value)) throw new Error("WASM patch cannot create a non-finite JSON number");
        return table.add(value);
      },
      create_array() {
        return table.add([]);
      },
      create_string_utf8(pointer, length) {
        return table.add(readText(pointer, length));
      },
      boolean_value(handle) {
        const value = table.get(handle);
        if (typeof value !== "boolean") throw new Error("WASM patch expected a JSON boolean");
        return value ? 1 : 0;
      },
      number_value(handle) {
        const value = table.get(handle);
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error("WASM patch expected a finite JSON number");
        }
        return value;
      },
      string_equals_utf8(handle, pointer, length) {
        const value = table.get(handle);
        return typeof value === "string" && value === readText(pointer, length) ? 1 : 0;
      },
      string_equals(leftHandle, rightHandle) {
        const left = table.get(leftHandle);
        const right = table.get(rightHandle);
        return typeof left === "string" && typeof right === "string" && left === right ? 1 : 0;
      },
      string_length_utf8(handle) {
        const value = table.get(handle);
        return typeof value === "string" ? Buffer.byteLength(value, "utf8") : -1;
      },
      string_read_utf8(handle, pointer, capacity) {
        const value = table.get(handle);
        if (typeof value !== "string") throw new Error("WASM patch expected a JSON string");
        const bytes = Buffer.from(value, "utf8");
        if (!Number.isInteger(pointer) || !Number.isInteger(capacity) || pointer < 0 || capacity < bytes.length
            || capacity > MAX_TEXT_BYTES || pointer + capacity > memory.buffer.byteLength) {
          throw new Error("WASM patch supplied an invalid string output memory range");
        }
        new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
        return bytes.length;
      },
    },
  };

  const instance = new WebAssembly.Instance(module, imports);
  const packed = instance.exports.originrouter_patch_apply(table.document, table.context, table.state);
  if (typeof packed !== "bigint") throw new Error("WASM patch returned an invalid result type");
  const changed = Number((packed >> 32n) & 1n) === 1;
  const handle = Number(packed & 0xffffffffn);
  const output = table.get(handle);
  return { document: output, state: table.get(table.state), changed };
}
