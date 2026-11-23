import "dotenv/config";

// Tests must never point at anything but a local database. A DATABASE_URL that has been edited
// to a shared host is the one mistake here that cannot be undone.
const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1|@postgres[:/]/.test(url)) {
  throw new Error(
    `Refusing to run tests against a non-local DATABASE_URL: ${url.replace(/:[^:@]*@/, ":***@")}`,
  );
}
