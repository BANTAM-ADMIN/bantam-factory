import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function writeTextAtomic(filePath, text) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    throw new TypeError("atomic file path must be a non-empty string without NUL bytes");
  }

  const destination = path.resolve(filePath);
  if (destination === path.parse(destination).root) {
    throw new Error(`refusing to atomically replace filesystem root: ${destination}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const { mode, preserveMode } = destinationMetadata(destination);
  const { descriptor, temp } = createExclusiveTemp(destination, mode);
  let openDescriptor = descriptor;
  let operationError = null;
  let renamed = false;

  try {
    if (preserveMode) fs.fchmodSync(openDescriptor, mode);
    fs.writeFileSync(openDescriptor, String(text), "utf8");
    fs.fsyncSync(openDescriptor);
    fs.closeSync(openDescriptor);
    openDescriptor = null;
    fs.renameSync(temp, destination);
    renamed = true;
  } catch (error) {
    operationError = error;
  } finally {
    let cleanupError = null;
    if (openDescriptor !== null) {
      try {
        fs.closeSync(openDescriptor);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (!renamed) {
      try {
        fs.rmSync(temp, { force: true });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
  }
  return destination;
}

export function writeJsonAtomic(filePath, value) {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") {
    throw new TypeError("atomic JSON value must be serializable");
  }
  return writeTextAtomic(filePath, serialized + "\n");
}

function destinationMetadata(destination) {
  let stat;
  try {
    stat = fs.lstatSync(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return { mode: 0o666, preserveMode: false };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to atomically replace symlink: ${destination}`);
  }
  if (!stat.isFile()) {
    throw new Error(`atomic destination is not a regular file: ${destination}`);
  }
  return { mode: stat.mode & 0o777, preserveMode: true };
}

function createExclusiveTemp(destination, mode) {
  const directory = path.dirname(destination);
  const basename = path.basename(destination);
  for (let attempt = 0; attempt < 16; attempt++) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const temp = path.join(directory, `.${basename}.${process.pid}.${nonce}.tmp`);
    try {
      return { descriptor: fs.openSync(temp, "wx", mode), temp };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not create an exclusive temporary file for ${destination}`);
}
