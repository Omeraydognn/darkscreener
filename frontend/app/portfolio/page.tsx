import type { Metadata } from "next";
import { Portfolio } from "@/components/pages/Portfolio";

export const metadata: Metadata = { title: "Portföy — darkscreener" };

export default function Page() {
  return <Portfolio />;
}
