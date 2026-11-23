import { Suspense } from "react";
import { SignUp } from "@clerk/nextjs";

// Per-request, and inside Suspense: a prebuilt Clerk component on a catch-all route reads the
// request, so prerendering it would make the build depend on real Clerk credentials.
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <div className="flex justify-center py-6">
      <Suspense fallback={<p className="text-sm">Loading...</p>}>
        <SignUp />
      </Suspense>
    </div>
  );
}
