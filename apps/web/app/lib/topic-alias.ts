import { aliases as topicAliases } from "@aihot/industry/topics.json";

const aliases: Record<string, { to: string; tag?: string }> = topicAliases;

/** Legacy topics, including page/N, always land on the consolidated topic's first page. */
export function topicAliasRedirect(slug: string, _page: number, params: URLSearchParams): string | null {
  if (!Object.hasOwn(aliases, slug)) return null;
  const alias = aliases[slug];
  const query = new URLSearchParams();
  if (alias.tag) query.set("tag", alias.tag);
  for (const key of ["track", "region", "role"]) {
    const value = params.get(key);
    if (value !== null) query.set(key, value);
  }
  const suffix = query.toString();
  return `/topics/${alias.to}${suffix ? `?${suffix}` : ""}`;
}
