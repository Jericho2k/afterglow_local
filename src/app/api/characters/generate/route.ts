import { requireAuth } from "@/lib/auth";
import { completion, parseJson } from "@/lib/deepseek";
import { characterGenerationPrompt } from "@/lib/prompts";
import { characterSchema, generateCharacterSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { getSettings } from "@/lib/db";

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const limited = checkRateLimit(`generate:${clientIp(request)}`, 15, 60 * 60_000); if (limited) return limited;
  const input = generateCharacterSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "Describe the character in a little more detail." }, { status: 400 });
  try {
    const settings = await getSettings();
    const raw = await completion([
      { role: "system", content: "You are an expert character designer. Return valid JSON only." },
      { role: "user", content: characterGenerationPrompt(input.data.idea, input.data.tone, input.data.nsfwEnabled) },
    ], { json: true, maxTokens: 2200, temperature: 0.9, model: settings.model });
    const generated = parseJson<Record<string, unknown>>(raw);
    const character = characterSchema.parse({ ...generated, avatarUrl: "", nsfwEnabled: input.data.nsfwEnabled });
    return Response.json({ character });
  } catch (error) {
    console.error("Character generation failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Generation failed" }, { status: 502 });
  }
}
