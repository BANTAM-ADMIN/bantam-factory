// Luna Reserve: automatic fallback to the gpt-reserve routing slug when the primary Codex
// model hits its usage limit. Mirrors the OpenAI Codex behavior where Luna
// Reserve is offered when Terra/Sol are exhausted.

import { parseQuotaNotice } from "./quota-notice.js";

const LUNA_MODEL = "gpt-reserve";
const LUNA_EFFORT = "medium";

export function isLunaReserveModel(modelId) {
  return modelId === LUNA_MODEL;
}

export function lunaReserveModel() {
  return { model: LUNA_MODEL, effort: LUNA_EFFORT, name: "codex-luna" };
}

export function shouldOfferLunaReserve(modelFailure) {
  if (!modelFailure) return false;
  const msg = String(modelFailure.message ?? "");
  const notice = parseQuotaNotice(msg);
  return Boolean(notice);
}

export function formatLunaReserveNotice(currentModel) {
  const lines = [
    "",
    "⚠ AUTOMATIC MODEL SWITCH — Luna Reserve",
    `   Your primary model (${currentModel}) has hit its usage limit.`,
    "   Switching to Luna Reserve (gpt-reserve) — fast, affordable reserve routing.",
    "   Luna Reserve is a separate quota pool from Terra/Sol.",
  ];
  return lines.join("\n");
}

export function formatLunaReserveBanner() {
  return "Luna Reserve medium";
}
