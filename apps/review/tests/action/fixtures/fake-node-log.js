import { writeFileSync } from "node:fs";

writeFileSync(
  process.env.SMITHERS_FAKE_NODE_LOG,
  JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }),
  "utf8",
);
