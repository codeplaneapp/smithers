import { z } from "zod";

export const CIOutput = z.object({
  passed: z.boolean().describe("Whether CI passed"),
  testOutput: z.string().describe("Output from make test-go"),
  buildOutput: z.string().describe("Output from make build-go && make build-cli"),
  duration: z.number().describe("Total CI duration in seconds"),
});
export type CIOutput = z.infer<typeof CIOutput>;
