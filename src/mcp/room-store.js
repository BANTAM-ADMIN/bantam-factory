// The room's durable log: one JSON record per line, strictly increasing seq.
// A record is on disk (appended and fsynced) before any listener hears of it,
// so a restart never forgets a message someone was told about.
//
// A crash can leave a torn final line; that line alone is cut off on open.
// Damage anywhere else is corruption, and the store refuses to guess.
import fs from "node:fs";
import path from "node:path";

export class RoomStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.recovered = false;
    this.listeners = new Set();
    this.rows = [];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, "", { mode: 0o600 });
    this.replay();
  }

  replay() {
    const text = fs.readFileSync(this.file, "utf8");
    const lines = text.split("\n");
    const complete = text.endsWith("\n") || text === "";
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const last = i === lines.length - 1;
      if (last && line === "") break;
      let record = null;
      try { record = JSON.parse(line); } catch { /* handled below */ }
      if (!record || typeof record !== "object" || !Number.isInteger(record.seq)) {
        if (last && !complete) {
          fs.truncateSync(this.file, offset);
          this.recovered = true;
          break;
        }
        throw new Error(`room log line ${i + 1} is corrupt: ${this.file}`);
      }
      if (record.seq !== this.rows.length + 1) throw new Error(`room log sequence broken at line ${i + 1} (seq ${record.seq}): ${this.file}`);
      this.rows.push(record);
      offset += Buffer.byteLength(line) + 1;
    }
  }

  get lastSeq() { return this.rows.length; }

  records() { return this.rows; }

  append(fields) {
    if (!fields || typeof fields.type !== "string") throw new Error("room record needs a type");
    const record = { ...fields, seq: this.rows.length + 1, at: new Date().toISOString() };
    const fd = fs.openSync(this.file, "a", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.rows.push(record);
    for (const listener of [...this.listeners]) {
      try { listener(record); } catch { /* a listener's failure is its own */ }
    }
    return record;
  }

  onAppend(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
