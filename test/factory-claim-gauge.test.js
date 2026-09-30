import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { claimCheckNote, findClaim, unsourcedDetails } from "../src/factory.js";

const evidence = [{ title: "The Ten-Year Lunch", text: "The Ten-Year Lunch is a 1987 documentary about the Algonquin Round Table." }];

describe("factory claim-check gauge", () => {
  it("lists claim details the evidence never mentions", () => {
    assert.deepEqual(unsourcedDetails("The Ten-Year Lunch was released in 1999 about the Algonquin Round Table.", "The Ten-Year Lunch is a 1987 documentary about the Algonquin Round Table."), ["1999"]);
    assert.deepEqual(unsourcedDetails("Algonquin's table met in 1987.", "The Algonquin Round Table, 1987."), [], "possessives and sourced details pass");
  });

  it("builds a note only for claim-and-evidence material with an unsourced detail", () => {
    assert.match(claimCheckNote({ claim: "The Ten-Year Lunch was released in 1999.", evidence }), /appear nowhere in the evidence: 1999/);
    assert.equal(claimCheckNote({ claim: "The Ten-Year Lunch is from 1987.", evidence }), null);
    assert.equal(findClaim({ text: "no claim here" }), null);
  });
});
