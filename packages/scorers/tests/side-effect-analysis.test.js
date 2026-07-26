import { describe, expect, test } from "bun:test";
import { gradeSideEffectCompliance } from "../src/gradeSideEffectCompliance.js";
import { sideEffectAnalysis } from "../src/sideEffectAnalysis.js";
import { sideEffectRules } from "../src/sideEffectRules.js";

function tool(execute, options = "") {
  return `const candidate = defineTool({
  name: "candidate",
  ${options}
  async execute(args, ctx) {
    ${execute}
  },
});`;
}

function kinds(source, expectation) {
  return gradeSideEffectCompliance(source, expectation).violations.map((violation) => violation.kind);
}

function details(source) {
  return sideEffectAnalysis(source).effectfulSites.map((site) => site.detail);
}

describe("network mutation rules", () => {
  for (const method of sideEffectRules.networkMutationMethods) {
    test(`detects fetch ${method}`, () => {
      expect(details(`fetch("/api", { method: "${method}" })`)).toEqual([`fetch ${method}`]);
    });
  }

  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    test(`exempts fetch ${method}`, () => {
      expect(details(`fetch("/api", { method: "${method}" })`)).toEqual([]);
    });
  }

  test("exempts fetch with its default GET method", () => {
    expect(details(`fetch("/api")`)).toEqual([]);
  });

  test("detects axios and ky mutation helpers but not reads", () => {
    expect(
      details(`axios.post("/x"); axios.put("/x"); axios.patch("/x"); axios.delete("/x"); ky.post("/x")`),
    ).toHaveLength(5);
    expect(details(`axios.get("/x"); ky.get("/x"); axios({ method: "GET", url: "/x" })`)).toEqual([]);
    expect(details(`axios({ method: "POST", url: "/x" })`)).toHaveLength(1);
  });
});

describe("GitHub, git, and jj command boundary", () => {
  for (const path of sideEffectRules.shell.ghMutations) {
    const command = path.join(" ");
    test(`detects gh ${command}`, () => {
      expect(details(`exec("gh ${command} target")`)).toEqual([`gh ${command}`]);
    });
  }

  for (const verb of sideEffectRules.shell.ghReadVerbs) {
    test(`exempts gh pr ${verb}`, () => {
      expect(details(`exec("gh pr ${verb} 42")`)).toEqual([]);
    });
  }

  test("distinguishes gh API reads from mutation methods", () => {
    expect(details(`exec("gh api repos/o/r/issues"); exec("gh api -X GET repos/o/r")`)).toEqual([]);
    expect(
      details(`exec("gh api -X POST repos/o/r/issues"); exec("gh api --method=DELETE repos/o/r/issues/1")`),
    ).toHaveLength(2);
  });

  test("detects nested gh mutation paths without classifying adjacent reads", () => {
    expect(
      details(`
          exec("gh repo autolink create --key-prefix TICKET- --url-template https://example.test/<num>");
          exec("gh repo autolink list");
          exec("gh codespace ports visibility 3000:public");
          exec("gh project item-list 1");
        `),
    ).toEqual(["gh repo autolink create", "gh codespace ports visibility"]);
  });

  test("fully exempts git and jj, including push and destructive ref operations", () => {
    expect(
      details(`
          exec("git commit -am x && git push --force-with-lease");
          exec("git branch -D old; git reset --hard HEAD~1");
          exec("jj new && jj bookmark set main");
        `),
    ).toEqual([]);
  });

  test("does not let a git segment hide a GitHub API mutation", () => {
    expect(details(`exec("git push origin topic && gh pr merge 42")`)).toEqual(["gh pr merge"]);
  });
});

describe("known CLI mutation rules", () => {
  const mutations = [
    ["wrangler deploy", "wrangler deploy"],
    ["wrangler publish", "wrangler publish"],
    ["kubectl apply -f app.yaml", "kubectl apply"],
    ["kubectl delete deployment api", "kubectl delete"],
    ["kubectl scale deployment api --replicas=3", "kubectl scale"],
    ["terraform apply -auto-approve", "terraform apply"],
    ["npm publish", "npm publish"],
    ["docker push example/app:latest", "docker push"],
    ["fly deploy", "fly deploy"],
    ["flyctl deploy", "flyctl deploy"],
    ["aws s3 put-object --bucket x --key y", "aws s3 put-object"],
    ["gcloud functions deploy notify", "gcloud deploy"],
    ["curl -X POST https://example.test/hook", "curl POST"],
  ];
  for (const [command, expected] of mutations) {
    test(`detects ${command}`, () => {
      expect(details(`exec(${JSON.stringify(command)})`)).toEqual([expected]);
    });
  }

  test("exempts documented dry-run and plan commands", () => {
    expect(
      details(`
          exec("wrangler deploy --dry-run");
          exec("kubectl apply -f app.yaml --dry-run=client");
          exec("kubectl delete pod api --dry-run=server");
          exec("helm upgrade api chart --dry-run");
          exec("npm publish --dry-run");
          exec("terraform plan -out=tfplan");
          exec("kubectl get pods");
          exec("npm view package");
          exec("docker pull image");
          exec("curl -X GET https://example.test/data");
        `),
    ).toEqual([]);
  });

  test("detects spawn argument arrays", () => {
    expect(details(`spawn("kubectl", ["apply", "-f", "app.yaml"])`)).toEqual(["kubectl apply"]);
  });

  test("detects template-literal command construction", () => {
    expect(details('const target = "api"; exec(`wrangler deploy ${target}`)')).toEqual(["wrangler deploy"]);
  });

  test("detects string-concatenated command construction", () => {
    expect(details(`const verb = "merge"; const command = "gh pr " + verb + " 42"; exec(command)`)).toEqual([
      "gh pr merge",
    ]);
  });

  test("exempts template and concat reads", () => {
    expect(details('const id = "42"; exec(`gh pr view ${id}`); exec("terraform " + "plan")')).toEqual([]);
  });
});

describe("SDK, database, and storage rules", () => {
  const mutations = [
    "slack.chat.postMessage({ channel: 'c' })",
    "slack.chat.delete({ channel: 'c' })",
    "transport.sendMail({ to: 'a@example.test' })",
    "twilio.messages.create({ to: '+1' })",
    "telegram.sendMessage('chat', 'hi')",
    "discord.createMessage('channel', 'hi')",
    "twitter.v2.tweet('hello')",
    "stripe.charges.create({ amount: 1 })",
    "stripe.refunds.create({ charge: 'ch_1' })",
    "s3.putObject({ Bucket: 'b' })",
    "hooks.registerWebhook('https://example.test')",
    "cron.scheduleJob('* * * * *', work)",
    "pagerduty.triggerIncident({ summary: 'down' })",
    "Sentry.captureException(error)",
    "db.insert({ id: 1 })",
    "prisma.user.update({ where: { id: 1 } })",
    "supabase.table.delete().eq('id', 1)",
  ];
  for (const expression of mutations) {
    test(`detects ${expression.split("(")[0]}`, () => {
      expect(details(expression)).toHaveLength(1);
    });
  }

  test("does not flag nearby read-only SDK methods", () => {
    expect(
      details(`
          slack.conversations.list();
          transport.verify();
          twilio.messages.list();
          telegram.getUpdates();
          stripe.charges.retrieve("ch_1");
          s3.getObject({ Bucket: "b" });
          db.select().from(users);
          prisma.user.findMany();
          Sentry.flush();
        `),
    ).toEqual([]);
  });
});

describe("filesystem boundary", () => {
  test("detects absolute writes outside the repository", () => {
    expect(
      details(`
          writeFileSync("/tmp/report.json", "{}");
          fs.promises.appendFile("/var/log/report.log", "x");
          Bun.write("/outside.txt", "x");
        `),
    ).toHaveLength(3);
  });

  test("exempts relative and absolute in-repo writes", () => {
    expect(
      sideEffectAnalysis(
        `
          writeFileSync("generated/report.json", "{}");
          fs.promises.writeFile("/workspace/project/generated.ts", "x");
        `,
        { repoRoot: "/workspace/project" },
      ).effectfulSites,
    ).toEqual([]);
  });

  test("checks destination paths and lexically resolves parent segments", () => {
    expect(
      sideEffectAnalysis(
        `
          renameSync("/repo/source.txt", "/tmp/destination.txt");
          copyFile("/repo/source.txt", "/repo/../outside.txt", done);
        `,
        { repoRoot: "/repo" },
      ).effectfulSites.map((site) => site.detail),
    ).toEqual(["renameSync /tmp/destination.txt", "copyFile /repo/../outside.txt"]);
  });
});

describe("marking compliance", () => {
  test("reports unmarked effects and accepts sideEffect:true tools", () => {
    expect(kinds(tool(`await slack.chat.postMessage(args);`))).toContain("unmarked-effect");
    expect(gradeSideEffectCompliance(tool(`await slack.chat.postMessage(args);`, "sideEffect: true,")).passed).toBe(
      true,
    );
  });

  test("accepts coarse sideEffect task marking for direct compute effects", () => {
    const marked = `<Task id="announce" sideEffect>{async () => slack.chat.postMessage({ text: "done" })}</Task>`;
    const unmarked = `<Task id="announce">{async () => slack.chat.postMessage({ text: "done" })}</Task>`;
    expect(gradeSideEffectCompliance(marked).passed).toBe(true);
    expect(kinds(unmarked)).toContain("unmarked-effect");
  });

  test("follows computeFn identifiers for task marking", () => {
    const source = `
          async function announce() { await telegram.sendMessage("c", "done"); }
          export default <Task id="announce" sideEffect computeFn={announce} />;
        `;
    expect(gradeSideEffectCompliance(source).passed).toBe(true);
  });

  test("follows helper calls from marked tools and compute tasks", () => {
    const toolSource = `
          async function send(args) { return slack.chat.postMessage(args); }
          defineTool({ name: "announce", sideEffect: true, execute: send });
        `;
    const taskSource = `
          const writeReport = () => writeFileSync("/tmp/report.json", "{}");
          const save = () => writeReport();
          <Task id="save" sideEffect computeFn={save} />;
        `;
    expect(gradeSideEffectCompliance(toolSource).passed).toBe(true);
    expect(gradeSideEffectCompliance(taskSource).passed).toBe(true);
  });

  test("reports over-marked pure tools and tasks", () => {
    expect(kinds(tool(`return await fetch("/dashboard");`, "sideEffect: true,"))).toContain("over-marked-pure");
    expect(kinds(`<Task id="analyze" sideEffect>{() => rows.map(score)}</Task>`)).toContain("over-marked-pure");
  });

  test("requires idempotency-key threading only when requested", () => {
    const missing = tool(`await slack.chat.postMessage(args);`, "sideEffect: true, idempotent: false,");
    const present = tool(
      `await slack.chat.postMessage({ ...args, key: ctx.idempotencyKey });`,
      "sideEffect: true, idempotent: false,",
    );
    expect(kinds(missing)).not.toContain("missing-idempotency-key");
    expect(kinds(missing, { requireIdempotencyKey: true })).toContain("missing-idempotency-key");
    expect(gradeSideEffectCompliance(present, { requireIdempotencyKey: true }).passed).toBe(true);
  });

  test("does not accept an idempotency key mentioned outside the external call arguments", () => {
    const source = tool(
      `
          console.log(ctx.idempotencyKey);
          await slack.chat.postMessage(args);
        `,
      "sideEffect: true, idempotent: false,",
    );
    expect(kinds(source, { requireIdempotencyKey: true })).toContain("missing-idempotency-key");
  });

  test("requires idempotency-key threading from every effectful marked owner", () => {
    const source = `
          defineTool({
            name: "keyed",
            sideEffect: true,
            execute: (args, ctx) => slack.chat.postMessage({
              ...args,
              key: ctx.idempotencyKey,
            }),
          });
          defineTool({
            name: "unkeyed",
            sideEffect: true,
            execute: (args) => stripe.charges.create(args),
          });
        `;
    const report = gradeSideEffectCompliance(source, {
      requireIdempotencyKey: true,
    });
    expect(report.passed).toBe(false);
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        kind: "missing-idempotency-key",
        detail: expect.stringContaining('tool "unkeyed"'),
      }),
    );
    expect(
      report.violations.some(
        (violation) => violation.kind === "missing-idempotency-key" && violation.detail.includes('"keyed"'),
      ),
    ).toBe(false);
  });

  test("reports revert without sideEffect:true", () => {
    const source = tool(`return fetch("/dashboard");`, `revert: async () => {},`);
    expect(kinds(source)).toContain("revert-without-side-effect");
  });

  test("requires a revert on a sideEffect:true tool when requested", () => {
    const source = tool(
      `await slack.chat.postMessage({ ...args, key: ctx.idempotencyKey });`,
      "sideEffect: true, idempotent: false,",
    );
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test("requires a safe revert from every effectful marked owner", () => {
    const source = `
          defineTool({
            name: "safe-slack",
            sideEffect: true,
            execute: (args) => slack.chat.postMessage(args),
            revert: async (_args, ctx) => {
              const message = await findMessageByKey(ctx.idempotencyKey);
              if (message) await slack.chat.delete({ ts: message.ts });
            },
          });
          defineTool({
            name: "unrevertible-stripe",
            sideEffect: true,
            execute: (args) => stripe.charges.create(args),
          });
        `;
    const report = gradeSideEffectCompliance(source, { requireRevert: true });
    expect(report.passed).toBe(false);
    expect(report.violations).toContainEqual(
      expect.objectContaining({
        kind: "missing-revert",
        detail: expect.stringContaining('tool "unrevertible-stripe"'),
      }),
    );
    expect(
      report.violations.some(
        (violation) => violation.kind === "missing-revert" && violation.detail.includes('"safe-slack"'),
      ),
    ).toBe(false);
  });

  test("accepts effectStatus-based verify-then-undo revert handlers", () => {
    const source = `const candidate = defineTool({
          name: "slack",
          sideEffect: true,
          idempotent: false,
          async execute(args, ctx) {
            return slack.chat.postMessage({ ...args, key: ctx.idempotencyKey });
          },
          async revert(args, ctx) {
            if (ctx.effectStatus === "succeeded") {
              await slack.chat.delete({ channel: args.channel, ts: ctx.output.ts });
              return;
            }
            const message = await findMessageByKey(ctx.idempotencyKey);
            if (message) await slack.chat.delete({ channel: args.channel, ts: message.ts });
          },
        });`;
    expect(gradeSideEffectCompliance(source, { requireIdempotencyKey: true, requireRevert: true }).passed).toBe(true);
  });

  test("accepts find-then-undo and rejects blind undo", () => {
    const safe = `const candidate = defineTool({
          name: "slack", sideEffect: true,
          async execute(args) { return slack.chat.postMessage(args); },
          async revert(args, ctx) {
            const message = await findMessageByKey(ctx.idempotencyKey);
            if (message) await slack.chat.delete({ channel: args.channel, ts: message.ts });
          },
        });`;
    const blind = safe.replace(
      `const message = await findMessageByKey(ctx.idempotencyKey);\n            if (message) await slack.chat.delete({ channel: args.channel, ts: message.ts });`,
      `await slack.chat.delete({ channel: args.channel, ts: ctx.output.ts });`,
    );
    expect(gradeSideEffectCompliance(safe, { requireRevert: true }).passed).toBe(true);
    expect(kinds(blind, { requireRevert: true })).toContain("missing-revert");
  });

  test("rejects unknown-only, succeeded-only, and inverted revert guards", () => {
    const wrapper = (revert) => `defineTool({
          name: "slack",
          sideEffect: true,
          execute: (args) => slack.chat.postMessage(args),
          revert: async (args, ctx) => { ${revert} },
        })`;
    const unknownOnly = wrapper(`
          if (ctx.effectStatus === "unknown") {
            const message = await findMessageByKey(ctx.idempotencyKey);
            if (message) await slack.chat.delete({ ts: message.ts });
          }
        `);
    const succeededOnly = wrapper(`
          if (ctx.effectStatus === "succeeded") {
            await slack.chat.delete({ ts: ctx.output.ts });
          }
        `);
    const inverted = wrapper(`
          const message = await findMessageByKey(ctx.idempotencyKey);
          if (!message) await slack.chat.delete({ ts: ctx.output.ts });
        `);
    expect(kinds(unknownOnly, { requireRevert: true })).toContain("missing-revert");
    expect(kinds(succeededOnly, { requireRevert: true })).toContain("missing-revert");
    expect(kinds(inverted, { requireRevert: true })).toContain("missing-revert");
  });

  test("accepts negative-return existence guards and both status branches", () => {
    const source = `defineTool({
          name: "slack",
          sideEffect: true,
          execute: (args) => slack.chat.postMessage(args),
          revert: async (args, ctx) => {
            if (ctx.effectStatus === "succeeded") {
              await slack.chat.delete({ ts: ctx.output.ts });
              return;
            }
            const message = await findMessageByKey(ctx.idempotencyKey);
            if (!message) return;
            await slack.chat.delete({ ts: message.ts });
          },
        })`;
    expect(gradeSideEffectCompliance(source, { requireRevert: true }).passed).toBe(true);
  });

  test("rejects a status-reading handler that never undoes the effect", () => {
    const source = `defineTool({
          name: "slack", sideEffect: true,
          execute: () => slack.chat.postMessage({ text: "x" }),
          revert: async (_args, ctx) => { if (ctx.effectStatus === "unknown") await inspect(); },
        })`;
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test("rejects handlers that create the effect again in both required branches", () => {
    const source = `defineTool({
          name: "slack", sideEffect: true,
          execute: (args) => slack.chat.postMessage(args),
          revert: async (_args, ctx) => {
            if (ctx.effectStatus === "succeeded") {
              await slack.chat.postMessage({ text: "posted again" });
              return;
            }
            const message = await findMessageByKey(ctx.idempotencyKey);
            if (message) await slack.chat.postMessage({ text: "posted again" });
          },
        })`;
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test("accepts a verified Stripe refund as the reversal of a charge", () => {
    const source = `defineTool({
          name: "charge", sideEffect: true,
          execute: (args) => stripe.charges.create(args),
          revert: async (_args, ctx) => {
            const charge = await findChargeByKey(ctx.idempotencyKey);
            if (charge) await stripe.refunds.create({ charge: charge.id });
          },
        })`;
    expect(gradeSideEffectCompliance(source, { requireRevert: true }).passed).toBe(true);
  });

  test.each([
    ["HTTP DELETE", `fetch("/hooks", { method: "POST" })`, `fetch("/hooks", { method: "DELETE" })`],
    ["GitHub issue reopen", `exec("gh issue close 42")`, `exec("gh issue reopen 42")`],
    [
      "kubectl delete of the applied manifest",
      `exec("kubectl apply -f app.yaml")`,
      `exec("kubectl delete -f app.yaml")`,
    ],
    ["npm unpublish", `exec("npm publish")`, `exec("npm unpublish package@1.0.0")`],
    ["S3 deleteObject", `s3.putObject({ Bucket: "b", Key: "k" })`, `s3.deleteObject({ Bucket: "b", Key: "k" })`],
  ])("accepts class-specific reversal: %s", (_label, execute, reverse) => {
    const source = `defineTool({
          name: "effect", sideEffect: true,
          execute: async () => { await ${execute}; },
          revert: async (_args, ctx) => {
            const resource = await findResourceByKey(ctx.idempotencyKey);
            if (resource) await ${reverse};
          },
        })`;
    expect(gradeSideEffectCompliance(source, { requireRevert: true }).passed).toBe(true);
  });

  test("requires an HTTP DELETE to target the mutation resource family", () => {
    const source = `defineTool({
          name: "hook", sideEffect: true,
          execute: () => fetch("/hooks?active=true", { method: "POST" }),
          revert: async (_args, ctx) => {
            const hook = await findHookByKey(ctx.idempotencyKey);
            if (hook) await fetch("/users", { method: "DELETE" });
          },
        })`;
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test("accepts an HTTP DELETE of an id under the mutation resource family", () => {
    const source = `defineTool({
          name: "hook", sideEffect: true,
          execute: () => fetch("/hooks?active=true", { method: "POST" }),
          revert: async (_args, ctx) => {
            const hook = await findHookByKey(ctx.idempotencyKey);
            if (hook) await fetch(\`/hooks/\${hook.id}?audit=true\`, {
              method: "DELETE",
            });
          },
        })`;
    expect(gradeSideEffectCompliance(source, { requireRevert: true }).passed).toBe(true);
  });

  test("requires SDK reversals with resource arguments to match", () => {
    const source = `defineTool({
          name: "object", sideEffect: true,
          execute: () => s3.putObject({ Bucket: "hooks", Key: "current" }),
          revert: async (_args, ctx) => {
            const object = await findObjectByKey(ctx.idempotencyKey);
            if (object) await s3.deleteObject({
              Bucket: "users",
              Key: "current",
            });
          },
        })`;
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test.each([
    `slack.chat.postMessage({ text: "again" })`,
    `stripe.charges.create({ amount: 100 })`,
    `db.insert({ id: 1 })`,
    `s3.putObject({ Bucket: "b", Key: "again" })`,
    `publisher.publish({ id: "again" })`,
  ])("does not treat effect creation as a reversal: %s", (falseUndo) => {
    const source = `defineTool({
          name: "slack", sideEffect: true,
          execute: (args) => slack.chat.postMessage(args),
          revert: async (_args, ctx) => {
            const message = await findMessageByKey(ctx.idempotencyKey);
            if (message) await ${falseUndo};
          },
        })`;
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test("rejects a delete from the wrong external resource class", () => {
    const source = `defineTool({
          name: "slack", sideEffect: true,
          execute: (args) => slack.chat.postMessage(args),
          revert: async (_args, ctx) => {
            const message = await findMessageByKey(ctx.idempotencyKey);
            if (message) await s3.deleteObject({ Bucket: "other", Key: message.ts });
          },
        })`;
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test("rejects an unconditional undo after a disconnected effectStatus check", () => {
    const source = `defineTool({
          name: "slack", sideEffect: true,
          execute: () => slack.chat.postMessage({ text: "x" }),
          revert: async (_args, ctx) => {
            if (ctx.effectStatus === "unknown") await inspect();
            await slack.chat.delete({ ts: ctx.output.ts });
          },
        })`;
    expect(kinds(source, { requireRevert: true })).toContain("missing-revert");
  });

  test("attributes a shared effect helper to every marked and unmarked caller", () => {
    const source = `
          async function publish() { return slack.chat.postMessage({ text: "x" }); }
          <Task id="marked" sideEffect computeFn={publish} />;
          <Task id="unmarked" computeFn={publish} />;
        `;
    expect(kinds(source)).toContain("unmarked-effect");
  });

  test("returns only the documented violation kinds and scores by failed rule", () => {
    const report = gradeSideEffectCompliance(
      `
          defineTool({
            name: "bad",
            revert: async () => {},
            execute: () => fetch("/x", { method: "POST" }),
          });
          defineTool({ name: "pure", sideEffect: true, execute: () => 1 });
        `,
      { requireIdempotencyKey: true, requireRevert: true },
    );
    expect(new Set(report.violations.map((violation) => violation.kind))).toEqual(
      new Set(["unmarked-effect", "over-marked-pure", "revert-without-side-effect"]),
    );
    expect(report.score).toBe(0.4);
  });
});
