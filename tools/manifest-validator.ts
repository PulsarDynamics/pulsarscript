import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const ALLOWED_MANIFEST_SCOPES = new Set([
  "fs.read",
  "fs.write",
  "fs.user",
  "kv",
  "events",
  "window",
  "ipc",
]);

export const HOSTAPI_CAPABILITIES = new Set([
  "fs.read",
  "fs.write",
  "kv",
  "events",
  "window",
  "ipc",
]);

export interface AppManifestHandler {
  name: string;
  mode: "rpc" | "service";
  description?: string;
}

export interface AppManifestFileType {
  extensions: string[];
  mimeTypes?: string[];
  role?: "viewer" | "editor";
  description?: string;
}

export interface AppManifestLike {
  $schema?: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  sdkVersion?: string;
  ui: {
    entry: string;
    window?: {
      width?: number;
      height?: number;
      minWidth?: number;
      minHeight?: number;
      resizable?: boolean;
    };
  };
  script?: {
    bundle: string;
    source?: string;
    handlers: AppManifestHandler[];
  };
  permissions: {
    scopes: string[];
  };
  capabilities?: string[];
  fileTypes?: AppManifestFileType[];
}

const APP_ID_RE = /^[a-z0-9]+([.-][a-z0-9]+)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REL_PATH_RE = /^(?!\/)(?!.*\.\.).+$/;
const EXT_RE = /^\.[a-z0-9]+$/;

const ROOT_KEYS = new Set([
  "$schema",
  "id",
  "name",
  "version",
  "description",
  "author",
  "icon",
  "sdkVersion",
  "ui",
  "script",
  "permissions",
  "fileTypes",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate an AppManifest.json object against contracts/app_manifest.schema.json. */
export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ["manifest root must be a JSON object"] };
  }

  for (const key of Object.keys(manifest)) {
    if (!ROOT_KEYS.has(key)) {
      errors.push(`unexpected property '${key}' at root`);
    }
  }

  if (typeof manifest.id !== "string" || !APP_ID_RE.test(manifest.id) || manifest.id.length < 3 || manifest.id.length > 128) {
    errors.push("id must be a reverse-DNS/dotted lowercase identifier (3..128 chars)");
  }
  if (typeof manifest.name !== "string" || manifest.name.length < 1 || manifest.name.length > 80) {
    errors.push("name must be a non-empty string (1..80 chars)");
  }
  if (typeof manifest.version !== "string" || !SEMVER_RE.test(manifest.version)) {
    errors.push("version must be a semantic version (MAJOR.MINOR.PATCH)");
  }
  if (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > 500)) {
    errors.push("description must be a string up to 500 chars");
  }
  if (manifest.author !== undefined && (typeof manifest.author !== "string" || manifest.author.length < 1 || manifest.author.length > 120)) {
    errors.push("author must be a non-empty string up to 120 chars");
  }
  if (manifest.icon !== undefined && (typeof manifest.icon !== "string" || manifest.icon.length < 1)) {
    errors.push("icon must be a non-empty string");
  }
  if (manifest.sdkVersion !== undefined && (typeof manifest.sdkVersion !== "string" || !SEMVER_RE.test(manifest.sdkVersion))) {
    errors.push("sdkVersion must be a semantic version");
  }

  if (!isPlainObject(manifest.ui)) {
    errors.push("ui must be an object");
  } else {
    for (const k of Object.keys(manifest.ui)) {
      if (k !== "entry" && k !== "window") {
        errors.push(`ui contains unexpected property '${k}'`);
      }
    }
    if (typeof manifest.ui.entry !== "string" || !REL_PATH_RE.test(manifest.ui.entry)) {
      errors.push("ui.entry must be a non-empty relative path without '..'");
    }
    if (manifest.ui.window !== undefined) {
      if (!isPlainObject(manifest.ui.window)) {
        errors.push("ui.window must be an object");
      } else {
        const winKeys = new Set(["width", "height", "minWidth", "minHeight", "resizable"]);
        for (const k of Object.keys(manifest.ui.window)) {
          if (!winKeys.has(k)) errors.push(`ui.window contains unexpected property '${k}'`);
        }
        const checkDim = (field: string, min: number) => {
          const val = (manifest.ui as Record<string, Record<string, unknown>>).window[field];
          if (val !== undefined && (typeof val !== "number" || !Number.isInteger(val) || val < min || val > 4096)) {
            errors.push(`ui.window.${field} must be an integer between ${min} and 4096`);
          }
        };
        checkDim("width", 160);
        checkDim("height", 120);
        checkDim("minWidth", 120);
        checkDim("minHeight", 100);
        if (manifest.ui.window.resizable !== undefined && typeof manifest.ui.window.resizable !== "boolean") {
          errors.push("ui.window.resizable must be a boolean");
        }
      }
    }
  }

  if (manifest.script !== undefined) {
    if (!isPlainObject(manifest.script)) {
      errors.push("script must be an object");
    } else {
      for (const k of Object.keys(manifest.script)) {
        if (k !== "bundle" && k !== "source" && k !== "handlers") {
          errors.push(`script contains unexpected property '${k}'`);
        }
      }
      if (typeof manifest.script.bundle !== "string" || !REL_PATH_RE.test(manifest.script.bundle)) {
        errors.push("script.bundle must be a non-empty relative path without '..'");
      }
      if (manifest.script.source !== undefined && (typeof manifest.script.source !== "string" || !REL_PATH_RE.test(manifest.script.source))) {
        errors.push("script.source must be a non-empty relative path without '..'");
      }
      if (!Array.isArray(manifest.script.handlers) || manifest.script.handlers.length === 0) {
        errors.push("script.handlers must be a non-empty array");
      } else {
        for (let i = 0; i < manifest.script.handlers.length; i++) {
          const h = manifest.script.handlers[i];
          if (!isPlainObject(h)) {
            errors.push(`script.handlers[${i}] must be an object`);
            continue;
          }
          for (const k of Object.keys(h)) {
            if (k !== "name" && k !== "mode" && k !== "description") {
              errors.push(`script.handlers[${i}] contains unexpected property '${k}'`);
            }
          }
          if (typeof h.name !== "string" || !IDENT_RE.test(h.name)) {
            errors.push(`script.handlers[${i}].name must be a valid identifier`);
          }
          if (h.mode !== "rpc" && h.mode !== "service") {
            errors.push(`script.handlers[${i}].mode must be 'rpc' or 'service'`);
          }
          if (h.description !== undefined && typeof h.description !== "string") {
            errors.push(`script.handlers[${i}].description must be a string`);
          }
        }
      }
    }
  }

  if (!isPlainObject(manifest.permissions)) {
    errors.push("permissions must be an object");
  } else {
    for (const k of Object.keys(manifest.permissions)) {
      if (k !== "scopes") errors.push(`permissions contains unexpected property '${k}'`);
    }
    if (!Array.isArray(manifest.permissions.scopes)) {
      errors.push("permissions.scopes must be an array");
    } else {
      const seen = new Set<string>();
      for (const s of manifest.permissions.scopes) {
        if (typeof s !== "string" || !ALLOWED_MANIFEST_SCOPES.has(s)) {
          errors.push(`unknown permission scope '${String(s)}'`);
          continue;
        }
        if (seen.has(s)) {
          errors.push(`duplicate permission scope '${s}'`);
        }
        seen.add(s);
      }
    }
  }

  if (manifest.fileTypes !== undefined) {
    if (!Array.isArray(manifest.fileTypes)) {
      errors.push("fileTypes must be an array");
    } else {
      for (let i = 0; i < manifest.fileTypes.length; i++) {
        const ft = manifest.fileTypes[i];
        if (!isPlainObject(ft)) {
          errors.push(`fileTypes[${i}] must be an object`);
          continue;
        }
        for (const k of Object.keys(ft)) {
          if (k !== "extensions" && k !== "mimeTypes" && k !== "role" && k !== "description") {
            errors.push(`fileTypes[${i}] contains unexpected property '${k}'`);
          }
        }
        if (!Array.isArray(ft.extensions) || ft.extensions.length === 0) {
          errors.push(`fileTypes[${i}].extensions must be a non-empty array`);
        } else {
          for (const ext of ft.extensions) {
            if (typeof ext !== "string" || !EXT_RE.test(ext)) {
              errors.push(`fileTypes[${i}] invalid extension '${String(ext)}'`);
            }
          }
        }
        if (ft.mimeTypes !== undefined && (!Array.isArray(ft.mimeTypes) || ft.mimeTypes.some((m) => typeof m !== "string" || m.length < 3))) {
          errors.push(`fileTypes[${i}].mimeTypes must be an array of MIME strings`);
        }
        if (ft.role !== undefined && ft.role !== "viewer" && ft.role !== "editor") {
          errors.push(`fileTypes[${i}].role must be 'viewer' or 'editor'`);
        }
        if (ft.description !== undefined && typeof ft.description !== "string") {
          errors.push(`fileTypes[${i}].description must be a string`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Search the source file's directory, parent, and grandparent (up to stopDir if given)
 * for an `AppManifest.json` file.
 */
export function findManifestForFile(
  filePath: string,
  stopDir?: string
): { path: string; manifest: AppManifestLike } | null {
  const absFile = resolve(filePath);
  const boundary = stopDir ? resolve(stopDir) : null;
  let dir = dirname(absFile);

  for (let depth = 0; depth < 3; depth++) {
    const candidate = join(dir, "AppManifest.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as AppManifestLike;
      return { path: candidate, manifest: parsed };
    }
    if (boundary && dir === boundary) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** Collect granted capability scopes from a manifest object. */
export function extractManifestScopes(manifest: Partial<AppManifestLike> | null | undefined): Set<string> {
  const scopes = new Set<string>();
  if (!manifest) return scopes;
  if (Array.isArray(manifest.permissions?.scopes)) {
    for (const s of manifest.permissions.scopes) {
      if (typeof s === "string") scopes.add(s);
    }
  }
  if (Array.isArray(manifest.capabilities)) {
    for (const c of manifest.capabilities) {
      if (typeof c === "string") scopes.add(c);
    }
  }
  return scopes;
}
