"use client";

import { createContext, Fragment, useContext, useEffect } from "react";
import { LANG_KEY, setCurrentLang, t, type Lang } from "@/lib/i18n";
import { useStoredString } from "../usePoll";

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: typeof t };
const LangCtx = createContext<Ctx>({ lang: "en", setLang: () => {}, t });

/** Language comes from localStorage (default English). Changing it remounts the tree so every
 *  string and formatter (including memoized ones) re-renders in the new language. */
export function LangProvider({ children }: { children: React.ReactNode }) {
  const [stored, setStored] = useStoredString(LANG_KEY);
  const lang: Lang = stored === "tr" ? "tr" : "en";
  setCurrentLang(lang); // before children render
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return (
    <LangCtx.Provider value={{ lang, setLang: setStored, t }}>
      <Fragment key={lang}>{children}</Fragment>
    </LangCtx.Provider>
  );
}

export const useLang = () => useContext(LangCtx);
