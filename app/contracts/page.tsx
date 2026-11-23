import ContractsClient from "./contracts-client";

// The list is per-user and changes while a review runs, so it is never statically rendered.
export const dynamic = "force-dynamic";

export default function ContractsPage() {
  return <ContractsClient />;
}
