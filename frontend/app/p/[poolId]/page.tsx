import { redirect } from "next/navigation";

/** Eski adres: /p/<id> → /token/<id> */
export default async function Page({ params }: PageProps<"/p/[poolId]">) {
  const { poolId } = await params;
  redirect(`/token/${poolId}`);
}
