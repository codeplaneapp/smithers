import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers the full tweet thread", async () => {
  const result = await coverExample("../tweet-thread.jsx");
  const expected = Array.from({ length: 25 }, (_, index) =>
    index === 0 ? [`post-${index}`] : [`delay-${index}`, `post-${index}`],
  ).flat();

  expect(result.executed).toEqual(expected);
  expect(result.taskOutputs["post-0"][0]).toMatchObject({
    tweetId: expect.any(String), posted: expect.any(Boolean),
  });
  expect(result.taskOutputs["delay-24"][0]).toMatchObject({
    firedAtMs: expect.any(Number),
  });
});
