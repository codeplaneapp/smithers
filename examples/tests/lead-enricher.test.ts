import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const prompt of ["enrich", "profile"]) {
  mock.module(`../prompts/lead-enricher/${prompt}.mdx`, () => ({
    default: () => prompt,
  }));
}

test("covers lead-enricher", async () => {
  const result = await coverExample("../lead-enricher.jsx", {
    input: { lead: { company: "Acme" }, source: "inbound-form" },
    mocks: {
      intake: {
        leadId: "lead-1",
        company: "Acme",
        contactName: "Ada",
        contactEmail: "ada@example.com",
        source: "inbound-form",
        rawNotes: "Interested",
        summary: "Acme lead",
      },
      "crm-output": {
        leadId: "lead-1",
        company: "Acme",
        segment: "smb",
        icpFit: 0.8,
        owner: "sales",
        nextAction: "follow up",
        status: "enriched",
        profileSummary: "fit",
        summary: "ready",
      },
    },
  });

  expect(result.executed).toEqual(["intake", "enrich", "profiler", "crm-output"]);
  expect(result.taskOutputs["crm-output"][0]).toMatchObject({
    leadId: expect.any(String),
    segment: expect.any(String),
    icpFit: expect.any(Number),
  });
});
