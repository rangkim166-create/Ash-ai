import test from "node:test";
import assert from "node:assert/strict";
import { buildGroqModelFallback } from "./telegram-assistant.mjs";

test("Groq fallback uses online models only and never selects Qwen",()=>{
 const models=buildGroqModelFallback({});
 assert.deepEqual(models,["openai/gpt-oss-120b","openai/gpt-oss-20b"]);
 assert.ok(models.every(model=>!model.toLowerCase().includes("qwen")));
});

test("configured online Groq model stays first and duplicate fallbacks are removed",()=>{
 assert.deepEqual(buildGroqModelFallback({ASH_GROQ_MODEL:"openai/gpt-oss-20b"}),["openai/gpt-oss-20b"]);
 assert.deepEqual(buildGroqModelFallback({ASH_GROQ_MODEL:"meta-llama/llama-4-scout-17b-16e-instruct"}),["meta-llama/llama-4-scout-17b-16e-instruct","openai/gpt-oss-20b"]);
});
