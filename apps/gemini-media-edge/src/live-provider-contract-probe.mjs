import process from "node:process";
import { runGeminiLiveProviderContractProbe } from "./live-provider-contract.mjs";

const result = await runGeminiLiveProviderContractProbe({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_LIVE_MODEL,
});

const ok = result.status === "ready";
const output = Object.freeze({ ok, provider: "gemini-live", ...result });
if (ok) console.log(JSON.stringify(output));
else console.error(JSON.stringify(output));
if (!ok) process.exitCode = 1;
