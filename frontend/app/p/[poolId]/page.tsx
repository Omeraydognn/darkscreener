import { notFound } from "next/navigation";
import { Terminal } from "@/components/Terminal";

export default async function PoolPage({ params }: PageProps<"/p/[poolId]">) {
  const { poolId } = await params;
  const id = Number(poolId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return <Terminal key={id} poolId={id} />;
}
