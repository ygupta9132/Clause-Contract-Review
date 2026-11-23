import ReviewClient from "./review-client";

export const dynamic = "force-dynamic";

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The page passes only the id. Every byte of contract data is fetched by the client from the
  // API, which re-checks ownership on each call, so there is one place that decides access.
  return <ReviewClient contractId={id} />;
}
