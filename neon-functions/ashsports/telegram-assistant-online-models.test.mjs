import test from "node:test";
import assert from "node:assert/strict";
import { buildGroqModelFallback, buildOpenRouterModel } from "./telegram-assistant.mjs";

test("Groq never selects Qwen, including from environment overrides",()=>{
 assert.deepEqual(buildGroqModelFallback({ASH_GROQ_MODEL:"qwen/qwen3.8-27b"}),["openai/gpt-oss-120b","openai/gpt-oss-20b"]);
 assert.ok(buildGroqModelFallback({ASH_GROQ_MODEL:"qwen/qwen3.8-27b"}).every(x=>!/qwen/i.test(x)));
});
test("OpenRouter never selects Qwen from an environment override",()=>{
 assert.equal(buildOpenRouterModel({ASH_OPENROUTER_MODEL:"qwen/qwen3.8-27b"}),"openai/gpt-4o-mini");
});
