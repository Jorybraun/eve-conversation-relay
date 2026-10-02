import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.PHONE_MODEL || "openai/gpt-5.6-luna-fast",
  defaultTools: false,
});
