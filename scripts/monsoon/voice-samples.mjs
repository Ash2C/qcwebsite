// Writes one mp3 sample per ElevenLabs voice so a voice can be chosen for Ask.
// Usage: node scripts/monsoon/voice-samples.mjs <output-folder> <voiceId|name=voiceId> [...]
// Needs ELEVENLABS_API_KEY in the environment. ELEVENLABS_BASE_URL overrides the API host (testing).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LINE =
  "You have three things due today. The first is a call with Anna Lee at Northwind about the renewal. Two more are in your list.";

const [outDir, ...voices] = process.argv.slice(2);
if (!outDir || voices.length === 0) {
  console.error("Usage: node scripts/monsoon/voice-samples.mjs <output-folder> <voiceId|name=voiceId> [...]");
  process.exit(1);
}
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("ELEVENLABS_API_KEY is not set; set it in the environment and run again.");
  process.exit(1);
}
const base = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, "");

await mkdir(outDir, { recursive: true });
let failed = 0;
for (const arg of voices) {
  const eq = arg.indexOf("=");
  const name = eq > 0 ? arg.slice(0, eq) : arg;
  const voiceId = eq > 0 ? arg.slice(eq + 1) : arg;
  try {
    const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: LINE,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.8, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      console.error(`${voiceId}: failed with HTTP ${res.status}`);
      failed++;
      continue;
    }
    const file = join(outDir, `${name}.mp3`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    console.log(`${voiceId}: wrote ${file}`);
  } catch {
    console.error(`${voiceId}: request failed (network error)`);
    failed++;
  }
}
process.exitCode = failed ? 1 : 0;
