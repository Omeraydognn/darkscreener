import type { Metadata } from "next";
import { Guide } from "@/components/pages/Guide";

export const metadata: Metadata = { title: "Nasıl çalışır? — darkscreener" };

export default function Page() {
  return <Guide />;
}
