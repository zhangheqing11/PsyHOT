// About-page contact codes: replaceable from the admin without code changes (file names carry a content
// hash), or shipped in the industry pack (industry/brand/contact/). The page shows a code only when set.
// The maker block can show the avatar of an X account the site follows as a source (ABOUT.maker).
import { ABOUT } from "@aihot/industry/site";
import { CONTACT } from "@aihot/industry/contact";
import { sql } from "../db.ts";
import { proxiedImage } from "../media/imgproxy.ts";

export interface ContactSettings {
  wechatQr: string | null;
  feishuQr: string | null;
}

const DEFAULTS: ContactSettings = { wechatQr: CONTACT.wechatQr, feishuQr: null };

export async function loadContact(): Promise<ContactSettings> {
  const [row] = await sql<{ value: Partial<ContactSettings> }[]>`SELECT value FROM settings WHERE key = 'contact_qr'`;
  return { ...DEFAULTS, ...(row?.value ?? {}) };
}

/** The maker's avatar at 400px through the image proxy, or null without a maker source or icon. */
export async function loadMakerAvatar(): Promise<string | null> {
  const sourceId = ABOUT.maker?.avatarSourceId;
  if (!sourceId) return null;
  const [row] = await sql<{ icon_url: string | null }[]>`SELECT icon_url FROM sources WHERE id = ${sourceId}`;
  const icon = row?.icon_url?.replace(/_(normal|bigger|mini)(\.\w+)$/, "_400x400$2") ?? null;
  return proxiedImage(icon, "thumb");
}
