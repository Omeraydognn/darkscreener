import { notFound } from "next/navigation";
import { TokenView } from "@/components/pages/TokenView";

export default async function Page({ params }: PageProps<"/token/[poolId]">) {
  const { poolId } = await params;
  const id = Number(poolId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return <TokenView poolId={id} />;
}
