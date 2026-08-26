import fs from "node:fs";
import path from "node:path";

import { BlobStore, LaneJournal } from "../journal.js";
import { FactoryTraveler, auditFactoryTraveler } from "./traveler.js";

const OUTER_TYPE = "factory.event";
const LANE_PREFIX = "factory.";

export class FactoryStore {
  constructor(root) {
    if (!root) throw new Error("factory store requires a root directory");
    this.root = path.resolve(root);
    this.blobs = new BlobStore(path.join(this.root, "blobs"));
  }

  create({ jobId, routeRef, initialProductRevision, time } = {}) {
    const journal = this.journal(jobId);
    if (journal.count() !== 0) throw new Error(`factory traveler already exists: ${jobId}`);
    const traveler = new FactoryTraveler({ jobId, routeRef, initialProductRevision, time });
    journal.append(OUTER_TYPE, { event: traveler.events[0] });
    return new DurableFactoryTraveler({ journal, traveler });
  }

  load(jobId) {
    const journal = this.journal(jobId);
    if (journal.count() === 0) throw new Error(`factory traveler does not exist: ${jobId}`);
    if (journal.pendingTailRepair?.kind === "truncated") {
      throw new Error(`factory journal has a truncated tail: ${jobId}`);
    }
    const events = journal.events.map((outer) => {
      if (outer.type !== OUTER_TYPE || !outer.payload?.event) {
        throw new Error(`factory journal contains an unsupported event at sequence ${outer.seq}`);
      }
      return outer.payload.event;
    });
    auditFactoryTraveler(events);
    return deepFreeze(JSON.parse(JSON.stringify(events)));
  }

  list() {
    const directory = path.join(this.root, "journal", "lanes");
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(LANE_PREFIX) && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.slice(LANE_PREFIX.length, -".jsonl".length))
      .sort();
  }

  putEvidence(value, options) {
    return this.blobs.putJson(jsonSafe(value), options);
  }

  getEvidence(reference) {
    return this.blobs.getJson(reference);
  }

  journal(jobId) {
    return new LaneJournal({ root: this.root, laneId: `${LANE_PREFIX}${requireJobId(jobId)}` });
  }
}

class DurableFactoryTraveler {
  constructor({ journal, traveler }) {
    this.journal = journal;
    this.traveler = traveler;
  }

  get events() {
    return this.traveler.events;
  }

  append(type, payload, options = {}) {
    const { durability, ...travelerOptions } = options;
    const event = this.traveler.append(type, payload, travelerOptions);
    this.journal.append(OUTER_TYPE, { event }, durability === undefined ? {} : { durability });
    return event;
  }
}

function requireJobId(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`invalid factory job id: ${text}`);
  return text;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return { unavailable: true, type: typeof value }; }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
