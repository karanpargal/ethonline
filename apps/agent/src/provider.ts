import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

// Key-swappable brain: AI_PROVIDER picks the vendor, AI_MODEL overrides the model id.
export function getModel() {
  const provider = process.env.AI_PROVIDER ?? "anthropic";
  const override = process.env.AI_MODEL;
  if (provider === "openai") return openai(override ?? "gpt-5");
  return anthropic(override ?? "claude-sonnet-5");
}
