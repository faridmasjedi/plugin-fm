/**
 * What someone types to find metadata: words separated by commas or spaces, any of which may match. A word without *
 * matches anywhere in the name ("bill" → Billing, CaseBilling); with * it is a pattern of the whole name ("Case*",
 * "*Test", "Acc*Service"). Case does not matter. Nothing typed matches everything.
 */
export function nameMatcher(text: string): (name: string) => boolean {
  const words = text
    .split(/[,\s]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return () => true;
  const tests = words.map((w) => {
    if (!w.includes('*')) return (name: string) => name.includes(w);
    const re = new RegExp(
      `^${w
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`
    );
    return (name: string) => re.test(name);
  });
  return (name) => {
    const lower = name.toLowerCase();
    return tests.some((t) => t(lower));
  };
}
