// The source abstract of a journal or preprint item. Keep the language switch local to the
// abstract: the article body may be unavailable or may have its own, independent translation.
import { useState } from "react";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { PillTabs } from "../../components/ui/Tabs";

type Abstract = NonNullable<SiteItemDetail["abstract"]>;
type Language = "zh" | "original";

export function AbstractSection({ abstract, initialLanguage = "zh" }: { abstract: Abstract; initialLanguage?: Language }) {
  const both = !!abstract.translation && !!abstract.original;
  const [language, setLanguage] = useState<Language>(
    initialLanguage === "original" && abstract.original ? "original" : abstract.translation ? "zh" : "original",
  );
  const text = language === "zh" ? (abstract.translation ?? abstract.original) : (abstract.original ?? abstract.translation);
  if (!text) return null;

  const translated = language === "zh" && abstract.translationStatus === "translated" && !!abstract.translation;
  const sourceLabel = abstract.source === "stored_html" || abstract.source === "publisher_html"
    ? "期刊原文" : abstract.source === "source" ? "信源摘要" : abstract.source;
  const label = translated ? "摘要 · AI 翻译" : language === "original" && both ? "摘要 · 原文" : "摘要";

  return (
    <section className="mt-7 border-t border-line pt-4 xl:mt-8" aria-labelledby="abstract-label">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span id="abstract-label" className="text-[12px] text-ink-4">{label}</span>
        {both && (
          <PillTabs
            size="xs"
            layoutId="item-abstract-lang"
            label="摘要语言"
            active={language}
            onSelect={(key) => setLanguage(key === "original" ? "original" : "zh")}
            items={[
              { key: "zh", label: "中文" },
              { key: "original", label: "原文" },
            ]}
          />
        )}
      </div>
      <p className="text-[16px] leading-[1.8] text-ink-2">{text}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-4">
        {abstract.doi && <span>DOI：{abstract.doi}</span>}
        {sourceLabel && <span>摘要来源：{sourceLabel}</span>}
      </div>
      {translated && <p className="mt-3 text-[12px] leading-relaxed text-ink-4">中文由 AI 翻译，仅供参考，以原文为准。</p>}
      {!abstract.translation && abstract.original && <p className="mt-3 text-[12px] leading-relaxed text-ink-4">中文翻译还没有生成，先显示原文。</p>}
    </section>
  );
}
