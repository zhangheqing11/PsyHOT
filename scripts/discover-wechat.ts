// Explicit paid candidate discovery; never subscribes accounts or downloads their histories.
// node --env-file=.env scripts/discover-wechat.ts --keyword 'AI 心理健康' --output /private/path/candidates.json
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { discoverWechatAccounts } from "@aihot/backend/providers/everyinfra";
import { closeDb } from "@aihot/backend/db";

const { values } = parseArgs({ options: { keyword: { type: "string" }, output: { type: "string" } } });
if (!values.keyword?.trim()) throw new Error("Use --keyword <topic>; this is a paid discovery call");
try {
  const call = await discoverWechatAccounts(values.keyword, new Date().toISOString().slice(0, 10));
  const report = { keyword: values.keyword, receiptId: call.receiptId, reused: call.reused,
    requiresReview: true, candidates: call.results };
  const json = JSON.stringify(report, null, 2);
  if (values.output) await writeFile(values.output, json + "\n", { mode: 0o600 });
  console.log(values.output ? JSON.stringify({ receiptId: call.receiptId, output: values.output, candidates: call.results.length }) : json);
} finally { await closeDb(); }
