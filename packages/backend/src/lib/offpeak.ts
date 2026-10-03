// Bulk model work waits for the provider's off-peak price. DeepSeek charges half price off-peak; peak is
// Monday to Friday 9:00–12:00 and 14:00–18:00 Beijing time, except Chinese public holidays. Holidays
// are not built in (they change every year): list them in OFFPEAK_HOLIDAYS (2026-10-01,2026-10-02,…);
// an unlisted holiday only means waiting for the evening. Only bulk scripts use this (regroups,
// re-analysis, evaluations); live processing of new material never waits.

const PEAK_HOURS = new Set([9, 10, 11, 14, 15, 16, 17]);
const BEIJING_MS = 8 * 3600_000;

function holidays(): Set<string> {
  return new Set((process.env.OFFPEAK_HOLIDAYS ?? "").split(",").map((d) => d.trim()).filter(Boolean));
}

/** Whether `at` falls in the provider's peak-price window. */
export function isPeak(at: Date, offDays: Set<string> = holidays()): boolean {
  const bj = new Date(at.getTime() + BEIJING_MS);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6 || offDays.has(bj.toISOString().slice(0, 10))) return false;
  return PEAK_HOURS.has(bj.getUTCHours());
}

/** `at` itself when off-peak, otherwise the start of the next off-peak hour. */
export function nextOffPeak(at: Date, offDays: Set<string> = holidays()): Date {
  let t = new Date(at);
  while (isPeak(t, offDays)) t = new Date(Math.floor(t.getTime() / 3600_000) * 3600_000 + 3600_000);
  return t;
}

/**
 * Sleeps until off-peak unless the command line says `--now`. For scripts that start bulk model work.
 */
export async function waitForOffPeak(what: string, argv: string[] = process.argv): Promise<void> {
  if (argv.includes("--now")) return;
  const now = new Date();
  const start = nextOffPeak(now);
  if (start.getTime() === now.getTime()) return;
  const bj = new Date(start.getTime() + BEIJING_MS).toISOString().slice(0, 16).replace("T", " ");
  console.log(`${what}: model calls are at peak price now; waiting until ${bj} Beijing time (pass --now to start anyway).`);
  await new Promise((resolve) => setTimeout(resolve, start.getTime() - now.getTime()));
}
